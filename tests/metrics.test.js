import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBlocks,
  countContextSwitches,
  deepWorkRatio,
  concentrationIndex,
  computeFocusScore,
  computeDelta,
  previousPeriod,
} from '../shared/metrics.js';
import { FOCUS } from '../shared/constants.js';

const MIN = 60_000;
const BASE = new Date(2026, 5, 15, 9, 0, 0).getTime();

/** Session `minutes` long, starting `offsetMin` after BASE. */
function s(domain, offsetMin, minutes, categoryId = 'development') {
  const startTime = BASE + offsetMin * MIN;
  return {
    domain,
    categoryId,
    startTime,
    endTime: startTime + minutes * MIN,
    duration: minutes * MIN,
    isActive: false,
  };
}

// ─── Block building ────────────────────────────────────────────────

test('adjacent chunks of one domain merge into a single block', () => {
  // The flush alarm splits a continuous visit into several rows; treating them
  // as separate visits would report constant switching for someone who never
  // left the page.
  const blocks = buildBlocks([s('a.com', 0, 5), s('a.com', 5, 5), s('a.com', 10, 5)]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].duration, 15 * MIN);
});

test('a long gap starts a new block even on the same domain', () => {
  const blocks = buildBlocks([s('a.com', 0, 5), s('a.com', 120, 5)]);
  assert.equal(blocks.length, 2);
});

test('different domains never merge', () => {
  const blocks = buildBlocks([s('a.com', 0, 5), s('b.com', 5, 5)]);
  assert.equal(blocks.length, 2);
});

test('blocks are built in chronological order regardless of input order', () => {
  const blocks = buildBlocks([s('b.com', 10, 5), s('a.com', 0, 5)]);
  assert.deepEqual(blocks.map((b) => b.domain), ['a.com', 'b.com']);
});

test('live, zero-length and malformed sessions are ignored', () => {
  const blocks = buildBlocks([
    { ...s('a.com', 0, 5), isActive: true },
    s('b.com', 5, 0),
    { domain: 'c.com', duration: 5 * MIN, isActive: false },
    null,
  ]);
  assert.equal(blocks.length, 0);
});

test('buildBlocks tolerates junk input', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    assert.deepEqual(buildBlocks(bad), []);
  }
});

// ─── Context switches ──────────────────────────────────────────────

test('context switches count transitions, not sessions', () => {
  // Six rows, but only three actual moves between sites.
  const sessions = [
    s('a.com', 0, 5), s('a.com', 5, 5),
    s('b.com', 10, 5), s('b.com', 15, 5),
    s('a.com', 20, 5), s('c.com', 25, 5),
  ];
  assert.equal(countContextSwitches(sessions), 3);
});

test('a single uninterrupted block is zero switches', () => {
  assert.equal(countContextSwitches([s('a.com', 0, 30)]), 0);
});

test('no sessions is zero switches, never negative', () => {
  assert.equal(countContextSwitches([]), 0);
});

// ─── Components ────────────────────────────────────────────────────

test('deepWorkRatio measures time in sustained blocks', () => {
  const blocks = buildBlocks([s('a.com', 0, 30), s('b.com', 40, 10)]);
  // 30 of 40 minutes sat in a block of 15+ minutes.
  assert.equal(deepWorkRatio(blocks, 40 * MIN), 0.75);
});

test('deepWorkRatio is zero when nothing is sustained', () => {
  const blocks = buildBlocks([s('a.com', 0, 5), s('b.com', 10, 5)]);
  assert.equal(deepWorkRatio(blocks, 10 * MIN), 0);
});

test('concentration is 1 when all time is on one site', () => {
  const blocks = buildBlocks([s('a.com', 0, 30)]);
  assert.equal(concentrationIndex(blocks, 30 * MIN), 1);
});

test('concentration falls as time is spread across sites', () => {
  const four = buildBlocks([s('a.com', 0, 10), s('b.com', 20, 10), s('c.com', 40, 10), s('d.com', 60, 10)]);
  // Four equal shares -> 4 * 0.25^2 = 0.25
  assert.ok(Math.abs(concentrationIndex(four, 40 * MIN) - 0.25) < 1e-9);
});

test('components handle zero total time without dividing by zero', () => {
  assert.equal(deepWorkRatio([], 0), 0);
  assert.equal(concentrationIndex([], 0), 0);
});

// ─── Focus score ───────────────────────────────────────────────────

test('too little data yields null, not a bad score', () => {
  // Critical distinction: "we don't know" must not render as "you did badly".
  const result = computeFocusScore([s('a.com', 0, 2)]);
  assert.equal(result.score, null);
  assert.equal(result.totalMs, 2 * MIN);
});

test('no data at all yields null', () => {
  assert.equal(computeFocusScore([]).score, null);
  assert.equal(computeFocusScore(null).score, null);
});

test('one long uninterrupted block scores near the maximum', () => {
  const result = computeFocusScore([s('a.com', 0, 90)]);
  assert.equal(result.switches, 0);
  assert.equal(result.longestBlockMs, 90 * MIN);
  assert.ok(result.score >= 95, `expected a near-perfect score, got ${result.score}`);
});

test('rapid thrash between many sites scores low', () => {
  const sessions = [];
  for (let i = 0; i < 40; i++) {
    sessions.push(s(`site${i}.com`, i, 1));
  }
  const result = computeFocusScore(sessions);
  assert.ok(result.score <= 20, `expected a low score, got ${result.score}`);
  assert.equal(result.switches, 39);
});

test('focused browsing scores above scattered browsing', () => {
  const focused = computeFocusScore([s('a.com', 0, 40), s('b.com', 45, 30)]);
  const scattered = computeFocusScore(
    Array.from({ length: 30 }, (_, i) => s(`s${i % 10}.com`, i * 2, 2))
  );
  assert.ok(
    focused.score > scattered.score,
    `focused ${focused.score} should beat scattered ${scattered.score}`
  );
});

test('the score is always within 0..100', () => {
  const cases = [
    [s('a.com', 0, 600)],
    Array.from({ length: 200 }, (_, i) => s(`d${i}.com`, i, 1)),
    [s('a.com', 0, 15), s('b.com', 15, 15), s('c.com', 30, 15)],
  ];
  for (const sessions of cases) {
    const { score } = computeFocusScore(sessions);
    assert.ok(score >= 0 && score <= 100, `score out of range: ${score}`);
  }
});

test('switchesPerHour is normalised by tracked time, not wall clock', () => {
  // Two switches inside 30 tracked minutes is four per hour.
  const result = computeFocusScore([s('a.com', 0, 10), s('b.com', 10, 10), s('c.com', 20, 10)]);
  assert.equal(result.switches, 2);
  assert.ok(Math.abs(result.switchesPerHour - 4) < 1e-9);
});

test('focus weights sum to one', () => {
  const total = Object.values(FOCUS.WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
});

test('config overrides are honoured', () => {
  const sessions = [s('a.com', 0, 12)];
  const strict = computeFocusScore(sessions, { minSampleMs: MIN, deepBlockMs: 60 * MIN });
  const lenient = computeFocusScore(sessions, { minSampleMs: MIN, deepBlockMs: 5 * MIN });
  assert.ok(lenient.score > strict.score);
});

// ─── Deltas ────────────────────────────────────────────────────────

test('computeDelta reports direction and ratio', () => {
  assert.deepEqual(computeDelta(120, 100), { absolute: 20, ratio: 0.2, direction: 'up' });
  assert.deepEqual(computeDelta(80, 100), { absolute: -20, ratio: -0.2, direction: 'down' });
  assert.deepEqual(computeDelta(100, 100), { absolute: 0, ratio: 0, direction: 'flat' });
});

test('growth from zero has no meaningful ratio', () => {
  // Rendering this as "+Infinity%" or "+100%" would both be lies.
  const delta = computeDelta(50, 0);
  assert.equal(delta.ratio, null);
  assert.equal(delta.direction, 'up');
  assert.equal(delta.absolute, 50);
});

test('computeDelta coerces junk to zero', () => {
  assert.equal(computeDelta(undefined, undefined).absolute, 0);
  assert.equal(computeDelta('abc', null).direction, 'flat');
});

// ─── Previous period ───────────────────────────────────────────────

test('the previous period is the equal-length range immediately before', () => {
  assert.deepEqual(previousPeriod('2026-06-08', '2026-06-14'), {
    start: '2026-06-01', end: '2026-06-07',
  });
});

test('a single day compares against the day before', () => {
  assert.deepEqual(previousPeriod('2026-06-15', '2026-06-15'), {
    start: '2026-06-14', end: '2026-06-14',
  });
});

test('the previous period crosses month and year boundaries', () => {
  assert.deepEqual(previousPeriod('2026-03-01', '2026-03-31'), {
    start: '2026-01-29', end: '2026-02-28',
  });
  assert.deepEqual(previousPeriod('2026-01-01', '2026-01-07'), {
    start: '2025-12-25', end: '2025-12-31',
  });
});
