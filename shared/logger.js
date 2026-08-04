import { LOG_LEVEL } from './constants.js';

/**
 * Leveled logger.
 *
 * Replaces unconditional console.log calls, which in this project were logging
 * page titles and video titles to the console on every navigation — a privacy
 * leak into a surface the user does not expect to contain their history, and
 * noise that buries genuine errors.
 *
 * The level is a module-level singleton rather than per-logger state so that a
 * single settings change takes effect everywhere without re-wiring callers.
 */

const LEVELS = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

let threshold = LEVELS[LOG_LEVEL] ?? LEVELS.warn;

/**
 * Set the global log threshold. Unknown levels are ignored rather than throwing,
 * because a bad value in persisted settings must not break logging itself.
 *
 * @param {'silent'|'error'|'warn'|'info'|'debug'} level
 * @returns {boolean} whether the level was applied
 */
export function setLogLevel(level) {
  if (!Object.prototype.hasOwnProperty.call(LEVELS, level)) return false;
  threshold = LEVELS[level];
  return true;
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === threshold) ?? 'warn';
}

/**
 * Create a scoped logger.
 *
 * @param {string} scope - subsystem name, shown in the log prefix
 * @param {Console} [sink] - injected for testability; defaults to the console
 */
export function createLogger(scope, sink = console) {
  const prefix = scope ? `[Track Daily :: ${scope}]` : '[Track Daily]';

  const emit = (level, method) => (...args) => {
    if (threshold < LEVELS[level]) return;
    // Bound at call time so a test can swap the sink between calls.
    const fn = typeof sink[method] === 'function' ? sink[method] : sink.log;
    fn.call(sink, prefix, ...args);
  };

  return Object.freeze({
    error: emit('error', 'error'),
    warn: emit('warn', 'warn'),
    info: emit('info', 'info'),
    debug: emit('debug', 'debug'),
  });
}
