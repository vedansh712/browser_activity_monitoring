import { FOCUS } from './constants.js';

/**
 * Attention metrics derived from raw sessions.
 *
 * Everything here is a pure function of a session list. No storage, no DOM, no
 * clock — which is what makes these numbers testable and makes the definitions
 * auditable by anyone who wants to know what the score actually means.
 */

const HOUR_MS = 60 * 60 * 1000;

function isCountable(session) {
  return Boolean(
    session &&
    !session.isActive &&
    session.duration > 0 &&
    session.startTime &&
    session.domain
  );
}

/**
 * Merge sessions into contiguous attention blocks.
 *
 * A single visit to one site is recorded as several session rows, because the
 * flush alarm closes and reopens the record every few minutes. Treating those
 * as separate visits would report constant context switching for someone who
 * never left the page, so adjacent rows for the same domain are rejoined when
 * the gap between them is small.
 *
 * @param {Object[]} sessions
 * @param {number}  [maxGapMs] - gap above which a new block starts
 * @returns {Array<{domain: string, categoryId: string, startTime: number, endTime: number, duration: number}>}
 */
export function buildBlocks(sessions, maxGapMs = FOCUS.BLOCK_GAP_MS) {
  if (!Array.isArray(sessions)) return [];

  const ordered = sessions
    .filter(isCountable)
    .sort((a, b) => a.startTime - b.startTime);

  const blocks = [];
  for (const session of ordered) {
    const endTime = session.endTime || session.startTime + session.duration;
    const previous = blocks[blocks.length - 1];

    const continues =
      previous &&
      previous.domain === session.domain &&
      session.startTime - previous.endTime <= maxGapMs;

    if (continues) {
      previous.duration += session.duration;
      previous.endTime = Math.max(previous.endTime, endTime);
    } else {
      blocks.push({
        domain: session.domain,
        categoryId: session.categoryId ?? 'uncategorized',
        startTime: session.startTime,
        endTime,
        duration: session.duration,
      });
    }
  }
  return blocks;
}

/**
 * Number of times attention moved from one site to another.
 *
 * Counts transitions between blocks, so re-opening the same page after a long
 * pause counts, but a page left open through several flushes does not.
 *
 * @param {Object[]} sessions
 * @returns {number}
 */
export function countContextSwitches(sessions) {
  return Math.max(0, buildBlocks(sessions).length - 1);
}

/**
 * Share of total time spent in blocks of at least `deepBlockMs`.
 * @returns {number} 0..1
 */
export function deepWorkRatio(blocks, totalMs, deepBlockMs = FOCUS.DEEP_BLOCK_MS) {
  if (totalMs <= 0) return 0;
  const deep = blocks
    .filter((block) => block.duration >= deepBlockMs)
    .reduce((sum, block) => sum + block.duration, 0);
  return deep / totalMs;
}

/**
 * How concentrated time was across domains (a Herfindahl index).
 *
 * 1 means every minute went to a single site; approaching 0 means time was
 * scattered thinly across many.
 *
 * @returns {number} 0..1
 */
export function concentrationIndex(blocks, totalMs) {
  if (totalMs <= 0) return 0;

  const byDomain = new Map();
  for (const block of blocks) {
    byDomain.set(block.domain, (byDomain.get(block.domain) ?? 0) + block.duration);
  }

  let index = 0;
  for (const time of byDomain.values()) {
    const share = time / totalMs;
    index += share * share;
  }
  return index;
}

/**
 * Focus score and the components it is built from.
 *
 * `score` is null when there is too little data to say anything meaningful —
 * distinct from a score of 0, which would claim the user was maximally
 * unfocused. The UI must render that as "no data", not as a bad result.
 *
 * @param {Object[]} sessions
 * @param {Object}  [config] - overrides for the FOCUS constants, for testing
 * @returns {{
 *   score: number|null,
 *   totalMs: number,
 *   switches: number,
 *   switchesPerHour: number,
 *   longestBlockMs: number,
 *   deepWorkRatio: number,
 *   concentration: number
 * }}
 */
export function computeFocusScore(sessions, config = {}) {
  const {
    blockGapMs = FOCUS.BLOCK_GAP_MS,
    deepBlockMs = FOCUS.DEEP_BLOCK_MS,
    maxSwitchesPerHour = FOCUS.MAX_SWITCHES_PER_HOUR,
    minSampleMs = FOCUS.MIN_SAMPLE_MS,
    weights = FOCUS.WEIGHTS,
  } = config;

  const blocks = buildBlocks(sessions, blockGapMs);
  const totalMs = blocks.reduce((sum, block) => sum + block.duration, 0);

  const switches = Math.max(0, blocks.length - 1);
  const hours = totalMs / HOUR_MS;
  const switchesPerHour = hours > 0 ? switches / hours : 0;
  const longestBlockMs = blocks.reduce((max, block) => Math.max(max, block.duration), 0);

  const deep = deepWorkRatio(blocks, totalMs, deepBlockMs);
  const concentration = concentrationIndex(blocks, totalMs);

  const base = {
    totalMs,
    switches,
    switchesPerHour,
    longestBlockMs,
    deepWorkRatio: deep,
    concentration,
  };

  if (totalMs < minSampleMs) {
    return { ...base, score: null };
  }

  // The switch penalty saturates: past the ceiling, more thrash cannot make
  // the component score negative and drag the whole result below zero.
  const switchPenalty = Math.min(1, switchesPerHour / maxSwitchesPerHour);

  const raw =
    weights.deepWork * deep +
    weights.lowSwitching * (1 - switchPenalty) +
    weights.concentration * concentration;

  return { ...base, score: Math.round(clamp01(raw) * 100) };
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Compare a value against the equivalent previous period.
 *
 * `ratio` is null when the previous period was zero: an increase from nothing
 * is not "infinity percent", and rendering it as such would be nonsense.
 *
 * @param {number} current
 * @param {number} previous
 * @returns {{absolute: number, ratio: number|null, direction: 'up'|'down'|'flat'}}
 */
export function computeDelta(current, previous) {
  const now = Number(current) || 0;
  const before = Number(previous) || 0;
  const absolute = now - before;

  let direction = 'flat';
  if (absolute > 0) direction = 'up';
  else if (absolute < 0) direction = 'down';

  return {
    absolute,
    ratio: before > 0 ? absolute / before : null,
    direction,
  };
}

/**
 * The date range of equal length immediately preceding [startDate, endDate].
 * Used to put a week-over-week comparison behind every headline number.
 *
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate   - YYYY-MM-DD
 * @returns {{start: string, end: string}}
 */
export function previousPeriod(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);

  const days = Math.round((end - start) / (24 * HOUR_MS)) + 1;

  const prevEnd = new Date(start);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (days - 1));

  return { start: toKey(prevStart), end: toKey(prevEnd) };
}

function toKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
