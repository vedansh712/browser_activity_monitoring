import { ALARMS, FLUSH_INTERVAL_MINUTES, TRACKING_STATES, STORAGE_KEYS } from '../shared/constants.js';
import { todayKey, extractDomain } from '../shared/utils.js';
import { buildAggregate } from '../shared/data-models.js';
import * as storage from './storage-manager.js';
import * as tracker from './tracker.js';
import { initIdleDetection } from './idle-manager.js';
import { classifyPage } from './category-engine.js';
import { handleMessage, addUncategorized, tryAIClassification } from './message-router.js';

// YouTube fullscreen/theater state is stored in chrome.storage.session
// (module variables don't survive MV3 service worker restarts)
async function isYouTubeExpanded() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.YT_EXPANDED);
  return !!result[STORAGE_KEYS.YT_EXPANDED];
}

async function setYouTubeExpanded(value) {
  return chrome.storage.session.set({ [STORAGE_KEYS.YT_EXPANDED]: !!value });
}

// ─── Initialization ────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Track Daily] Extension installed/updated');
  await init();
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Track Daily] Browser started');
  await init();
});

async function init() {
  await storage.initStorage();

  // Set up periodic alarm
  chrome.alarms.create(ALARMS.FLUSH_SESSION, {
    periodInMinutes: FLUSH_INTERVAL_MINUTES,
  });

  // Set up idle detection
  const settings = await storage.getSettings();
  initIdleDetection(
    {
      onIdle: handleUserIdle,
      onActive: handleUserActive,
    },
    settings.idleThresholdSeconds
  );

  // Start tracking the currently active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      await startTrackingTab(tab);
    }
  } catch (err) {
    console.warn('[Track Daily] Could not get active tab on init:', err.message);
  }
}

// ─── Tab Events ────────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (!(await isTrackingEnabled())) return;

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    // ALWAYS reset the YouTube expanded flag on tab switch.
    // If the new active tab IS a YouTube video in theater/fullscreen,
    // its content script's 5-second poll (or the REREQUEST below) will
    // set the flag back to true. This prevents the flag getting stuck
    // when switching away from a theater-mode tab or between YouTube tabs.
    await setYouTubeExpanded(false);
    await startTrackingTab(tab);
  } catch (err) {
    console.warn('[Track Daily] Tab get error:', err.message);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!(await isTrackingEnabled())) return;
  if (changeInfo.status !== 'complete') return;

  // Only track if this is the active tab
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab && activeTab.id === tabId) {
      // Navigating on the active tab — reset theater flag.
      // If the new page is a YouTube watch/shorts page, its content
      // script will re-set the flag. If not, it stays cleared.
      const url = tab.url || '';
      const isWatchPage = url.includes('youtube.com/watch') ||
                          url.includes('youtube.com/shorts/');
      if (!isWatchPage) {
        await setYouTubeExpanded(false);
      }
      await startTrackingTab(tab);
    }
  } catch (err) {
    console.warn('[Track Daily] Tab update error:', err.message);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const current = await storage.getCurrentSession();
  if (current) {
    // We can't check the tab URL since it's already gone,
    // but end the session if no other tab is active
    await tracker.endCurrentSession();
  }
  // Reset expanded flag — if the closed tab was the theater one,
  // no content script is alive to send the "false" update
  await setYouTubeExpanded(false);
});

// ─── Window Events ─────────────────────────────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (!(await isTrackingEnabled())) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // All windows lost focus — but DON'T pause if a tab is playing audio
    // (e.g. YouTube fullscreen, video playing, etc.)
    const isMediaPlaying = await checkIfMediaPlaying();
    if (!isMediaPlaying) {
      await handleUserIdle('window_blur');
    }
  } else {
    // A window gained focus — track its active tab
    await handleUserActive();
    try {
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      if (tab && tab.url) {
        await startTrackingTab(tab);
      }
    } catch (err) {
      console.warn('[Track Daily] Window focus error:', err.message);
    }
  }
});

// ─── Alarm Events ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARMS.FLUSH_SESSION) {
    await tracker.flushCurrentSession();
    await rebuildTodayAggregate();

    // Prune old data periodically
    const settings = await storage.getSettings();
    await storage.pruneOldData(settings.retentionDays);
  }
});

// ─── Message Handling ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle YouTube expand-state messages directly (both fullscreen and theater)
  if (message.type === 'YOUTUBE_FULLSCREEN') {
    setYouTubeExpanded(!!message.data.isFullscreen)
      .then(() => {
        console.log('[Track Daily] YouTube fullscreen:', !!message.data.isFullscreen);
        sendResponse({ ok: true });
      })
      .catch((err) => {
        console.warn('[Track Daily] Failed to set YT expanded:', err?.message);
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }
  if (message.type === 'YOUTUBE_THEATER') {
    setYouTubeExpanded(!!message.data.isExpanded)
      .then(() => {
        console.log('[Track Daily] YouTube expanded (theater/fullscreen):', !!message.data.isExpanded,
          '| theater:', !!message.data.isTheater,
          '| fullscreen:', !!message.data.isFullscreen);
        sendResponse({ ok: true });
      })
      .catch((err) => {
        console.warn('[Track Daily] Failed to set YT expanded:', err?.message);
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }

  // Everything else goes through the message router
  return handleMessage(message, sender, sendResponse);
});

// ─── Core Logic ────────────────────────────────────────────────────

async function startTrackingTab(tab) {
  const domain = extractDomain(tab.url);
  if (!domain) {
    await tracker.endCurrentSession();
    return;
  }

  // Check if excluded
  const settings = await storage.getSettings();
  if (settings.excludedDomains.includes(domain)) {
    await tracker.endCurrentSession();
    return;
  }

  // Check if we're already tracking this URL
  const current = await storage.getCurrentSession();
  if (current && current.url === tab.url && current.isActive) {
    return; // Already tracking
  }

  // Classify the page
  const result = await classifyPage({
    domain,
    url: tab.url,
    title: tab.title || '',
  });

  // Start new session
  await tracker.startNewSession(tab, result.categoryId);

  // For YouTube tabs, ask the content script to (re-)send video metadata.
  // Needed after: clearing history, service worker restart, or new session
  // on the same video where content script has already deduped its send.
  if (domain.includes('youtube.com') && tab.id) {
    // Small delay so the new session is fully registered before content script responds
    setTimeout(() => {
      chrome.tabs.sendMessage(tab.id, { type: 'REREQUEST_YT_META' }).catch(() => {
        // Content script may not be loaded yet (e.g. on homepage); ignore
      });
    }, 500);
  }

  // If uncategorized, try AI then queue for user
  if (result.categoryId === 'uncategorized') {
    const aiResult = await tryAIClassification({
      domain,
      title: tab.title || '',
    });

    if (!aiResult) {
      addUncategorized(domain, tab.title || '');
    }
  }
}

async function handleUserIdle(reason) {
  const state = await storage.getTrackingState();
  if (state === TRACKING_STATES.IDLE || state === TRACKING_STATES.DISABLED) return;

  // Don't pause if media is playing (YouTube fullscreen, video, music etc.)
  const isMediaPlaying = await checkIfMediaPlaying();
  if (isMediaPlaying) {
    console.log('[Track Daily] Idle detected but media is playing — continuing tracking');
    return;
  }

  await tracker.pauseCurrentSession();
  await storage.setTrackingState(TRACKING_STATES.IDLE);
}

/**
 * Check if media is actively playing (YouTube fullscreen/theater, audio playing, etc.)
 * This prevents pausing tracking during fullscreen video playback.
 */
async function checkIfMediaPlaying() {
  // Check YouTube expanded state (theater or fullscreen) from session storage
  if (await isYouTubeExpanded()) {
    console.log('[Track Daily] Media check: YouTube is expanded (theater/fullscreen)');
    return true;
  }

  // Check if any tab is playing audio
  try {
    const audibleTabs = await chrome.tabs.query({ audible: true });
    if (audibleTabs.length > 0) {
      console.log('[Track Daily] Media check: audible tabs =', audibleTabs.map(t => t.url?.substring(0, 40)));
      return true;
    }
  } catch {}

  return false;
}

async function handleUserActive() {
  const state = await storage.getTrackingState();
  if (state === TRACKING_STATES.DISABLED) return;

  if (state === TRACKING_STATES.IDLE) {
    await tracker.resumeCurrentSession();
    await storage.setTrackingState(TRACKING_STATES.ACTIVE);
  }
}

async function rebuildTodayAggregate() {
  const today = todayKey();
  const sessions = await storage.getSessionsByDate(today);
  const aggregate = buildAggregate(today, sessions);
  await storage.saveAggregate(aggregate);
}

async function isTrackingEnabled() {
  const settings = await storage.getSettings();
  return settings.trackingEnabled;
}
