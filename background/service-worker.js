import {
  ALARMS,
  FLUSH_INTERVAL_MINUTES,
  TRACKING_STATES,
  STORAGE_KEYS,
} from '../shared/constants.js';
import { extractDomain } from '../shared/utils.js';
import { createLogger, setLogLevel } from '../shared/logger.js';
import * as storage from './storage-manager.js';
import * as tracker from './tracker.js';
import { aggregateService } from './container.js';
import { registerIdleListener, applyIdleThreshold } from './idle-manager.js';
import { classifyPage } from './category-engine.js';
import { handleMessage, addUncategorized, tryAIClassification } from './message-router.js';

const log = createLogger('worker');

/*
 * MV3 lifecycle note
 * ──────────────────
 * This service worker is torn down after ~30s of inactivity and re-evaluated
 * from scratch on the next event. Anything registered inside an async
 * callback (like the old init()) is therefore registered exactly once, on
 * install, and is gone forever after the first teardown.
 *
 * So: every chrome.* listener in this file is registered at module top level,
 * synchronously, on every evaluation. init() is reserved for one-time state
 * seeding, and anything that must survive a teardown lives in chrome.storage
 * rather than a module variable.
 */

// YouTube fullscreen/theater state is stored in chrome.storage.session
// (module variables don't survive MV3 service worker restarts)
async function isYouTubeExpanded() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.YT_EXPANDED);
  return !!result[STORAGE_KEYS.YT_EXPANDED];
}

async function setYouTubeExpanded(value) {
  return chrome.storage.session.set({ [STORAGE_KEYS.YT_EXPANDED]: !!value });
}

// ─── Listener Registration (top level — see lifecycle note) ─────────

registerIdleListener({
  onIdle: handleUserIdle,
  onActive: handleUserActive,
});

chrome.runtime.onInstalled.addListener(async () => {
  log.info('Extension installed/updated');
  await init();
});

chrome.runtime.onStartup.addListener(async () => {
  log.info('Browser started');
  await init();
});

// The detection interval is a browser-global setting that does not reliably
// survive a worker teardown, so re-apply it on every evaluation.
applyIdleThresholdFromSettings();

async function applyIdleThresholdFromSettings() {
  try {
    const settings = await storage.getSettings();
    applyIdleThreshold(settings.idleThresholdSeconds);
    setLogLevel(settings.logLevel);
  } catch (err) {
    log.warn('Could not apply settings:', err?.message);
  }
}

// Re-apply runtime settings when the user changes them in options, instead of
// waiting for the next browser restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return;
  const next = changes[STORAGE_KEYS.SETTINGS].newValue;
  if (!next) return;
  if (typeof next.idleThresholdSeconds === 'number') {
    applyIdleThreshold(next.idleThresholdSeconds);
  }
  if (typeof next.logLevel === 'string') {
    setLogLevel(next.logLevel);
  }
});

async function init() {
  await storage.initStorage();

  // Set up periodic alarm
  chrome.alarms.create(ALARMS.FLUSH_SESSION, {
    periodInMinutes: FLUSH_INTERVAL_MINUTES,
  });

  await applyIdleThresholdFromSettings();

  // Start tracking the currently active tab
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      await startTrackingTab(tab);
    }
  } catch (err) {
    log.warn('Could not get active tab on init:', err.message);
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
    log.warn('Tab get error:', err.message);
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
    log.warn('Tab update error:', err.message);
  }
});

// Single-page-app navigation (pushState/replaceState) never fires onUpdated with
// status 'complete'. Without this, moving between YouTube videos, Gmail threads
// or Twitter pages keeps one stale session open — and YouTube metadata for the
// new video gets attached to the previous video's session record.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return; // main frame only
  if (!(await isTrackingEnabled())) return;

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || activeTab.id !== details.tabId) return;

    const current = await storage.getCurrentSession();
    if (current && current.url === details.url) return; // same page, nothing to do

    const tab = await chrome.tabs.get(details.tabId);
    await startTrackingTab(tab);
  } catch (err) {
    log.warn('SPA navigation error:', err.message);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // Only end the session if the tab that closed is the one being tracked.
  // Closing an unrelated background tab must not stop tracking the tab the
  // user is actually looking at.
  const current = await storage.getCurrentSession();
  if (current && current.tabId === tabId) {
    await tracker.endCurrentSession();
    // The tracked tab is gone, so no content script is alive to clear this.
    await setYouTubeExpanded(false);
  }
});

// ─── Window Events ─────────────────────────────────────────────────

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (!(await isTrackingEnabled())) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // All windows lost focus — but DON'T pause if the tracked tab is playing
    // media (e.g. a YouTube video the user is still watching).
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
      log.warn('Window focus error:', err.message);
    }
  }
});

// ─── Alarm Events ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARMS.FLUSH_SESSION) return;

  // Each step is independent; one failing must not skip the others.
  try {
    await tracker.flushCurrentSession();
  } catch (err) {
    log.error('Session flush failed:', err);
  }

  try {
    await aggregateService.refreshRecent();
  } catch (err) {
    log.error('Aggregate refresh failed:', err);
  }

  try {
    const settings = await storage.getSettings();
    await storage.pruneOldData(settings.retentionDays);
  } catch (err) {
    log.error('Data prune failed:', err);
  }
});

// ─── Message Handling ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle YouTube expand-state messages directly (both fullscreen and theater)
  if (message.type === 'YOUTUBE_FULLSCREEN') {
    setYouTubeExpanded(!!message.data.isFullscreen)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        log.warn('Failed to set YT expanded:', err?.message);
        sendResponse({ ok: false, error: err?.message });
      });
    return true;
  }
  if (message.type === 'YOUTUBE_THEATER') {
    setYouTubeExpanded(!!message.data.isExpanded)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        log.warn('Failed to set YT expanded:', err?.message);
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

  // Already on this exact page in this exact tab — resume rather than restart,
  // so returning to a tab doesn't discard the session it already had.
  const current = await storage.getCurrentSession();
  if (current && current.url === tab.url && current.tabId === tab.id) {
    if (!current.isActive) await tracker.resumeCurrentSession();
    return;
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

  // If uncategorized, try AI then queue for user.
  // Deliberately not awaited: AI classification can involve a network round
  // trip, and blocking session start on it would delay every unknown page.
  if (result.categoryId === 'uncategorized') {
    tryAIClassification({ domain, title: tab.title || '' })
      .then((aiResult) => {
        if (!aiResult) return addUncategorized(domain, tab.title || '');
      })
      .catch((err) => {
        log.warn('AI classification failed:', err?.message);
        return addUncategorized(domain, tab.title || '');
      });
  }
}

async function handleUserIdle(reason) {
  const state = await storage.getTrackingState();
  if (state === TRACKING_STATES.IDLE || state === TRACKING_STATES.DISABLED) return;

  // A locked screen means the user is definitively away — no media exemption.
  if (reason !== 'locked') {
    const isMediaPlaying = await checkIfMediaPlaying();
    if (isMediaPlaying) {
      log.info('Idle detected but tracked tab is playing media — continuing');
      return;
    }
  }

  await tracker.pauseCurrentSession();
  await storage.setTrackingState(TRACKING_STATES.IDLE);
}

/**
 * Check whether the *tracked* tab is playing media.
 *
 * Scoped to the tracked tab on purpose: a global "is any tab audible" check
 * means background music suppresses idle detection entirely, so a locked
 * machine with Spotify open would log hours of phantom browsing.
 */
async function checkIfMediaPlaying() {
  // YouTube theater/fullscreen implies the user is actively watching
  if (await isYouTubeExpanded()) return true;

  try {
    const current = await storage.getCurrentSession();
    if (!current || current.tabId == null) return false;

    const tab = await chrome.tabs.get(current.tabId);
    return !!tab?.audible;
  } catch {
    // Tab is gone
    return false;
  }
}

async function handleUserActive() {
  const state = await storage.getTrackingState();
  if (state === TRACKING_STATES.DISABLED) return;

  if (state === TRACKING_STATES.IDLE) {
    await tracker.resumeCurrentSession();
    await storage.setTrackingState(TRACKING_STATES.ACTIVE);
  }
}

async function isTrackingEnabled() {
  const settings = await storage.getSettings();
  return settings.trackingEnabled;
}
