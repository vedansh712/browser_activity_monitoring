/**
 * HTML construction utilities.
 *
 * Design rationale
 * ────────────────
 * The previous approach — remembering to call escapeHtml() at each
 * interpolation site — failed exactly as that approach always fails: the popup
 * and dashboard escaped their output, the options page did not, and nothing
 * flagged the difference.
 *
 * So escaping is inverted to be the default. Markup is built with the html``
 * tag, which escapes every interpolated value automatically. Emitting raw
 * markup requires the explicitly-named unsafeHtml(), which is greppable and
 * reviewable. render() refuses anything that is not SafeHtml, so a plain
 * string containing user input cannot reach innerHTML by accident.
 *
 * This is a deliberate abstraction: it converts a recurring discipline problem
 * into a type problem that the code enforces on its own.
 */

const ESCAPE_MAP = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

const ESCAPE_PATTERN = /[&<>"']/g;

/**
 * Escape a value for interpolation into HTML text or a quoted attribute.
 * Quotes are escaped, so `attr="${escapeHtml(v)}"` cannot break out of the
 * attribute.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(ESCAPE_PATTERN, (char) => ESCAPE_MAP[char]);
}

/**
 * Markup that is known to be safe to insert as-is.
 * Constructed only by html`` and unsafeHtml().
 */
export class SafeHtml {
  #value;

  constructor(value) {
    this.#value = String(value);
  }

  toString() {
    return this.#value;
  }
}

function interpolate(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.toString();
  // Arrays compose naturally: rows.map(row => html`...`) needs no join().
  if (Array.isArray(value)) return value.map(interpolate).join('');
  return escapeHtml(value);
}

/**
 * Tagged template that escapes every interpolated value.
 *
 * @example
 *   render(el, html`<span title="${userInput}">${userInput}</span>`);
 *
 * @returns {SafeHtml}
 */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += interpolate(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

/**
 * Mark a string as trusted markup. Use only for markup this code generated;
 * never for anything derived from stored or user-supplied data.
 *
 * @returns {SafeHtml}
 */
export function unsafeHtml(value) {
  return new SafeHtml(value);
}

/**
 * Replace an element's contents with trusted markup.
 *
 * @param {Element} element
 * @param {SafeHtml} content
 * @throws {TypeError} if content is not SafeHtml
 */
export function render(element, content) {
  if (!element) throw new TypeError('render() requires a target element');
  if (!(content instanceof SafeHtml)) {
    throw new TypeError('render() requires SafeHtml — build markup with the html`` tag');
  }
  element.innerHTML = content.toString();
}

const CSS_HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Validate a colour before it is interpolated into a style attribute.
 *
 * Escaping alone is not sufficient for CSS contexts: it prevents breaking out
 * of the attribute, but a stored value could still inject additional CSS
 * declarations. Category colours come from a colour picker and are persisted,
 * so they are validated against an allowlist on the way out.
 *
 * @param {*} value
 * @param {string} fallback
 * @returns {string} a safe CSS colour literal
 */
export function cssColor(value, fallback = '#9E9E9E') {
  return typeof value === 'string' && CSS_HEX_COLOR.test(value) ? value : fallback;
}
