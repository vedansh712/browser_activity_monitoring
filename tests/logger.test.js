import test from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, setLogLevel, getLogLevel } from '../shared/logger.js';
import { isValidDateKey } from '../shared/utils.js';

function createSink() {
  const calls = [];
  const record = (level) => (...args) => calls.push({ level, args });
  return {
    calls,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    log: record('log'),
  };
}

test.afterEach(() => setLogLevel('warn'));

test('messages below the threshold are suppressed', () => {
  setLogLevel('warn');
  const sink = createSink();
  const log = createLogger('test', sink);

  log.error('e');
  log.warn('w');
  log.info('i');
  log.debug('d');

  assert.deepEqual(sink.calls.map((c) => c.level), ['error', 'warn']);
});

test('raising the level lets quieter messages through', () => {
  setLogLevel('debug');
  const sink = createSink();
  const log = createLogger('test', sink);

  log.info('i');
  log.debug('d');

  assert.deepEqual(sink.calls.map((c) => c.level), ['info', 'debug']);
});

test('silent suppresses everything including errors', () => {
  setLogLevel('silent');
  const sink = createSink();
  createLogger('test', sink).error('boom');
  assert.equal(sink.calls.length, 0);
});

test('log output is prefixed with its scope', () => {
  setLogLevel('warn');
  const sink = createSink();
  createLogger('storage', sink).warn('disk full', 42);
  assert.deepEqual(sink.calls[0].args, ['[Track Daily :: storage]', 'disk full', 42]);
});

test('an unscoped logger still carries the project prefix', () => {
  setLogLevel('warn');
  const sink = createSink();
  createLogger('', sink).warn('x');
  assert.equal(sink.calls[0].args[0], '[Track Daily]');
});

test('an invalid level is rejected without changing the threshold', () => {
  setLogLevel('info');
  assert.equal(setLogLevel('verbose'), false);
  assert.equal(getLogLevel(), 'info');
});

test('a valid level reports success', () => {
  assert.equal(setLogLevel('error'), true);
  assert.equal(getLogLevel(), 'error');
});

test('setLogLevel ignores prototype keys', () => {
  setLogLevel('warn');
  assert.equal(setLogLevel('toString'), false);
  assert.equal(getLogLevel(), 'warn');
});

// ─── Date key validation ───────────────────────────────────────────

test('isValidDateKey accepts well-formed real dates', () => {
  for (const good of ['2026-01-01', '2026-12-31', '2028-02-29']) {
    assert.equal(isValidDateKey(good), true, `${good} should be valid`);
  }
});

test('isValidDateKey rejects shapes that are not real dates', () => {
  for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2027-02-29']) {
    assert.equal(isValidDateKey(bad), false, `${bad} should be invalid`);
  }
});

test('isValidDateKey rejects wrong formats and non-strings', () => {
  for (const bad of ['26-01-01', '2026-1-1', '2026/01/01', '', ' 2026-01-01', null, undefined, 20260101, {}]) {
    assert.equal(isValidDateKey(bad), false, `${JSON.stringify(bad)} should be invalid`);
  }
});
