import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractDomain,
  formatDate,
  parseDate,
  getDateRange,
  formatDuration,
  formatDurationPrecise,
  tokenize,
  jaccardSimilarity,
} from '../shared/utils.js';

// ─── extractDomain ─────────────────────────────────────────────────

test('extractDomain strips www so one site is not split in two', () => {
  assert.equal(extractDomain('https://www.youtube.com/watch?v=x'), 'youtube.com');
  assert.equal(extractDomain('https://youtube.com/watch?v=x'), 'youtube.com');
});

test('extractDomain keeps real subdomains', () => {
  assert.equal(extractDomain('https://m.youtube.com/'), 'm.youtube.com');
  assert.equal(extractDomain('https://docs.google.com/document/d/1'), 'docs.google.com');
});

test('extractDomain lowercases the host', () => {
  assert.equal(extractDomain('https://WWW.Example.COM/Path'), 'example.com');
});

test('extractDomain rejects non-http schemes', () => {
  for (const url of [
    'chrome://extensions',
    'chrome-extension://abc/page.html',
    'about:blank',
    'file:///C:/secret.txt',
    'view-source:https://example.com',
    'data:text/html,hi',
  ]) {
    assert.equal(extractDomain(url), '', `${url} should not be tracked`);
  }
});

test('extractDomain returns empty for junk input', () => {
  assert.equal(extractDomain(''), '');
  assert.equal(extractDomain(null), '');
  assert.equal(extractDomain('not a url'), '');
});

// ─── Dates ─────────────────────────────────────────────────────────

test('formatDate pads month and day', () => {
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(formatDate(new Date(2026, 11, 25)), '2026-12-25');
});

test('parseDate round-trips formatDate at local midnight', () => {
  const d = parseDate('2026-03-09');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 2);
  assert.equal(d.getDate(), 9);
  assert.equal(formatDate(d), '2026-03-09');
});

test('getDateRange is inclusive on both ends', () => {
  assert.deepEqual(getDateRange('2026-01-30', '2026-02-02'), [
    '2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02',
  ]);
});

test('getDateRange handles a single day', () => {
  assert.deepEqual(getDateRange('2026-05-05', '2026-05-05'), ['2026-05-05']);
});

test('getDateRange crosses a leap day', () => {
  assert.deepEqual(getDateRange('2028-02-28', '2028-03-01'), [
    '2028-02-28', '2028-02-29', '2028-03-01',
  ]);
});

// ─── Durations ─────────────────────────────────────────────────────

test('formatDuration renders hours, minutes and seconds', () => {
  assert.equal(formatDuration(3_661_000), '1h 1m');
  assert.equal(formatDuration(3_600_000), '1h');
  assert.equal(formatDuration(120_000), '2m');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(500), '0m');
});

test('formatDurationPrecise is zero padded', () => {
  assert.equal(formatDurationPrecise(0), '00:00:00');
  assert.equal(formatDurationPrecise(3_661_000), '01:01:01');
});

// ─── Similarity ────────────────────────────────────────────────────

test('tokenize drops stop words and short words', () => {
  assert.deepEqual(tokenize('The Best Way to Learn'), ['best', 'way', 'learn']);
});

test('tokenize strips punctuation and returns empty for junk', () => {
  assert.deepEqual(tokenize('!!! ??? ...'), []);
  assert.deepEqual(tokenize(''), []);
});

test('jaccardSimilarity is 1 for identical sets and 0 for disjoint', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1);
  assert.equal(jaccardSimilarity(['a'], ['b']), 0);
  assert.equal(jaccardSimilarity([], ['a']), 0);
});

test('jaccardSimilarity computes partial overlap', () => {
  // {a,b,c} vs {b,c,d} -> intersection 2, union 4
  assert.equal(jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5);
});
