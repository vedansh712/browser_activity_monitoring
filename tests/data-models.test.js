import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSession,
  endSession,
  pauseSession,
  resumeSession,
  sessionElapsed,
  buildAggregate,
} from '../shared/data-models.js';
import { MAX_TRACKED_INTERVAL_MS } from '../shared/constants.js';

/**
 * Build a session with an explicit clock position, bypassing Date.now() so the
 * timing assertions below are exact rather than flaky.
 */
function sessionAt({ startTime, duration = 0, isActive = true }) {
  return {
    ...createSession({ url: 'https://example.com/a', title: 'A', categoryId: 'news', tabId: 7 }),
    startTime,
    duration,
    isActive,
  };
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

test('sessionElapsed adds the open interval to banked time', () => {
  const now = 1_000_000;
  const s = sessionAt({ startTime: now - 2 * MINUTE, duration: 3 * MINUTE });
  assert.equal(sessionElapsed(s, now), 5 * MINUTE);
});

test('sessionElapsed ignores the open interval when paused', () => {
  const now = 1_000_000;
  const s = sessionAt({ startTime: now - 2 * MINUTE, duration: 3 * MINUTE, isActive: false });
  assert.equal(sessionElapsed(s, now), 3 * MINUTE);
});

test('sessionElapsed clamps gaps caused by system sleep', () => {
  const now = 1_000_000_000;
  // Eight hours since the last flush means the machine was asleep, not browsing.
  const s = sessionAt({ startTime: now - 8 * 60 * MINUTE, duration: 0 });
  assert.equal(sessionElapsed(s, now), MAX_TRACKED_INTERVAL_MS);
});

test('sessionElapsed never goes negative when the wall clock moves backwards', () => {
  const now = 1_000_000;
  const s = sessionAt({ startTime: now + 5 * MINUTE, duration: MINUTE });
  assert.equal(sessionElapsed(s, now), MINUTE);
});

test('endSession preserves time banked before a pause', () => {
  // This is the regression that silently deleted idle-interrupted time:
  // endSession used to overwrite duration with (now - startTime).
  // Kept under MAX_TRACKED_INTERVAL_MS so the sleep clamp is not what's tested here.
  const banked = 4 * MINUTE;
  const paused = pauseSession(sessionAt({ startTime: Date.now() - banked }));
  assert.ok(paused.duration >= banked - SECOND, 'pause should bank ~4 minutes');

  const resumed = resumeSession(paused);
  const ended = endSession(resumed);

  assert.ok(
    ended.duration >= banked - SECOND,
    `expected banked time to survive end, got ${ended.duration}ms`
  );
});

test('pauseSession is idempotent — double pause does not double count', () => {
  const s = sessionAt({ startTime: Date.now() - 10 * MINUTE });
  const once = pauseSession(s);
  const twice = pauseSession(once);
  assert.equal(once.duration, twice.duration);
  assert.equal(twice.isActive, false);
});

test('pause then resume does not count the paused gap', () => {
  const now = 2_000_000;
  const paused = { ...sessionAt({ startTime: now - MINUTE }), duration: MINUTE, isActive: false };
  const resumed = resumeSession(paused);
  // Clock restarts from resume, banked time untouched.
  assert.equal(resumed.duration, MINUTE);
  assert.equal(resumed.isActive, true);
});

test('endSession on an already-paused session keeps its banked time', () => {
  const paused = { ...sessionAt({ startTime: 0 }), duration: 7 * MINUTE, isActive: false };
  const ended = endSession(paused);
  assert.equal(ended.duration, 7 * MINUTE);
  assert.equal(ended.isActive, false);
  assert.ok(ended.endTime > 0);
});

test('endSession re-stamps the date so midnight-crossing time lands correctly', () => {
  const s = sessionAt({ startTime: Date.now() - MINUTE });
  s.date = '1999-12-31';
  const ended = endSession(s);
  assert.notEqual(ended.date, '1999-12-31');
});

test('createSession records the tab it belongs to', () => {
  const s = createSession({ url: 'https://example.com', title: 'T', categoryId: 'news', tabId: 42 });
  assert.equal(s.tabId, 42);
  assert.equal(s.domain, 'example.com');
  assert.equal(s.isActive, true);
  assert.equal(s.duration, 0);
});

test('createSession defaults tabId to null rather than undefined', () => {
  const s = createSession({ url: 'https://example.com', title: 'T', categoryId: 'news' });
  assert.equal(s.tabId, null);
});

// ─── Aggregation ───────────────────────────────────────────────────

test('buildAggregate totals time by domain and category', () => {
  const sessions = [
    { domain: 'a.com', categoryId: 'news', duration: 3 * MINUTE, url: 'https://a.com/1', title: '1', isActive: false },
    { domain: 'a.com', categoryId: 'news', duration: 2 * MINUTE, url: 'https://a.com/2', title: '2', isActive: false },
    { domain: 'b.com', categoryId: 'search', duration: MINUTE, url: 'https://b.com', title: 'b', isActive: false },
  ];
  const agg = buildAggregate('2026-01-01', sessions);

  assert.equal(agg.totalTime, 6 * MINUTE);
  assert.equal(agg.sessionCount, 3);
  assert.equal(agg.domainBreakdown['a.com'], 5 * MINUTE);
  assert.equal(agg.categoryBreakdown.news, 5 * MINUTE);
  assert.equal(agg.categoryBreakdown.search, MINUTE);
});

test('buildAggregate skips live and zero-length sessions', () => {
  const sessions = [
    { domain: 'a.com', categoryId: 'news', duration: MINUTE, url: 'https://a.com', isActive: true },
    { domain: 'b.com', categoryId: 'news', duration: 0, url: 'https://b.com', isActive: false },
  ];
  const agg = buildAggregate('2026-01-01', sessions);
  assert.equal(agg.totalTime, 0);
  assert.equal(agg.sessionCount, 0);
});

test('buildAggregate summarises YouTube sessions by channel', () => {
  const sessions = [
    {
      domain: 'youtube.com', categoryId: 'education', duration: 10 * MINUTE,
      url: 'https://youtube.com/watch?v=1', isActive: false,
      meta: { videoId: '1', channelName: 'Chan A', videoCategory: 'Education' },
    },
    {
      domain: 'youtube.com', categoryId: 'education', duration: 5 * MINUTE,
      url: 'https://youtube.com/watch?v=2', isActive: false,
      meta: { videoId: '2', channelName: 'Chan A', videoCategory: 'Education' },
    },
  ];
  const agg = buildAggregate('2026-01-01', sessions);

  assert.equal(agg.youtubeStats.videosWatched, 2);
  assert.equal(agg.youtubeStats.totalWatchTime, 15 * MINUTE);
  assert.deepEqual(agg.youtubeStats.topChannels[0], { name: 'Chan A', time: 15 * MINUTE });
});
