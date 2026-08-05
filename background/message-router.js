import { MSG, STORAGE_KEYS, MAX_PLAUSIBLE_SESSION_MS } from '../shared/constants.js';
import { todayKey } from '../shared/utils.js';
import { createLogger } from '../shared/logger.js';
import * as storage from './storage-manager.js';
import * as tracker from './tracker.js';
import { createCategoryRegistry } from '../shared/category-registry.js';
import { aggregateService, aiClassifier } from './container.js';
import { classifyYouTube, learnFromUserCategorization } from './category-engine.js';

const log = createLogger('messages');

/**
 * Handle incoming messages from content scripts, popup, and dashboard.
 */
export function handleMessage(message, sender, sendResponse) {
  // Route to the appropriate handler
  const handler = messageHandlers[message.type];
  if (handler) {
    handler(message, sender)
      .then((response) => sendResponse(response))
      .catch((err) => {
        log.error(`Handler error (${message.type}):`, err);
        sendResponse({ error: err.message });
      });
    return true; // Keep the message channel open for async response
  }

  log.warn(`Unknown message type: ${message.type}`);
  sendResponse({ error: 'Unknown message type' });
  return false;
}

/**
 * True when a content-script message came from the tab we are currently
 * tracking. Content scripts run in every tab, so unscoped handlers let a
 * background tab mutate the foreground tab's session.
 */
async function isFromTrackedTab(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null) return false;
  const current = await storage.getCurrentSession();
  return !!current && current.tabId === tabId;
}

const messageHandlers = {
  // ─── Content Script Messages ───────────────────────────────────

  [MSG.PAGE_INFO]: async (message, sender) => {
    const { title, metaDescription } = message.data;
    if (!(await isFromTrackedTab(sender))) return { ok: false, ignored: true };

    const current = await storage.getCurrentSession();
    if (!current || current.url !== sender.tab.url) return { ok: false, ignored: true };

    // Fill in details that weren't available when the session started. The tab
    // title is often empty at session start, and metaDescription is only ever
    // available from the content script.
    const patch = {};
    if (!current.title && title) patch.title = title;
    if (metaDescription && !current.meta?.metaDescription) {
      patch.meta = { ...(current.meta || {}), metaDescription };
    }

    if (Object.keys(patch).length > 0) {
      await storage.setCurrentSession({ ...current, ...patch });
    }
    return { ok: true };
  },

  [MSG.YOUTUBE_META]: async (message, sender) => {
    const youtubeMeta = message.data;
    if (!(await isFromTrackedTab(sender))) return { ok: false, ignored: true };

    const settings = await storage.getSettings();
    if (!settings.youtubeDeepTracking) return { ok: false, disabled: true };

    // Attach the video metadata to the session
    await tracker.updateSessionMeta(youtubeMeta);

    // Classify via the shared engine — no duplicate keyword logic here
    const categories = await storage.getCategories();
    const result = classifyYouTube(youtubeMeta, categories);
    await tracker.updateSessionCategory(result.categoryId);

    return { ok: true, categoryId: result.categoryId, method: result.method };
  },

  [MSG.VISIBILITY_CHANGE]: async (message, sender) => {
    // Scoped to the tracked tab: without this, any background tab going
    // hidden/visible pauses or restarts the clock on the tab the user is
    // actually looking at.
    if (!(await isFromTrackedTab(sender))) return { ok: false, ignored: true };

    const { hidden } = message.data;
    if (hidden) {
      await tracker.pauseCurrentSession();
    } else {
      await tracker.resumeCurrentSession();
    }
    return { ok: true };
  },

  // ─── Popup / Dashboard Messages ────────────────────────────────

  [MSG.GET_CURRENT_SESSION]: async () => {
    return await storage.getCurrentSession();
  },

  [MSG.GET_TODAY_STATS]: async () => {
    const [aggregate, currentSession] = await Promise.all([
      aggregateService.getForDate(todayKey()),
      storage.getCurrentSession(),
    ]);
    return { aggregate, currentSession };
  },

  [MSG.GET_SESSIONS]: async (message) => {
    const { startDate, endDate } = message.data;
    return await storage.getSessionsForDateRange(startDate, endDate);
  },

  [MSG.GET_AGGREGATES]: async (message) => {
    const { startDate, endDate } = message.data;
    return await aggregateService.getForRange(startDate, endDate);
  },

  [MSG.TOGGLE_TRACKING]: async (message) => {
    const settings = await storage.getSettings();
    settings.trackingEnabled = message.data.enabled;
    await storage.saveSettings(settings);

    if (!settings.trackingEnabled) {
      await tracker.endCurrentSession();
      await storage.setTrackingState('disabled');
    } else {
      await storage.setTrackingState('active');
    }
    return { ok: true, enabled: settings.trackingEnabled };
  },

  [MSG.CATEGORIZE_DOMAIN]: async (message) => {
    const { domain, categoryId, title } = message.data;

    // Steer future classification
    await storage.addDomainOverride(domain, categoryId);

    // Learn for similarity matching, so comparable sites are classified the
    // same way without being told individually
    await learnFromUserCategorization(domain, title || '', categoryId);

    // Apply to history. Without this the override only affects sessions not yet
    // recorded, and the dashboard — built from the categoryId stored on each
    // session — would show no change at all.
    const updated = await storage.recategorizeDomain(domain, categoryId);

    // Update the live session if it matches
    const current = await storage.getCurrentSession();
    if (current && current.domain === domain) {
      await tracker.updateSessionCategory(categoryId);
    }

    await removeUncategorized(domain);

    return { ok: true, sessionsUpdated: updated };
  },

  [MSG.GET_UNCATEGORIZED]: async () => {
    const queue = await readUncategorized();
    return Object.entries(queue).map(([domain, data]) => ({ domain, ...data }));
  },

  [MSG.CLEAR_HISTORY]: async () => {
    await storage.clearBrowsingHistory();
    await writeUncategorized({});
    await requestYouTubeTabsToReextract();
    return { ok: true };
  },

  [MSG.REPAIR_SESSIONS]: async () => {
    const stats = await storage.repairImplausibleSessions(MAX_PLAUSIBLE_SESSION_MS);
    return { ok: true, ...stats };
  },

  [MSG.RESET_EVERYTHING]: async () => {
    await storage.resetEverything();
    await writeUncategorized({});
    await requestYouTubeTabsToReextract();
    return { ok: true };
  },
};

/**
 * Ask all open YouTube tabs to re-extract their video metadata.
 * Needed after clearing history so the current video's session gets meta attached.
 */
async function requestYouTubeTabsToReextract() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'REREQUEST_YT_META' }).catch(() => {});
    }
  } catch (err) {
    log.warn('Failed to broadcast re-extract:', err.message);
  }
}

// ─── Uncategorized Domain Queue ────────────────────────────────────
//
// Backed by chrome.storage.session rather than a module-level Map: the MV3
// worker is torn down after ~30s idle, which silently emptied the queue and
// reset the badge every time.

const MAX_UNCATEGORIZED = 50;

async function readUncategorized() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.UNCATEGORIZED);
  return result[STORAGE_KEYS.UNCATEGORIZED] || {};
}

async function writeUncategorized(queue) {
  await chrome.storage.session.set({ [STORAGE_KEYS.UNCATEGORIZED]: queue });
  await updateBadge(queue);
}

export async function addUncategorized(domain, title) {
  const queue = await readUncategorized();
  if (queue[domain]) return;

  // Bound the queue so a long browsing session can't grow it without limit
  const entries = Object.entries(queue);
  if (entries.length >= MAX_UNCATEGORIZED) {
    entries.sort(([, a], [, b]) => a.addedAt - b.addedAt);
    delete queue[entries[0][0]];
  }

  queue[domain] = { title, addedAt: Date.now() };
  await writeUncategorized(queue);
}

async function removeUncategorized(domain) {
  const queue = await readUncategorized();
  if (!queue[domain]) return;
  delete queue[domain];
  await writeUncategorized(queue);
}

async function updateBadge(queue) {
  const count = Object.keys(queue).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (count > 0) {
    await chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
  }
}

/**
 * Attempt on-device classification for a domain. Called by the service worker.
 *
 * Gated on the user's explicit opt-in. Classification runs locally and sends
 * nothing off the device, but it is still inference over browsing data, so it
 * stays off until switched on.
 *
 * @returns {Promise<string|null>} the categoryId, or null when undetermined
 */
export async function tryAIClassification({ domain, title, metaDescription }) {
  const settings = await storage.getSettings();
  if (!settings.aiEnabled) return null;

  const stored = await storage.getCategories();
  const registry = createCategoryRegistry(stored);

  const categoryId = await aiClassifier.classify({
    domain,
    title,
    metaDescription,
    categories: registry.assignable().map(({ id, name }) => ({ id, name })),
  });
  if (!categoryId) return null;

  // Auto-apply the classification
  await storage.addDomainOverride(domain, categoryId);
  await learnFromUserCategorization(domain, title, categoryId);

  // Update current session if applicable
  const current = await storage.getCurrentSession();
  if (current && current.domain === domain) {
    await tracker.updateSessionCategory(categoryId);
  }

  log.info(`Classified ${domain} as ${categoryId} on-device`);
  return categoryId;
}
