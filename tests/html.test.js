import test from 'node:test';
import assert from 'node:assert/strict';

import { escapeHtml, html, unsafeHtml, render, cssColor, SafeHtml } from '../shared/html.js';
import { clampInt } from '../shared/utils.js';
import { SETTINGS_LIMITS } from '../shared/constants.js';

// ─── escapeHtml ────────────────────────────────────────────────────

test('escapeHtml neutralises every HTML metacharacter', () => {
  assert.equal(
    escapeHtml('<script>alert("x")</script>'),
    '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'
  );
  assert.equal(escapeHtml("it's & more"), 'it&#39;s &amp; more');
});

test('escapeHtml renders null and undefined as empty', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml coerces non-strings', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(false), 'false');
});

// ─── html`` tagged template ────────────────────────────────────────

test('html escapes interpolated values by default', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const result = html`<div>${evil}</div>`.toString();
  assert.equal(result, '<div>&lt;img src=x onerror=alert(1)&gt;</div>');
  assert.ok(!result.includes('<img'));
});

test('html prevents breaking out of a quoted attribute', () => {
  // The classic options-page injection: a value that closes the attribute and
  // opens an event handler.
  const evil = '" onmouseover="alert(1)';
  const result = html`<span data-x="${evil}">hi</span>`.toString();
  assert.ok(!result.includes('onmouseover="alert'));
  assert.ok(result.includes('&quot; onmouseover=&quot;alert(1)'));
});

test('html returns SafeHtml, not a string', () => {
  assert.ok(html`<p>x</p>` instanceof SafeHtml);
});

test('nested SafeHtml is not double-escaped', () => {
  const inner = html`<b>${'a&b'}</b>`;
  const outer = html`<div>${inner}</div>`.toString();
  assert.equal(outer, '<div><b>a&amp;b</b></div>');
});

test('arrays of SafeHtml compose without join()', () => {
  const items = ['a', 'b'].map((v) => html`<li>${v}</li>`);
  assert.equal(html`<ul>${items}</ul>`.toString(), '<ul><li>a</li><li>b</li></ul>');
});

test('arrays of raw values are escaped element-wise', () => {
  assert.equal(html`<p>${['<a>', '<b>']}</p>`.toString(), '<p>&lt;a&gt;&lt;b&gt;</p>');
});

test('null and undefined interpolate as empty', () => {
  assert.equal(html`<p>${null}${undefined}</p>`.toString(), '<p></p>');
});

test('a template with no interpolations is preserved', () => {
  assert.equal(html`<hr>`.toString(), '<hr>');
});

// ─── unsafeHtml / render ───────────────────────────────────────────

test('unsafeHtml is passed through verbatim', () => {
  assert.equal(html`<div>${unsafeHtml('<br>')}</div>`.toString(), '<div><br></div>');
});

test('render refuses a plain string', () => {
  const el = { innerHTML: 'untouched' };
  assert.throws(() => render(el, '<b>raw</b>'), TypeError);
  assert.equal(el.innerHTML, 'untouched', 'element must not be modified on rejection');
});

test('render refuses a missing element', () => {
  assert.throws(() => render(null, html`<p>x</p>`), TypeError);
});

test('render writes SafeHtml through', () => {
  const el = { innerHTML: '' };
  render(el, html`<p>${'a<b'}</p>`);
  assert.equal(el.innerHTML, '<p>a&lt;b</p>');
});

// ─── cssColor ──────────────────────────────────────────────────────

test('cssColor accepts valid hex colours of each length', () => {
  for (const good of ['#fff', '#FFFF', '#667eea', '#667eeaff']) {
    assert.equal(cssColor(good), good);
  }
});

test('cssColor rejects CSS injection attempts', () => {
  for (const bad of [
    'red; background: url(http://evil)',
    'expression(alert(1))',
    '#fff; }',
    'javascript:alert(1)',
    '',
    null,
    undefined,
    123,
  ]) {
    assert.equal(cssColor(bad), '#9E9E9E', `${JSON.stringify(bad)} should fall back`);
  }
});

test('cssColor honours a custom fallback', () => {
  assert.equal(cssColor('nonsense', '#000000'), '#000000');
});

// ─── clampInt ──────────────────────────────────────────────────────

test('clampInt keeps in-range values', () => {
  assert.equal(clampInt('120', SETTINGS_LIMITS.idleThresholdSeconds), 120);
});

test('clampInt bounds out-of-range values', () => {
  const bounds = SETTINGS_LIMITS.idleThresholdSeconds;
  assert.equal(clampInt('1', bounds), bounds.min);
  assert.equal(clampInt('999999', bounds), bounds.max);
});

test('clampInt falls back for unusable input', () => {
  const bounds = SETTINGS_LIMITS.retentionDays;
  for (const bad of ['', 'abc', null, undefined, NaN, {}]) {
    assert.equal(clampInt(bad, bounds), bounds.fallback, `${JSON.stringify(bad)} should fall back`);
  }
});

test('clampInt truncates rather than rounding', () => {
  assert.equal(clampInt('90.9', SETTINGS_LIMITS.retentionDays), 90);
});

test('settings limits are internally consistent', () => {
  for (const [name, bounds] of Object.entries(SETTINGS_LIMITS)) {
    assert.ok(bounds.min <= bounds.max, `${name}: min must not exceed max`);
    assert.ok(
      bounds.fallback >= bounds.min && bounds.fallback <= bounds.max,
      `${name}: fallback must sit within bounds`
    );
  }
});
