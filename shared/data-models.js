import { generateId, formatDate, extractDomain } from './utils.js';

/**
 * Create a new session record.
 */
export function createSession({ url, title, categoryId, meta = null }) {
  const now = Date.now();
  return {
    id: generateId(),
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
 * End a session — compute duration.
 */
export function endSession(session) {
  if (!session || !session.isActive) return session;
  const now = Date.now();
  return {
    ...session,
    endTime: now,
    duration: now - session.startTime,
    isActive: false,
  };
}

/**
 * Pause a session — store partial duration but keep it active.
 */
export function pauseSession(session) {
  if (!session || !session.isActive) return session;
  const now = Date.now();
  return {
    ...session,
    duration: (session.duration || 0) + (now - session.startTime),
    startTime: now, // reset for next resume
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

/**
 * Create a similarity data entry from a user-categorized page.
 */
export function createSimilarityEntry({ domain, titleTokens, domainTokens, categoryId }) {
  return {
    id: generateId(),
    domain,
    titleTokens: titleTokens || [],
    domainTokens: domainTokens || [],
    categoryId,
    createdAt: Date.now(),
  };
}
