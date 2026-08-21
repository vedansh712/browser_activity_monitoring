/**
 * Extract the normalized hostname from a URL string.
 *
 * Only http(s) is tracked — an allowlist rather than a blocklist, so chrome:,
 * chrome-extension:, about:, file:, view-source: and every other scheme are
 * excluded without having to enumerate them.
 *
 * The hostname is lowercased and stripped of a leading "www." so that
 * "www.youtube.com" and "youtube.com" aggregate as a single site instead of
 * splitting one domain's time across two rows.
 *
 * Returns empty string for anything untrackable.
 */
export function extractDomain(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * URL for a domain's favicon, served from Chrome's own local favicon cache.
 *
 * Deliberately NOT a third-party service. Fetching icons from something like
 * google.com/s2/favicons would transmit the name of every site the user visits
 * to that third party, with cookies attached, every time the popup or dashboard
 * renders — which would defeat the point of a local-only browsing tracker.
 *
 * Requires the "favicon" permission. Returns '' outside an extension context.
 */
export function faviconUrl(domain, size = 32) {
  if (!domain) return '';
  if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return '';
  const pageUrl = `https://${domain}`;
  return chrome.runtime.getURL(
    `/_favicon/?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`
  );
}

/**
 * Get today's date as YYYY-MM-DD string.
 */
export function todayKey() {
  return formatDate(new Date());
}

/**
 * Format a Date object to YYYY-MM-DD.
 */
export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parse a YYYY-MM-DD string into a Date object (local midnight).
 */
export function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a value is a well-formed YYYY-MM-DD key for a real calendar date.
 *
 * Date keys arrive from the dashboard UI and are used directly as IndexedDB
 * keys and key-range bounds, so they are untrusted input and must be validated
 * at the boundary. The round-trip check rejects values that match the shape but
 * are not real dates ("2026-02-30", "2026-13-01").
 */
export function isValidDateKey(value) {
  if (typeof value !== 'string' || !DATE_KEY_PATTERN.test(value)) return false;
  const parsed = parseDate(value);
  return !Number.isNaN(parsed.getTime()) && formatDate(parsed) === value;
}

/**
 * Get an array of YYYY-MM-DD strings for a date range (inclusive).
 */
export function getDateRange(startDate, endDate) {
  const dates = [];
  const current = new Date(startDate);
  const end = new Date(endDate);
  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Format milliseconds into a human-readable duration string.
 * e.g. 3661000 → "1h 1m"
 */
export function formatDuration(ms) {
  if (ms < 1000) return '0m';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Format milliseconds into HH:MM:SS for precise display.
 */
export function formatDurationPrecise(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((v) => String(v).padStart(2, '0'))
    .join(':');
}

/**
 * Coerce a value to an integer within [min, max], falling back when it is not
 * a usable number. Used to validate numeric settings on the way into storage.
 *
 * @param {*} value
 * @param {{min: number, max: number, fallback: number}} bounds
 * @returns {number}
 */
export function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Generate a unique ID.
 */
export function generateId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Tokenize a string into lowercase words (for similarity matching).
 * Strips common stop words and short words.
 */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'and', 'but', 'or', 'not', 'no', 'nor', 'so',
  'yet', 'both', 'either', 'neither', 'each', 'every', 'all', 'any',
  'this', 'that', 'these', 'those', 'it', 'its', 'you', 'your', 'we',
  'our', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'my',
  'me', 'i', 'www', 'com', 'org', 'net', 'http', 'https',
]);

export function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Compute Jaccard similarity between two arrays of tokens.
 * Returns 0..1 (1 = identical).
 */
export function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Debounce a function call.
 */
export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
