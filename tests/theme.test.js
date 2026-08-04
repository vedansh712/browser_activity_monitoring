import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHexColor,
  normalizeAccent,
  relativeLuminance,
  contrastRatio,
  foregroundFor,
  applyAccent,
} from '../shared/theme.js';
import { DEFAULT_ACCENT, ACCENT_PRESETS } from '../shared/constants.js';

// ─── Parsing ───────────────────────────────────────────────────────

test('parseHexColor handles 6-digit and 3-digit forms', () => {
  assert.deepEqual(parseHexColor('#ff2b4a'), { r: 255, g: 43, b: 74 });
  assert.deepEqual(parseHexColor('#FFF'), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseHexColor('#000'), { r: 0, g: 0, b: 0 });
});

test('parseHexColor is case insensitive and tolerates whitespace', () => {
  assert.deepEqual(parseHexColor('  #FF2B4A  '), { r: 255, g: 43, b: 74 });
});

test('parseHexColor rejects anything that is not a hex colour', () => {
  for (const bad of ['red', 'rgb(1,2,3)', '#12345', '#gggggg', '', null, undefined, 42, {}]) {
    assert.equal(parseHexColor(bad), null, `${JSON.stringify(bad)} should not parse`);
  }
});

// ─── Normalisation (this value reaches a CSS custom property) ───────

test('normalizeAccent expands shorthand to 6 digits', () => {
  assert.equal(normalizeAccent('#f00'), '#ff0000');
});

test('normalizeAccent falls back to the default for junk', () => {
  // The result is written into a style context, so nothing unvalidated
  // may pass through.
  for (const bad of [
    'red; background: url(http://evil)',
    'javascript:alert(1)',
    'var(--something)',
    '',
    null,
    undefined,
  ]) {
    assert.equal(normalizeAccent(bad), DEFAULT_ACCENT);
  }
});

test('normalizeAccent is idempotent', () => {
  const once = normalizeAccent('#21D4FD');
  assert.equal(normalizeAccent(once), once);
  assert.equal(once, '#21d4fd');
});

// ─── Luminance and contrast ────────────────────────────────────────

test('relativeLuminance spans black to white', () => {
  assert.equal(relativeLuminance('#000000'), 0);
  assert.ok(Math.abs(relativeLuminance('#ffffff') - 1) < 1e-9);
});

test('contrastRatio matches the known WCAG extremes', () => {
  assert.ok(Math.abs(contrastRatio('#000000', '#ffffff') - 21) < 1e-6);
  assert.ok(Math.abs(contrastRatio('#ffffff', '#ffffff') - 1) < 1e-9);
});

test('contrastRatio is symmetric', () => {
  assert.equal(contrastRatio('#ff2b4a', '#07070c'), contrastRatio('#07070c', '#ff2b4a'));
});

// ─── Foreground selection ──────────────────────────────────────────

test('bright accents get dark text, dark accents get light text', () => {
  // Without this, acid green or amber would carry white text at roughly
  // 1.5:1 contrast — unreadable.
  assert.equal(foregroundFor('#a6ff2b'), '#07070c', 'acid green is bright');
  assert.equal(foregroundFor('#ffb02b'), '#07070c', 'amber is bright');

  // Saturated blue looks dark but is not: at luminance ~0.22 black scores
  // 5.1:1 against it versus white at 3.9:1. Eyeballing this gets it wrong,
  // which is the reason the choice is computed rather than hand-assigned.
  assert.equal(foregroundFor('#2b7bff'), '#07070c', 'azure is brighter than it looks');

  assert.equal(foregroundFor('#4b0082'), '#ffffff', 'indigo is genuinely dark');
  assert.equal(foregroundFor('#3a0d1f'), '#ffffff', 'deep maroon is genuinely dark');
});

test('every preset produces a legible foreground', () => {
  // 4.5:1 is the WCAG AA threshold for normal text.
  for (const preset of ACCENT_PRESETS) {
    const fg = foregroundFor(preset.value);
    const ratio = contrastRatio(preset.value, fg);
    assert.ok(ratio >= 4.5, `${preset.name} (${preset.value}) only reaches ${ratio.toFixed(2)}:1`);
  }
});

test('an arbitrary user colour still yields usable contrast', () => {
  // Sweep the hue circle at full saturation — the worst case for legibility.
  for (let hue = 0; hue < 360; hue += 15) {
    const colour = hslToHex(hue, 100, 50);
    const ratio = contrastRatio(colour, foregroundFor(colour));
    assert.ok(ratio >= 3, `hue ${hue} (${colour}) only reaches ${ratio.toFixed(2)}:1`);
  }
});

// ─── DOM application ───────────────────────────────────────────────

test('applyAccent writes both custom properties', () => {
  const props = new Map();
  const fakeRoot = { style: { setProperty: (k, v) => props.set(k, v) } };

  const applied = applyAccent('#21d4fd', fakeRoot);

  assert.equal(applied, '#21d4fd');
  assert.equal(props.get('--accent'), '#21d4fd');
  assert.equal(props.get('--on-accent'), '#07070c');
});

test('applyAccent sanitises before writing to the style property', () => {
  const props = new Map();
  const fakeRoot = { style: { setProperty: (k, v) => props.set(k, v) } };

  applyAccent('red; background: url(http://evil)', fakeRoot);

  assert.equal(props.get('--accent'), DEFAULT_ACCENT);
});

// ─── helper ────────────────────────────────────────────────────────

function hslToHex(h, s, l) {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n) => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to = (x) => Math.round(255 * x).toString(16).padStart(2, '0');
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`;
}
