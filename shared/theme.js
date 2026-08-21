import {
  DEFAULT_ACCENT,
  STORAGE_KEYS,
  ACCENT_MODES,
  ACCENT_GRADIENT,
  ACCENT_GRADIENT_STOPS,
  ACCENT_SPAN_LIMITS,
  MSG,
} from './constants.js';

/**
 * Runtime theming.
 *
 * theme.css derives every accent variant from a single --accent custom
 * property, so applying a user-chosen colour is one property write and the
 * whole surface re-skins. This module owns that write, plus the one piece
 * that CSS cannot do on its own: choosing a readable foreground for text
 * sitting on a solid accent fill.
 *
 * The pure functions are exported separately from the DOM-touching ones so the
 * colour maths can be unit tested without a browser.
 */

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/**
 * Parse a 3- or 6-digit hex colour into RGB channels.
 * @returns {{r: number, g: number, b: number}|null} null when unparseable
 */
export function parseHexColor(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim();

  const short = hex.match(HEX_SHORT);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    };
  }

  const long = hex.match(HEX_LONG);
  if (long) {
    return {
      r: parseInt(long[1], 16),
      g: parseInt(long[2], 16),
      b: parseInt(long[3], 16),
    };
  }

  return null;
}

/**
 * Normalise a user-supplied colour, falling back to the default.
 *
 * This value is written into a CSS custom property, so it is untrusted input
 * reaching a style context and must never pass through unvalidated.
 *
 * @returns {string} a 6-digit lowercase hex colour
 */
export function normalizeAccent(value) {
  const rgb = parseHexColor(value);
  if (!rgb) return DEFAULT_ACCENT;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/** Convert one sRGB channel (0-255) to linear light. */
function toLinear(channel) {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * WCAG relative luminance.
 * @returns {number} 0 (black) to 1 (white)
 */
export function relativeLuminance(value) {
  const rgb = parseHexColor(value);
  if (!rgb) return 0;
  return 0.2126 * toLinear(rgb.r) + 0.7152 * toLinear(rgb.g) + 0.0722 * toLinear(rgb.b);
}

/** WCAG contrast ratio between two colours, 1 to 21. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_FOREGROUND = '#07070c';
const LIGHT_FOREGROUND = '#ffffff';

/**
 * Pick the foreground with better contrast against a solid accent fill.
 *
 * Without this, a bright accent such as acid green or amber would carry white
 * text at a contrast ratio near 1.5:1 — effectively invisible. Letting the user
 * choose any colour means the theme has to stay legible for all of them.
 *
 * @returns {string} hex colour
 */
export function foregroundFor(accent) {
  const onDark = contrastRatio(accent, DARK_FOREGROUND);
  const onLight = contrastRatio(accent, LIGHT_FOREGROUND);
  return onDark >= onLight ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

// ─── Dynamic accent ────────────────────────────────────────────────

/**
 * Convert HSL to a hex colour.
 *
 * @param {number} h - hue in degrees
 * @param {number} s - saturation 0..100
 * @param {number} l - lightness 0..100
 * @returns {string} '#rrggbb'
 */
export function hslToHex(h, s, l) {
  const sat = clamp(s, 0, 100) / 100;
  const light = clamp(l, 0, 100) / 100;
  // Normalise hue into [0, 360) so wrap-around input still works.
  const hue = ((h % 360) + 360) % 360;

  const a = sat * Math.min(light, 1 - light);
  const channel = (n) => {
    const k = (n + hue / 30) % 12;
    const value = light - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * value).toString(16).padStart(2, '0');
  };

  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * A CSS `linear-gradient(...)` reproducing the ramp.
 *
 * Generated from the same stops the interpolation uses, so the preview swatch
 * in options is painted from one source of truth rather than a hand-maintained
 * copy that could drift when the endpoints change.
 *
 * @param {Array<{hue: number}>} [stops]
 * @param {Object} [gradient]
 * @returns {string}
 */
export function gradientCss(stops = ACCENT_GRADIENT_STOPS, gradient = ACCENT_GRADIENT) {
  const span = gradient.toHue - gradient.fromHue;
  const parts = stops.map((stop) => {
    const position = span === 0 ? 0 : ((stop.hue - gradient.fromHue) / span) * 100;
    return `${hslToHex(stop.hue, gradient.saturation, gradient.lightness)} ${position.toFixed(1)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(', ')})`;
}

/**
 * The accent for a given position along the gradient.
 *
 * Only hue is interpolated; saturation and lightness stay fixed, so every
 * point on the ramp has the same weight against the dark surfaces and the
 * interface does not appear to brighten or fade as the day goes on.
 *
 * @param {number} fraction - 0 (start of ramp) to 1 (end)
 * @param {Object} [gradient]
 * @returns {string} hex colour
 */
export function accentForProgress(fraction, gradient = ACCENT_GRADIENT) {
  const t = clamp(fraction, 0, 1);
  const hue = gradient.fromHue + (gradient.toHue - gradient.fromHue) * t;
  return hslToHex(hue, gradient.saturation, gradient.lightness);
}

/**
 * The accent representing a tracked duration.
 *
 * @param {number} totalMs   - time tracked today
 * @param {number} spanHours - hours at which the ramp reaches its far end
 * @returns {string} hex colour
 */
export function accentForDuration(totalMs, spanHours) {
  const hours = clamp(spanHours, ACCENT_SPAN_LIMITS.min, ACCENT_SPAN_LIMITS.max);
  const spanMs = hours * 60 * 60 * 1000;
  const elapsed = Number(totalMs) > 0 ? Number(totalMs) : 0;
  return accentForProgress(elapsed / spanMs);
}

/**
 * Resolve the accent a settings object implies.
 *
 * @param {Object} settings
 * @param {number} totalMs - today's tracked time; ignored in fixed mode
 * @returns {string} hex colour
 */
export function resolveAccent(settings = {}, totalMs = 0) {
  if (settings.accentMode === ACCENT_MODES.DYNAMIC) {
    return accentForDuration(totalMs, settings.accentSpanHours ?? ACCENT_SPAN_LIMITS.fallback);
  }
  return normalizeAccent(settings.accentColor);
}

/**
 * Today's total tracked time, including the session currently running.
 * Returns 0 if the background worker cannot be reached.
 */
export async function fetchTodayTotalMs() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_TODAY_STATS });
    if (!response || response.error) return 0;

    let total = response.aggregate?.totalTime ?? 0;
    if (response.currentSession?.isActive) {
      total += Date.now() - response.currentSession.startTime;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Write the accent onto a root element.
 *
 * @param {string} accent
 * @param {HTMLElement} [root]
 * @returns {string} the normalised colour actually applied
 */
export function applyAccent(accent, root = document.documentElement) {
  const colour = normalizeAccent(accent);
  root.style.setProperty('--accent', colour);
  root.style.setProperty('--on-accent', foregroundFor(colour));
  return colour;
}

/** Last settings seen, so refreshAccent() can re-resolve without re-reading. */
let activeSettings = null;

/**
 * Apply the accent implied by stored settings, and keep it in sync.
 *
 * Listening for storage changes means changing the colour in options updates
 * an already-open dashboard live, with no reload and no message plumbing.
 *
 * @param {HTMLElement} [root]
 * @returns {Promise<string>} the applied colour
 */
export async function initTheme(root = document.documentElement) {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    activeSettings = stored[STORAGE_KEYS.SETTINGS] ?? {};
  } catch {
    // Storage unavailable — the CSS default already provides a usable theme.
    activeSettings = {};
  }

  const totalMs = activeSettings.accentMode === ACCENT_MODES.DYNAMIC
    ? await fetchTodayTotalMs()
    : 0;

  const applied = applyAccent(resolveAccent(activeSettings, totalMs), root);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return;
    const next = changes[STORAGE_KEYS.SETTINGS].newValue;
    if (!next) return;
    activeSettings = next;
    // Re-resolving needs the current total, which is async; fire and forget so
    // the storage listener stays synchronous.
    refreshAccent(root).catch(() => {});
  });

  return applied;
}

/**
 * Re-resolve and apply the accent.
 *
 * In dynamic mode the colour depends on elapsed time, so callers that already
 * know today's total can pass it and skip the round trip — the popup and
 * dashboard both have it to hand after loading their stats.
 *
 * @param {HTMLElement} [root]
 * @param {number} [knownTotalMs]
 * @returns {Promise<string>} the applied colour
 */
export async function refreshAccent(root = document.documentElement, knownTotalMs = null) {
  const settings = activeSettings ?? {};

  if (settings.accentMode !== ACCENT_MODES.DYNAMIC) {
    return applyAccent(resolveAccent(settings), root);
  }

  const totalMs = knownTotalMs ?? await fetchTodayTotalMs();
  return applyAccent(resolveAccent(settings, totalMs), root);
}

/**
 * Read a resolved theme colour from CSS.
 *
 * Canvas and Chart.js need concrete colour values, but the theme lives in
 * custom properties. This reads the computed value so charts stay in sync with
 * the user's accent instead of hardcoding a second copy of the palette.
 *
 * @param {string} name - custom property name, e.g. '--accent'
 * @param {string} [fallback]
 * @returns {string}
 */
export function themeColor(name, fallback = '#ffffff') {
  if (typeof getComputedStyle !== 'function') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name);
  return value.trim() || fallback;
}
