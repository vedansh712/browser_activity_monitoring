import test from 'node:test';
import assert from 'node:assert/strict';

import { AggregateService } from '../background/aggregate-service.js';
import { buildAggregate } from '../shared/data-models.js';

const MINUTE = 60_000;
const TODAY = '2026-06-15';
// Midday avoids any ambiguity around DST shifts at the day boundary.
const FIXED_CLOCK = () => new Date(2026, 5, 15, 12, 0, 0);

/**
 * In-memory AggregateStore double.
 *
 * The service depends on the store abstraction rather than IndexedDB, so the
 * caching policy can be exercised exhaustively with no browser and no fakes for
 * the database itself. Call counters let the tests assert on cache behaviour
 * rather than just on returned values.
 */
function createFakeStore({ sessionsByDate = {}, aggregates = {} } = {}) {
  const calls = { getAggregate: 0, saveAggregate: 0, getSessionsByDate: 0, countSessionsByDate: 0 };
  const saved = new Map(Object.entries(aggregates));

  return {
    calls,
    saved,
    async getAggregate(date) {
      calls.getAggregate++;
      return saved.get(date) ?? null;
    },
    async saveAggregate(aggregate) {
      calls.saveAggregate++;
      saved.set(aggregate.date, aggregate);
    },
    async getSessionsByDate(date) {
      calls.getSessionsByDate++;
      return sessionsByDate[date] ?? [];
    },
    async countSessionsByDate(date) {
      calls.countSessionsByDate++;
      return (sessionsByDate[date] ?? []).length;
    },
  };
}

function session(date, duration, domain = 'a.com') {
  return {
    date, domain, duration, categoryId: 'news', isActive: false,
    url: `https://${domain}/${duration}`, title: 't',
  };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function createService(store, overrides = {}) {
  return new AggregateService({
    store,
    buildAggregate,
    clock: FIXED_CLOCK,
    logger: silentLogger,
    ...overrides,
  });
}

// ─── Construction ──────────────────────────────────────────────────

test('constructor rejects a missing store', () => {
  assert.throws(() => new AggregateService({ buildAggregate }), TypeError);
});

test('constructor rejects a missing builder', () => {
  assert.throws(() => new AggregateService({ store: createFakeStore() }), TypeError);
});

// ─── Input validation ──────────────────────────────────────────────

test('getForDate rejects malformed date keys', async () => {
  const service = createService(createFakeStore());
  for (const bad of ['15-06-2026', '2026-6-15', 'today', '', null, undefined, 42]) {
    await assert.rejects(() => service.getForDate(bad), TypeError, `should reject ${bad}`);
  }
});

test('getForDate rejects dates that match the shape but do not exist', async () => {
  const service = createService(createFakeStore());
  await assert.rejects(() => service.getForDate('2026-02-30'), TypeError);
  await assert.rejects(() => service.getForDate('2026-13-01'), TypeError);
});

test('getForRange rejects malformed bounds', async () => {
  const service = createService(createFakeStore());
  await assert.rejects(() => service.getForRange('nope', '2026-06-15'), TypeError);
  await assert.rejects(() => service.getForRange('2026-06-15', 'nope'), TypeError);
});

test('getForRange returns empty when the range is inverted', async () => {
  const service = createService(createFakeStore());
  assert.deepEqual(await service.getForRange('2026-06-15', '2026-06-01'), []);
});

// ─── The core bug: missing days must not vanish ────────────────────

test('a day with sessions but no cached aggregate is rebuilt, not skipped', async () => {
  // This is the regression: the old code returned only persisted aggregates,
  // so a day whose aggregate was never written disappeared from the dashboard.
  const store = createFakeStore({
    sessionsByDate: { '2026-06-10': [session('2026-06-10', 5 * MINUTE)] },
    aggregates: {},
  });
  const service = createService(store);

  const agg = await service.getForDate('2026-06-10');

  assert.equal(agg.totalTime, 5 * MINUTE);
  assert.equal(agg.sessionCount, 1);
  assert.equal(store.calls.saveAggregate, 1, 'rebuilt aggregate should be persisted');
});

test('a stale cached aggregate is detected and rebuilt', async () => {
  // Aggregate written at 23:00 recorded 1 session; 2 more arrived afterwards.
  const store = createFakeStore({
    sessionsByDate: {
      '2026-06-10': [
        session('2026-06-10', 5 * MINUTE),
        session('2026-06-10', 3 * MINUTE),
        session('2026-06-10', 2 * MINUTE),
      ],
    },
    aggregates: {
      '2026-06-10': { date: '2026-06-10', totalTime: 5 * MINUTE, sessionCount: 1 },
    },
  });
  const service = createService(store);

  const agg = await service.getForDate('2026-06-10');

  assert.equal(agg.sessionCount, 3);
  assert.equal(agg.totalTime, 10 * MINUTE);
  assert.equal(store.calls.saveAggregate, 1);
});

test('a valid cached aggregate is served without touching sessions', async () => {
  const store = createFakeStore({
    sessionsByDate: { '2026-06-10': [session('2026-06-10', 5 * MINUTE)] },
    aggregates: {
      '2026-06-10': { date: '2026-06-10', totalTime: 5 * MINUTE, sessionCount: 1 },
    },
  });
  const service = createService(store);

  const agg = await service.getForDate('2026-06-10');

  assert.equal(agg.totalTime, 5 * MINUTE);
  assert.equal(store.calls.getSessionsByDate, 0, 'should not deserialise sessions on a cache hit');
  assert.equal(store.calls.saveAggregate, 0, 'should not rewrite a valid cache entry');
});

test('today is always rebuilt because it is still accumulating', async () => {
  const store = createFakeStore({
    sessionsByDate: { [TODAY]: [session(TODAY, 7 * MINUTE)] },
    aggregates: { [TODAY]: { date: TODAY, totalTime: 0, sessionCount: 1 } },
  });
  const service = createService(store);

  const agg = await service.getForDate(TODAY);

  assert.equal(agg.totalTime, 7 * MINUTE, 'stale same-count cache must not be trusted for today');
  assert.equal(store.calls.getSessionsByDate, 1);
});

test('a day with no sessions returns an empty aggregate without persisting a row', async () => {
  const store = createFakeStore();
  const service = createService(store);

  const agg = await service.getForDate('2026-06-09');

  assert.equal(agg.totalTime, 0);
  assert.equal(agg.sessionCount, 0);
  assert.equal(agg.date, '2026-06-09');
  assert.equal(store.calls.saveAggregate, 0, 'idle days must not accumulate rows');
});

// ─── Ranges ────────────────────────────────────────────────────────

test('getForRange returns one entry per day including empty days', async () => {
  const store = createFakeStore({
    sessionsByDate: {
      '2026-06-01': [session('2026-06-01', MINUTE)],
      '2026-06-03': [session('2026-06-03', 2 * MINUTE)],
    },
  });
  const service = createService(store);

  const range = await service.getForRange('2026-06-01', '2026-06-03');

  assert.equal(range.length, 3, 'gaps must be represented, not omitted');
  assert.deepEqual(range.map((a) => a.date), ['2026-06-01', '2026-06-02', '2026-06-03']);
  assert.equal(range[1].totalTime, 0);
  assert.equal(range[2].totalTime, 2 * MINUTE);
});

test('getForRange spans month boundaries', async () => {
  const store = createFakeStore();
  const service = createService(store);
  const range = await service.getForRange('2026-05-30', '2026-06-02');
  assert.deepEqual(range.map((a) => a.date), ['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02']);
});

// ─── Concurrency ───────────────────────────────────────────────────

test('concurrent reads of the same day coalesce into one rebuild', async () => {
  // A dashboard opening fires overlapping range queries in the same tick.
  // Without single-flight these race and duplicate the work.
  const store = createFakeStore({
    sessionsByDate: { '2026-06-10': [session('2026-06-10', MINUTE)] },
  });
  const service = createService(store);

  const results = await Promise.all([
    service.getForDate('2026-06-10'),
    service.getForDate('2026-06-10'),
    service.getForDate('2026-06-10'),
  ]);

  assert.equal(store.calls.getSessionsByDate, 1, 'rebuild should happen exactly once');
  assert.equal(store.calls.saveAggregate, 1);
  assert.equal(results[0], results[1], 'callers should share the same result');
  assert.equal(results[1], results[2]);
});

test('a failed rebuild is not cached and can be retried', async () => {
  let shouldFail = true;
  const store = createFakeStore({
    sessionsByDate: { '2026-06-10': [session('2026-06-10', MINUTE)] },
  });
  const original = store.getSessionsByDate.bind(store);
  store.getSessionsByDate = async (date) => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error('transient database error');
    }
    return original(date);
  };
  const service = createService(store);

  await assert.rejects(() => service.getForDate('2026-06-10'), /transient database error/);

  // The in-flight entry must have been released, so a retry actually runs.
  const agg = await service.getForDate('2026-06-10');
  assert.equal(agg.totalTime, MINUTE);
});

// ─── refreshRecent ─────────────────────────────────────────────────

test('refreshRecent rebuilds the trailing window', async () => {
  const store = createFakeStore({
    sessionsByDate: {
      '2026-06-14': [session('2026-06-14', MINUTE)],
      '2026-06-15': [session('2026-06-15', 2 * MINUTE)],
    },
  });
  const service = createService(store);

  const refreshed = await service.refreshRecent(2);

  assert.equal(refreshed.length, 2);
  assert.deepEqual(refreshed.map((a) => a.date), ['2026-06-14', '2026-06-15']);
});

test('refreshRecent skips days with no sessions', async () => {
  const store = createFakeStore();
  const service = createService(store);

  assert.deepEqual(await service.refreshRecent(2), []);
  assert.equal(store.calls.saveAggregate, 0);
});

test('refreshRecent derives its window from the injected clock only', async () => {
  // Regression guard: refreshRecent originally called new Date() directly,
  // bypassing the injected clock. That made its window untestable and coupled
  // the class to ambient time.
  const store = createFakeStore({
    sessionsByDate: {
      '2030-01-01': [session('2030-01-01', MINUTE)],
      '2030-01-02': [session('2030-01-02', MINUTE)],
    },
  });
  const service = createService(store, { clock: () => new Date(2030, 0, 2, 12) });

  const refreshed = await service.refreshRecent(2);

  assert.deepEqual(refreshed.map((a) => a.date), ['2030-01-01', '2030-01-02']);
});

test('refreshRecent falls back to the configured default for invalid input', async () => {
  const store = createFakeStore({
    sessionsByDate: { '2026-06-15': [session('2026-06-15', MINUTE)] },
  });
  const service = createService(store);

  for (const bad of [0, -3, 2.5, 'two', null]) {
    store.calls.saveAggregate = 0;
    const refreshed = await service.refreshRecent(bad);
    assert.ok(refreshed.length >= 1, `should still refresh for ${bad}`);
  }
});

test('refreshRecent continues past a failing day', async () => {
  const store = createFakeStore({
    sessionsByDate: {
      '2026-06-14': [session('2026-06-14', MINUTE)],
      '2026-06-15': [session('2026-06-15', MINUTE)],
    },
  });
  store.countSessionsByDate = async (date) => {
    if (date === '2026-06-14') throw new Error('boom');
    return 1;
  };
  const service = createService(store);

  const refreshed = await service.refreshRecent(2);

  assert.equal(refreshed.length, 1, 'the healthy day should still be refreshed');
  assert.equal(refreshed[0].date, '2026-06-15');
});
