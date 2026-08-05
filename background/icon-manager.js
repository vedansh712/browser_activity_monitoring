import { ACCENT_MODES, ACCENT_SPAN_LIMITS, DEFAULT_ACCENT } from '../shared/constants.js';
import { normalizeAccent } from '../shared/theme.js';
import { drawIcon, iconColorForProgress } from '../shared/icon-renderer.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('icon');

/**
 * Keeps the toolbar icon showing today's tracked time.
 *
 * The ring always fills with elapsed time. Its colour follows whatever the
 * theme is doing: the chosen colour in fixed mode, the time-driven ramp in
 * dynamic mode. Reading the same colour function as the interface means the
 * icon and the dashboard cannot disagree.
 */

/** Sizes Chrome asks for: 16 for standard displays, 32 for 2x. */
const ICON_SIZES = [16, 32];

/**
 * Last icon rendered, so an unchanged icon is not redrawn and re-uploaded on
 * every heartbeat. Module state is fine here: losing it on a worker teardown
 * costs one redundant redraw, not correctness.
 */
let lastRenderKey = null;

/**
 * Redraw and apply the toolbar icon.
 *
 * @param {Object} options
 * @param {number} options.totalMs  - time tracked today
 * @param {Object} options.settings
 * @param {boolean} [options.paused] - tracking disabled or idle
 */
export async function refreshActionIcon({ totalMs, settings, paused = false }) {
  if (typeof OffscreenCanvas === 'undefined') return;

  const spanHours = clampSpan(settings?.accentSpanHours);
  const progress = Math.min(1, Math.max(0, totalMs / (spanHours * 60 * 60 * 1000)));

  const color = settings?.accentMode === ACCENT_MODES.DYNAMIC
    ? iconColorForProgress(progress)
    : normalizeAccent(settings?.accentColor ?? DEFAULT_ACCENT);

  // Quantise the fill so the icon is redrawn only when it would visibly
  // differ. At 16px a change smaller than one percent of the ring is invisible,
  // and redrawing every minute regardless would be pure waste.
  const renderKey = `${Math.round(progress * 100)}|${color}|${paused}`;
  if (renderKey === lastRenderKey) return;

  try {
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        log.warn(`No 2D context available at ${size}px — icon left unchanged`);
        return;
      }

      drawIcon(ctx, { size, progress, color, paused });
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }

    await chrome.action.setIcon({ imageData });
    lastRenderKey = renderKey;

    log.info(`Icon repainted: ${Math.round(progress * 100)}% ${color}${paused ? ' (paused)' : ''}`);
  } catch (err) {
    // A failed icon update must never disrupt tracking — it is decoration.
    log.warn('Could not update toolbar icon:', err?.message ?? err);
  }
}

function clampSpan(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return ACCENT_SPAN_LIMITS.fallback;
  return Math.min(ACCENT_SPAN_LIMITS.max, Math.max(ACCENT_SPAN_LIMITS.min, hours));
}
