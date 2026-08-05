import {
  ALARMS,
  FLUSH_INTERVAL_MINUTES,
  TICK_INTERVAL_MINUTES,
  MEDIA_SIGNAL_TTL_MS,
  TRACKING_STATES,
  STORAGE_KEYS,
} from '../shared/constants.js';
import { extractDomain, todayKey } from '../shared/utils.js';
import { sessionElapsed } from '../shared/data-models.js';
import { createLogger, setLogLevel } from '../shared/logger.js';
import * as storage from './storage-manager.js';
import * as tracker from './tracker.js';
import { aggregateService } from './container.js';
import { registerIdleListener, applyIdleThreshold } from './idle-manager.js';
import { refreshActionIcon } from './icon-manager.js';
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

/*
 * Media signals
 * ─────────────
 * These suppress idle pausing, so a signal that gets stuck "on" disables idle
 * detection for the rest of the browser session and a page left open all day
 * accrues continuously. Every signal therefore carries a timestamp and expires
 * unless the page re-asserts it. The failure mode becomes a few seconds of
 * over-tracking instead of hours, and it self-heals with no cleanup path that
 * can itself be missed.
 *
 * Stored in chrome.storage.session because module variables do not survive an
 * MV3 worker teardown.
 */

async function writeSignal(key, value) {
  return chrome.storage.session.set({ [key]: { value: !!value, at: Date.now() } });
}

async function readSignal(key) {
  const stored = await chrome.storage.session.get(key);
  const signal = stored[key];
  if (!signal || typeof signal !== 'object') return false;
  if (!signal.value) return false;
  return Date.now() - signal.at < MEDIA_SIGNAL_TTL_MS;
}

const isYouTubeExpanded = () => readSignal(STORAGE_KEYS.YT_EXPANDED);
const setYouTubeExpanded = (value) => writeSignal(STORAGE_KEYS.YT_EXPANDED, value);

const isPageMediaPlaying = () => readSignal(STORAGE_KEYS.MEDIA_PLAYING);
export const setPageMediaPlaying = (value) => writeSignal(STORAGE_KEYS.MEDIA_PLAYING, value);

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
  // Repaint immediately so a colour change is visible without waiting a tick.
  updateActionIcon();
});

async function init() {
  await storage.initStorage();

  // Periodic flush to IndexedDB, and the heartbeat that accrues time.
  chrome.alarms.create(ALARMS.FLUSH_SESSION, {
    periodInMinutes: FLUSH_INTERVAL_MINUTES,
  });
  chrome.alarms.create(ALARMS.TICK, {
    periodInMinutes: TICK_INTERVAL_MINUTES,
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
  // Heartbeat. Credits the last minute if the machine was awake for it, and
  // discards the gap entirely if it was not.
  if (alarm.name === ALARMS.TICK) {
    try {
      const result = await tracker.tickSession();
      if (result?.discarded > 0) {
        log.info(
          `Discarded ${Math.round(result.discarded / 60000)} minutes of untracked gap ` +
          '(device asleep or suspended)'
        );
      }
    } catch (err) {
      log.error('Heartbeat failed:', err);
    }

    await updateActionIcon();
    return;
  }

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
  // Media playback state from the generic content script. Only the tracked tab
  // may assert it — otherwise a video in a background tab would keep idle
  // detection suppressed for a page the user is not looking at.
  if (message.type === 'MEDIA_STATE') {
    storage.getCurrentSession()
      .then((current) => {
        if (!current || current.tabId !== sender?.tab?.id) return { ok: false, ignored: true };
        return setPageMediaPlaying(!!message.data.playing).then(() => ({ ok: true }));
      })
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: err?.message }));
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
 * Whether the tracked tab is playing media, and so counts as watched rather
 * than abandoned.
 *
 * Scoped to the tracked tab on purpose: a global "is any tab audible" check
 * means background music suppresses idle detection entirely, so a locked
 * machine with Spotify open would log hours of phantom browsing.
 *
 * Three signals, because none is sufficient alone:
 *  - a reported playing <video>/<audio>, which catches muted playback that
 *    tab.audible misses — someone watching a subtitled video with the sound
 *    off is still watching;
 *  - YouTube theater or fullscreen, which is deliberate viewing intent;
 *  - tab.audible, as a backstop for players the content script cannot see,
 *    such as media inside a cross-origin frame.
 *
 * The first two expire unless re-asserted, so neither can wedge idle
 * detection off permanently.
 */
async function checkIfMediaPlaying() {
  if (await isYouTubeExpanded()) return true;
  if (await isPageMediaPlaying()) return true;

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

/**
 * Repaint the toolbar icon from today's total.
 *
 * Called from the heartbeat and whenever settings change, so the icon reflects
 * both accumulating time and a change of accent without waiting a full minute.
 */
async function updateActionIcon() {
  try {
    const [settings, aggregate, current] = await Promise.all([
      storage.getSettings(),
      aggregateService.getForDate(todayKey()),
      storage.getCurrentSession(),
    ]);

    let totalMs = aggregate?.totalTime ?? 0;
    if (current?.isActive) totalMs += sessionElapsed(current);

    await refreshActionIcon({
      totalMs,
      settings,
      paused: !settings.trackingEnabled,
    });
  } catch (err) {
    log.warn('Could not refresh toolbar icon:', err?.message ?? err);
  }
}

async function isTrackingEnabled() {
  const settings = await storage.getSettings();
  return settings.trackingEnabled;
}
