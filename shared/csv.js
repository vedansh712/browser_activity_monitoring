/**
 * RFC 4180 CSV serialisation with spreadsheet formula-injection defence.
 */

// A leading =, +, -, @, tab or CR makes Excel, LibreOffice and Sheets treat the
// cell as a formula. Exported values include page titles, which are attacker-
// influenced: any site can set a title of =HYPERLINK(...) or a DDE payload that
// executes when the user opens their own export. OWASP calls this CSV Injection.
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

// Quoting is required for these per RFC 4180.
const NEEDS_QUOTING = /[",\r\n]/;

/**
 * Escape a single CSV field.
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeCsvField(value) {
  let field = value === null || value === undefined ? '' : String(value);

  // Neutralise the formula before quoting, so the guard survives inside quotes.
  if (FORMULA_TRIGGER.test(field)) {
    field = `'${field}`;
  }

  if (NEEDS_QUOTING.test(field)) {
    field = `"${field.replace(/"/g, '""')}"`;
  }

  return field;
}

/**
 * Serialise rows to CSV.
 *
 * @param {string[]} headers
 * @param {Array<Array<*>>} rows
 * @param {Object}  [options]
 * @param {boolean} [options.bom=true] - prepend a UTF-8 BOM so Excel reads
 *   non-ASCII titles correctly instead of mojibake
 * @returns {string}
 */
export function toCsv(headers, rows, { bom = true } = {}) {
  if (!Array.isArray(headers)) throw new TypeError('toCsv requires a headers array');
  if (!Array.isArray(rows)) throw new TypeError('toCsv requires a rows array');

  const lines = [headers.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push((row ?? []).map(escapeCsvField).join(','));
  }

  // RFC 4180 specifies CRLF line endings.
  return (bom ? '﻿' : '') + lines.join('\r\n');
}
