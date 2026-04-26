import { MSG } from '../shared/constants.js';
import { todayKey } from '../shared/utils.js';
import { buildAggregate } from '../shared/data-models.js';
import * as storage from './storage-manager.js';
import * as tracker from './tracker.js';
import { classifyPage, learnFromUserCategorization } from './category-engine.js';
import { aiClassify } from './ai-classifier.js';

// Pending uncategorized domains
const uncategorizedDomains = new Map();

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
        console.error(`[Track Daily] Message handler error (${message.type}):`, err);
        sendResponse({ error: err.message });
      });
    return true; // Keep the message channel open for async response
  }

  console.warn(`[Track Daily] Unknown message type: ${message.type}`);
  sendResponse({ error: 'Unknown message type' });
  return false;
}

const messageHandlers = {
  // ─── Content Script Messages ───────────────────────────────────

  [MSG.PAGE_INFO]: async (message, sender) => {
    // Generic content script reports page info
    const { title, metaDescription } = message.data;
    const tab = sender.tab;
    if (!tab) return;

    const current = await storage.getCurrentSession();
    if (current && current.url === tab.url) {
      // Update title/meta if it wasn't available at session start
      if (!current.title && title) {
        await tracker.updateSessionMeta({ ...current.meta, pageTitle: title });
      }
    }
    return { ok: true };
  },

  [MSG.YOUTUBE_META]: async (message, sender) => {
    const youtubeMeta = message.data;
    const tab = sender.tab;
    if (!tab) return;

    console.log('[Track Daily] Received YouTube metadata:', JSON.stringify({
      videoId: youtubeMeta.videoId,
      title: (youtubeMeta.videoTitle || '').substring(0, 40),
      channel: youtubeMeta.channelName,
      category: youtubeMeta.videoCategory,
      duration: youtubeMeta.videoDuration,
    }));

    // Update current session with YouTube metadata
    await tracker.updateSessionMeta(youtubeMeta);

    // Directly classify using YouTube metadata (skip domain rules — we already know it's YouTube)
    const current = await storage.getCurrentSession();
    if (current) {
      const categories = await storage.getCategories();

      // 1. Check channel override first
      if (youtubeMeta.channelName && categories.channelOverrides?.[youtubeMeta.channelName]) {
        await tracker.updateSessionCategory(categories.channelOverrides[youtubeMeta.channelName]);
        console.log('[Track Daily] YT classified by channel override:', categories.channelOverrides[youtubeMeta.channelName]);
        return { ok: true };
      }

      // 2. Map YouTube's video category to our categories
      if (youtubeMeta.videoCategory) {
        const { YOUTUBE_CATEGORY_MAP } = await import('../shared/constants.js');
        const mapped = YOUTUBE_CATEGORY_MAP[youtubeMeta.videoCategory];
        if (mapped) {
          await tracker.updateSessionCategory(mapped);
          console.log('[Track Daily] YT classified by video category:', youtubeMeta.videoCategory, '→', mapped);
          return { ok: true };
        }
      }

      // 3. If no category extracted, try keyword heuristics on the video title
      if (youtubeMeta.videoTitle) {
        const titleLower = youtubeMeta.videoTitle.toLowerCase();
        const titleHints = {
          'education': ['tutorial', 'course', 'learn', 'explained', 'how to', 'lecture', 'programming', 'python', 'javascript', 'coding', 'lesson'],
          'news': ['news', 'politics', 'election', 'breaking', 'debate', 'report'],
          'development': ['code', 'developer', 'programming', 'software', 'api', 'framework', 'react', 'node', 'web dev'],
        };

        for (const [catId, keywords] of Object.entries(titleHints)) {
          const matchCount = keywords.filter(k => titleLower.includes(k)).length;
          if (matchCount >= 1) {
            await tracker.updateSessionCategory(catId);
            console.log('[Track Daily] YT classified by title keywords:', catId, '(matches:', matchCount, ')');
            return { ok: true };
          }
        }
      }

      // 4. Default: explicitly set to entertainment (it IS YouTube after all)
      //    Explicit update, not silent fall-through — makes debug logs clear.
      await tracker.updateSessionCategory('entertainment');
      console.log('[Track Daily] YT no specific category found → explicitly set to entertainment');
    }

    return { ok: true };
  },

  [MSG.VISIBILITY_CHANGE]: async (message) => {
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
    const today = todayKey();
    let aggregate = await storage.getAggregate(today);

    if (!aggregate) {
      // Build it on the fly
      const sessions = await storage.getSessionsByDate(today);
      aggregate = buildAggregate(today, sessions);
    }

    const currentSession = await storage.getCurrentSession();
    return { aggregate, currentSession };
  },

  [MSG.GET_SESSIONS]: async (message) => {
    const { startDate, endDate } = message.data;
    return await storage.getSessionsForDateRange(startDate, endDate);
  },

  [MSG.GET_AGGREGATES]: async (message) => {
    const { startDate, endDate } = message.data;
    return await storage.getAggregatesForRange(startDate, endDate);
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

    // Save as domain override
    await storage.addDomainOverride(domain, categoryId);

    // Learn for similarity matching
    await learnFromUserCategorization(domain, title || '', categoryId);

    // Update current session if it matches
    const current = await storage.getCurrentSession();
    if (current && current.domain === domain) {
      await tracker.updateSessionCategory(categoryId);
    }

    // Remove from uncategorized queue
    uncategorizedDomains.delete(domain);
    updateBadge();

    return { ok: true };
  },

  [MSG.GET_UNCATEGORIZED]: async () => {
    return Array.from(uncategorizedDomains.entries()).map(([domain, data]) => ({
      domain,
      ...data,
    }));
  },

  [MSG.CLEAR_HISTORY]: async () => {
    await storage.clearBrowsingHistory();
    uncategorizedDomains.clear();
    updateBadge();
    await requestYouTubeTabsToReextract();
    return { ok: true };
  },

  [MSG.RESET_EVERYTHING]: async () => {
    await storage.resetEverything();
    uncategorizedDomains.clear();
    updateBadge();
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
    if (tabs.length > 0) {
      console.log('[Track Daily] Requested YT metadata re-extraction from', tabs.length, 'tab(s)');
    }
  } catch (err) {
    console.warn('[Track Daily] Failed to broadcast re-extract:', err.message);
  }
}

// ─── Uncategorized Domain Tracking ─────────────────────────────────

export function addUncategorized(domain, title) {
  if (!uncategorizedDomains.has(domain)) {
    uncategorizedDomains.set(domain, { title, addedAt: Date.now() });
    updateBadge();
  }
}

function updateBadge() {
  const count = uncategorizedDomains.size;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

/**
 * Attempt AI classification for a domain. Called by service worker.
 */
export async function tryAIClassification({ domain, title, metaDescription }) {
  const categoryId = await aiClassify({ domain, title, metaDescription });
  if (categoryId) {
    // Auto-apply the AI classification
    await storage.addDomainOverride(domain, categoryId);
    await learnFromUserCategorization(domain, title, categoryId);

    // Update current session if applicable
    const current = await storage.getCurrentSession();
    if (current && current.domain === domain) {
      await tracker.updateSessionCategory(categoryId);
    }
    return categoryId;
  }
  return null;
}
