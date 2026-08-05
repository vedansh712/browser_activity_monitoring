import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseHexColor,
  normalizeAccent,
  relativeLuminance,
  contrastRatio,
  foregroundFor,
  applyAccent,
  hslToHex,
  accentForProgress,
  accentForDuration,
  resolveAccent,
} from '../shared/theme.js';
import {
  DEFAULT_ACCENT,
  ACCENT_PRESETS,
  ACCENT_MODES,
  ACCENT_GRADIENT,
} from '../shared/constants.js';

const HOUR = 60 * 60 * 1000;

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

// ─── HSL conversion ────────────────────────────────────────────────

test('hslToHex matches known conversions', () => {
  assert.equal(hslToHex(0, 100, 50), '#ff0000');
  assert.equal(hslToHex(120, 100, 50), '#00ff00');
  assert.equal(hslToHex(240, 100, 50), '#0000ff');
  assert.equal(hslToHex(0, 0, 100), '#ffffff');
  assert.equal(hslToHex(0, 0, 0), '#000000');
});

test('hslToHex wraps hue and clamps out-of-range input', () => {
  assert.equal(hslToHex(360, 100, 50), hslToHex(0, 100, 50));
  assert.equal(hslToHex(480, 100, 50), hslToHex(120, 100, 50));
  assert.equal(hslToHex(-120, 100, 50), hslToHex(240, 100, 50));
  assert.equal(hslToHex(0, 500, 50), hslToHex(0, 100, 50));
});

test('hslToHex always produces a parseable colour', () => {
  for (let h = 0; h < 360; h += 7) {
    assert.ok(parseHexColor(hslToHex(h, 88, 58)), `hue ${h} produced junk`);
  }
});

// ─── Dynamic gradient ──────────────────────────────────────────────

test('the ramp runs from green to blue', () => {
  const start = parseHexColor(accentForProgress(0));
  const end = parseHexColor(accentForProgress(1));

  assert.ok(start.g > start.b, 'start should be green-dominant');
  assert.ok(end.b > end.g, 'end should be blue-dominant');
});

test('the ramp passes through cyan rather than jumping', () => {
  // Midway between hue 140 and 220 is 180 — cyan, where green and blue match.
  const mid = parseHexColor(accentForProgress(0.5));
  assert.ok(Math.abs(mid.g - mid.b) < 30, `midpoint should be cyan-ish, got ${JSON.stringify(mid)}`);
});

test('the ramp is continuous with no sudden jumps', () => {
  // "Every colour in between" means adjacent steps must be close together.
  let previous = parseHexColor(accentForProgress(0));
  for (let i = 1; i <= 50; i++) {
    const current = parseHexColor(accentForProgress(i / 50));
    const jump = Math.max(
      Math.abs(current.r - previous.r),
      Math.abs(current.g - previous.g),
      Math.abs(current.b - previous.b)
    );
    assert.ok(jump < 30, `discontinuity at step ${i}: jump of ${jump}`);
    previous = current;
  }
});

test('progress is clamped outside 0..1', () => {
  assert.equal(accentForProgress(-5), accentForProgress(0));
  assert.equal(accentForProgress(99), accentForProgress(1));
  assert.equal(accentForProgress(NaN), accentForProgress(0));
});

test('every colour on the ramp stays legible', () => {
  // The whole ramp has to work, not just the endpoints.
  for (let i = 0; i <= 20; i++) {
    const colour = accentForProgress(i / 20);
    const ratio = contrastRatio(colour, foregroundFor(colour));
    assert.ok(ratio >= 4.5, `${colour} only reaches ${ratio.toFixed(2)}:1`);
  }
});

// ─── Duration mapping ──────────────────────────────────────────────

test('duration maps onto the ramp across the configured span', () => {
  const span = 8;
  assert.equal(accentForDuration(0, span), accentForProgress(0));
  assert.equal(accentForDuration(4 * HOUR, span), accentForProgress(0.5));
  assert.equal(accentForDuration(8 * HOUR, span), accentForProgress(1));
});

test('time beyond the span stays at the far end rather than wrapping', () => {
  // Wrapping past blue would send the colour back through purple to red,
  // making a heavy day look identical to a light one.
  assert.equal(accentForDuration(40 * HOUR, 8), accentForProgress(1));
});

test('negative or junk durations resolve to the start of the ramp', () => {
  for (const bad of [-1, NaN, null, undefined, 'abc']) {
    assert.equal(accentForDuration(bad, 8), accentForProgress(0));
  }
});

test('the span is clamped to a sane range', () => {
  // A zero or negative span would divide by zero and produce Infinity.
  assert.ok(parseHexColor(accentForDuration(HOUR, 0)));
  assert.ok(parseHexColor(accentForDuration(HOUR, -3)));
  assert.ok(parseHexColor(accentForDuration(HOUR, 9999)));
});

// ─── Mode resolution ───────────────────────────────────────────────

test('fixed mode ignores elapsed time', () => {
  const settings = { accentMode: ACCENT_MODES.FIXED, accentColor: '#ff2b4a' };
  assert.equal(resolveAccent(settings, 0), '#ff2b4a');
  assert.equal(resolveAccent(settings, 99 * HOUR), '#ff2b4a');
});

test('dynamic mode ignores the fixed colour', () => {
  const settings = {
    accentMode: ACCENT_MODES.DYNAMIC,
    accentColor: '#ff2b4a',
    accentSpanHours: 8,
  };
  assert.notEqual(resolveAccent(settings, 0), '#ff2b4a');
  assert.equal(resolveAccent(settings, 0), accentForProgress(0));
  assert.equal(resolveAccent(settings, 8 * HOUR), accentForProgress(1));
});

test('an unknown or missing mode falls back to fixed', () => {
  assert.equal(resolveAccent({ accentColor: '#21d4fd' }, 5 * HOUR), '#21d4fd');
  assert.equal(resolveAccent({ accentMode: 'nonsense', accentColor: '#21d4fd' }, 5 * HOUR), '#21d4fd');
  assert.equal(resolveAccent({}, 0), DEFAULT_ACCENT);
});

test('dynamic mode uses the default span when none is stored', () => {
  const settings = { accentMode: ACCENT_MODES.DYNAMIC };
  assert.ok(parseHexColor(resolveAccent(settings, 2 * HOUR)));
});

test('gradient endpoints are configured, not hardcoded in the function', () => {
  const custom = { fromHue: 0, toHue: 60, saturation: 100, lightness: 50 };
  assert.equal(accentForProgress(0, custom), hslToHex(0, 100, 50));
  assert.equal(accentForProgress(1, custom), hslToHex(60, 100, 50));
  assert.equal(ACCENT_GRADIENT.fromHue, 140);
});

