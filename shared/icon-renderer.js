import { accentForProgress } from './theme.js';

/**
 * Toolbar icon renderer.
 *
 * Draws a dark tile carrying a circular progress ring, tick marks in the
 * unfilled arc, and clock hands — the same mark at every size, with detail
 * dropped as the canvas shrinks.
 *
 * Why drawn rather than shipped as files
 * ─────────────────────────────────────
 * chrome.action.setIcon accepts ImageData as well as a file path, so the icon
 * can be generated at runtime from the current accent. That means one drawing
 * routine instead of a pre-rendered PNG per colour, and the icon is guaranteed
 * to match the interface because both read the same colour function.
 *
 * SVG is not an option here: Chrome does not accept it for extension icons.
 *
 * The context is passed in rather than created, so the same code drives an
 * OffscreenCanvas in the service worker and a visible canvas in the options
 * preview. Nothing here touches the DOM or chrome APIs.
 */

/**
 * Number of colour bands the icon quantises the ramp into.
 *
 * The interface uses the continuous gradient, but a 16px icon cannot show it:
 * neighbouring shades are indistinguishable at that size, so a smooth sweep
 * reads as "some colour" rather than as a position on a scale. Stepping into
 * five bands makes each state recognisable at a glance — which is the entire
 * job of a toolbar icon.
 */
export const ICON_COLOR_BANDS = 5;

/** Below this the ring is drawn alone; hands and ticks become noise. */
const DETAIL_SIZE_THRESHOLD = 28;

const TICK_COUNT = 12;

/**
 * The icon colour for a position along the ramp, quantised into bands.
 *
 * Sampled at each band's midpoint so a band is represented by its centre
 * colour rather than its edge.
 *
 * @param {number} fraction - 0..1
 * @param {number} [bands]
 * @returns {string} hex colour
 */
export function iconColorForProgress(fraction, bands = ICON_COLOR_BANDS) {
  const clamped = Math.min(1, Math.max(0, Number(fraction) || 0));
  // Math.min keeps fraction === 1 inside the last band rather than past it.
  const band = Math.min(bands - 1, Math.floor(clamped * bands));
  return accentForProgress((band + 0.5) / bands);
}

/**
 * Draw the icon.
 *
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} ctx
 * @param {Object}  options
 * @param {number}  options.size      - canvas edge in pixels (square)
 * @param {number}  options.progress  - 0..1 ring fill
 * @param {string}  options.color     - ring colour
 * @param {boolean} [options.paused]  - draw muted, for when tracking is off
 */
export function drawIcon(ctx, { size, progress, color, paused = false }) {
  const s = size;
  const centre = s / 2;
  const fraction = Math.min(1, Math.max(0, Number(progress) || 0));
  const detailed = s >= DETAIL_SIZE_THRESHOLD;

  ctx.clearRect(0, 0, s, s);
  ctx.save();

  // ── Tile ──────────────────────────────────────────────────────────
  // A self-contained badge rather than a bare glyph, so the icon reads the
  // same on light and dark browser themes instead of disappearing into one.
  const tile = ctx.createLinearGradient(0, 0, 0, s);
  tile.addColorStop(0, '#161b28');
  tile.addColorStop(1, '#080a11');

  ctx.beginPath();
  roundRect(ctx, 0.5, 0.5, s - 1, s - 1, s * 0.24);
  ctx.fillStyle = tile;
  ctx.fill();

  ctx.lineWidth = Math.max(1, s * 0.03);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.stroke();

  // ── Ring geometry ─────────────────────────────────────────────────
  const radius = s * 0.315;
  const ringWidth = Math.max(1.6, s * 0.105);
  const start = -Math.PI / 2; // 12 o'clock
  const sweep = fraction * Math.PI * 2;

  // Unfilled track
  ctx.beginPath();
  ctx.arc(centre, centre, radius, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.lineWidth = ringWidth;
  ctx.stroke();

  // ── Ticks in the unfilled arc ─────────────────────────────────────
  if (detailed) {
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, s * 0.028);
    const inner = radius - ringWidth * 0.62;
    const outer = radius + ringWidth * 0.1;

    for (let i = 0; i < TICK_COUNT; i++) {
      if (i / TICK_COUNT < fraction) continue; // covered by the arc
      const angle = start + (i / TICK_COUNT) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(centre + Math.cos(angle) * inner, centre + Math.sin(angle) * inner);
      ctx.lineTo(centre + Math.cos(angle) * outer, centre + Math.sin(angle) * outer);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.stroke();
    }
  }

  // ── Progress arc ──────────────────────────────────────────────────
  if (fraction > 0) {
    ctx.lineCap = 'round';
    ctx.lineWidth = ringWidth;
    ctx.strokeStyle = paused ? 'rgba(255,255,255,0.28)' : color;

    if (!paused) {
      // The glow is what makes the colour legible at 16px, where the arc is
      // only a couple of pixels thick.
      ctx.shadowColor = color;
      ctx.shadowBlur = s * 0.18;
    }

    ctx.beginPath();
    ctx.arc(centre, centre, radius, start, start + sweep);
    ctx.stroke();

    ctx.shadowBlur = 0;
  }

  // ── Centre ────────────────────────────────────────────────────────
  if (detailed) {
    drawHands(ctx, centre, s, paused);
  } else {
    // At 16px hands are indistinguishable from a smudge, so the centre
    // becomes a single dot that still reads as a dial hub.
    ctx.beginPath();
    ctx.arc(centre, centre, Math.max(1, s * 0.075), 0, Math.PI * 2);
    ctx.fillStyle = paused ? 'rgba(255,255,255,0.4)' : '#ffffff';
    ctx.fill();
  }

  ctx.restore();
}

/** Clock hands, fixed at a legible angle rather than showing real time. */
function drawHands(ctx, centre, s, paused) {
  const ink = paused ? 'rgba(255,255,255,0.45)' : '#f2f6ff';

  ctx.lineCap = 'round';
  ctx.strokeStyle = ink;
  ctx.lineWidth = Math.max(1, s * 0.05);

  // Hour hand, pointing up
  ctx.beginPath();
  ctx.moveTo(centre, centre);
  ctx.lineTo(centre, centre - s * 0.145);
  ctx.stroke();

  // Minute hand, to the lower right — the two-o'clock shape reads as "a clock"
  // faster than any other pairing at small sizes.
  ctx.beginPath();
  ctx.moveTo(centre, centre);
  ctx.lineTo(centre + s * 0.125, centre + s * 0.075);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(centre, centre, Math.max(1, s * 0.045), 0, Math.PI * 2);
  ctx.fillStyle = ink;
  ctx.fill();
}

/** roundRect polyfill path — OffscreenCanvas support varies by context. */
function roundRect(ctx, x, y, width, height, radius) {
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  const r = Math.min(radius, width / 2, height / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}
