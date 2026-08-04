import { DEFAULT_ACCENT, STORAGE_KEYS } from './constants.js';

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

/**
 * Apply the stored accent and keep it in sync.
 *
 * Listening for storage changes means picking a colour in options updates an
 * open dashboard live, with no reload and no message plumbing.
 *
 * @param {HTMLElement} [root]
 * @returns {Promise<string>} the applied colour
 */
export async function initTheme(root = document.documentElement) {
  let applied = DEFAULT_ACCENT;

  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    applied = applyAccent(stored[STORAGE_KEYS.SETTINGS]?.accentColor, root);
  } catch {
    // Storage unavailable — the CSS default already provides a usable theme.
    applied = applyAccent(DEFAULT_ACCENT, root);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEYS.SETTINGS]) return;
    const next = changes[STORAGE_KEYS.SETTINGS].newValue?.accentColor;
    if (next) applyAccent(next, root);
  });

  return applied;
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
