import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeCsvField, toCsv } from '../shared/csv.js';

// ─── Formula injection (OWASP CSV Injection) ───────────────────────

test('leading formula characters are neutralised', () => {
  // Page titles are attacker-controlled: any site can set a title that becomes
  // a live formula when the user opens their own export.
  for (const payload of [
    '=1+1',
    '+1+1',
    '-1+1',
    '@SUM(A1)',
    '=cmd|\' /C calc\'!A0',
    '=HYPERLINK("http://evil","click")',
  ]) {
    const escaped = escapeCsvField(payload);
    assert.ok(escaped.startsWith("'") || escaped.startsWith('"\''), `${payload} must be defused`);
    assert.ok(!escaped.startsWith('='), 'must not begin with =');
  }
});

test('the guard survives quoting', () => {
  // A payload needing both defusing and quoting must keep the apostrophe inside.
  const escaped = escapeCsvField('=SUM(1,2)');
  assert.equal(escaped, '"\'=SUM(1,2)"');
});

test('ordinary values are left untouched', () => {
  assert.equal(escapeCsvField('example.com'), 'example.com');
  assert.equal(escapeCsvField('Normal title'), 'Normal title');
});

test('a hyphen inside a value is not treated as a formula', () => {
  assert.equal(escapeCsvField('well-known'), 'well-known');
});

// ─── RFC 4180 quoting ──────────────────────────────────────────────

test('fields containing separators are quoted', () => {
  assert.equal(escapeCsvField('a,b'), '"a,b"');
  assert.equal(escapeCsvField('line1\nline2'), '"line1\nline2"');
  assert.equal(escapeCsvField('has "quotes"'), '"has ""quotes"""');
});

test('a comma in a URL cannot break the column layout', () => {
  // The previous exporter quoted only the title, so this shifted every
  // subsequent column by one.
  const csv = toCsv(['Domain', 'URL', 'Time'], [
    ['example.com', 'https://example.com/a,b?x=1,2', '5.0'],
  ], { bom: false });

  const dataLine = csv.split('\r\n')[1];
  assert.equal(dataLine, 'example.com,"https://example.com/a,b?x=1,2",5.0');
});

test('null and undefined become empty fields', () => {
  assert.equal(escapeCsvField(null), '');
  assert.equal(escapeCsvField(undefined), '');
});

// ─── toCsv ─────────────────────────────────────────────────────────

test('toCsv emits a header row and CRLF line endings', () => {
  const csv = toCsv(['A', 'B'], [[1, 2], [3, 4]], { bom: false });
  assert.equal(csv, 'A,B\r\n1,2\r\n3,4');
});

test('toCsv prepends a BOM by default so Excel reads UTF-8', () => {
  assert.ok(toCsv(['A'], [['é']]).startsWith('﻿'));
  assert.ok(!toCsv(['A'], [['é']], { bom: false }).startsWith('﻿'));
});

test('toCsv handles an empty row set', () => {
  assert.equal(toCsv(['A', 'B'], [], { bom: false }), 'A,B');
});

test('toCsv tolerates sparse rows', () => {
  assert.equal(toCsv(['A'], [null, undefined], { bom: false }), 'A\r\n\r\n');
});

test('toCsv validates its arguments', () => {
  assert.throws(() => toCsv('nope', []), TypeError);
  assert.throws(() => toCsv([], 'nope'), TypeError);
});
