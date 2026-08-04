import { generateId, formatDate, extractDomain } from './utils.js';
import { MAX_TRACKED_INTERVAL_MS } from './constants.js';

/*
 * Session timing model
 * ────────────────────
 * `duration`  — banked milliseconds from intervals that have already closed.
 * `startTime` — when the currently-running interval began.
 * `isActive`  — whether the clock is running.
 *
 * Elapsed time is always `duration + (now - startTime)` while active, and just
 * `duration` while paused. Every transition banks the open interval before
 * changing state, which makes pause/resume/end idempotent: calling pause twice
 * can't double-count, and ending a paused session can't lose its banked time.
 */

/**
 * Create a new session record.
 */
export function createSession({ url, title, categoryId, tabId = null, meta = null }) {
  const now = Date.now();
  return {
    id: generateId(),
    tabId,
    url: url || '',
    domain: extractDomain(url),
    title: title || '',
    categoryId: categoryId || 'uncategorized',
    startTime: now,
    endTime: 0,
    duration: 0,
    isActive: true,
    date: formatDate(new Date(now)),
    meta,
  };
}

/**
 * Total elapsed time for a session, including the currently-open interval.
 *
 * The open interval is clamped to MAX_TRACKED_INTERVAL_MS: if more time has
 * passed than the flush alarm allows for, the machine was asleep rather than
 * the user browsing, and that gap must not be counted.
 */
export function sessionElapsed(session, now = Date.now()) {
  if (!session) return 0;
  const banked = session.duration || 0;
  if (!session.isActive) return banked;
  // Math.max guards against the wall clock moving backwards (NTP, DST, manual change).
  const open = Math.max(0, now - session.startTime);
  return banked + Math.min(open, MAX_TRACKED_INTERVAL_MS);
}

/**
 * End a session — bank the open interval and stop the clock.
 *
 * `date` is re-stamped from the end time so that a session which crosses
 * midnight is filed under the day its time actually landed in. Combined with
 * 5-minute flushing this keeps midnight misattribution under one flush period.
 */
export function endSession(session) {
  if (!session) return session;
  const now = Date.now();
  return {
    ...session,
    endTime: now,
    duration: sessionElapsed(session, now),
    isActive: false,
    date: formatDate(new Date(now)),
  };
}

/**
 * Pause a session — bank the open interval and stop the clock.
 */
export function pauseSession(session) {
  if (!session || !session.isActive) return session;
  const now = Date.now();
  return {
    ...session,
    duration: sessionElapsed(session, now),
    isActive: false,
  };
}

/**
 * Resume a paused session — restart the clock without touching banked time.
 */
export function resumeSession(session) {
  if (!session || session.isActive) return session;
  return {
    ...session,
    startTime: Date.now(),
    isActive: true,
  };
}

/**
 * Create an empty daily aggregate structure.
 */
export function createAggregate(dateStr) {
  return {
    date: dateStr,
    totalTime: 0,
    domainBreakdown: {},
    categoryBreakdown: {},
    topPages: [],
    sessionCount: 0,
    youtubeStats: null,
  };
}

/**
 * Build aggregates from an array of session records.
 */
export function buildAggregate(dateStr, sessions) {
  const agg = createAggregate(dateStr);
  const pageMap = {};
  const ytChannels = {};
  const ytCategories = {};
  let ytTotalTime = 0;
  let ytVideoCount = 0;

  for (const session of sessions) {
    if (session.isActive || session.duration <= 0) continue;

    agg.totalTime += session.duration;
    agg.sessionCount++;

    // Domain breakdown
    if (session.domain) {
      agg.domainBreakdown[session.domain] =
        (agg.domainBreakdown[session.domain] || 0) + session.duration;
    }

    // Category breakdown
    agg.categoryBreakdown[session.categoryId] =
      (agg.categoryBreakdown[session.categoryId] || 0) + session.duration;

    // Top pages
    const pageKey = session.url;
    if (!pageMap[pageKey]) {
      pageMap[pageKey] = {
        url: session.url,
        title: session.title,
        domain: session.domain,
        totalTime: 0,
      };
    }
    pageMap[pageKey].totalTime += session.duration;

    // YouTube stats
    if (session.meta && session.meta.videoId) {
      ytTotalTime += session.duration;
      ytVideoCount++;

      const channel = session.meta.channelName || 'Unknown';
      ytChannels[channel] = (ytChannels[channel] || 0) + session.duration;

      const ytCat = session.meta.videoCategory || 'Unknown';
      ytCategories[ytCat] = (ytCategories[ytCat] || 0) + session.duration;
    }
  }

  // Sort top pages by time descending, keep top 20
  agg.topPages = Object.values(pageMap)
    .sort((a, b) => b.totalTime - a.totalTime)
    .slice(0, 20);

  // YouTube stats
  if (ytVideoCount > 0) {
    agg.youtubeStats = {
      totalWatchTime: ytTotalTime,
      videosWatched: ytVideoCount,
      topChannels: Object.entries(ytChannels)
        .map(([name, time]) => ({ name, time }))
        .sort((a, b) => b.time - a.time)
        .slice(0, 10),
      categoryBreakdown: ytCategories,
    };
  }

  return agg;
}

export const HOURS_PER_DAY = 24;

/**
 * Total tracked milliseconds per hour of the day.
 *
 * Each session is attributed to the hour it started in. That is accurate in
 * practice because the flush alarm splits live sessions every few minutes, so
 * individual records rarely span an hour boundary.
 *
 * @param {Object[]} sessions
 * @returns {number[]} 24 entries, index 0 = midnight, in milliseconds
 */
export function bucketSessionsByHour(sessions) {
  const buckets = new Array(HOURS_PER_DAY).fill(0);
  if (!Array.isArray(sessions)) return buckets;

  for (const session of sessions) {
    if (!session || session.isActive) continue;
    if (!(session.duration > 0) || !session.startTime) continue;

    const hour = new Date(session.startTime).getHours();
    if (hour >= 0 && hour < HOURS_PER_DAY) {
      buckets[hour] += session.duration;
    }
  }
  return buckets;
}
