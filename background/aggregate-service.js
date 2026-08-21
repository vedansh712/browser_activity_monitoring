import { getDateRange, isValidDateKey, formatDate } from '../shared/utils.js';
import { AGGREGATE_REFRESH_DAYS } from '../shared/constants.js';

/**
 * @typedef {Object} AggregateStore
 * @property {(date: string) => Promise<Object|null>} getAggregate
 * @property {(aggregate: Object) => Promise<*>}      saveAggregate
 * @property {(date: string) => Promise<Object[]>}    getSessionsByDate
 * @property {(date: string) => Promise<number>}      countSessionsByDate
 */

/**
 * Serves daily aggregates, treating them as a derived cache over sessions.
 *
 * Design
 * ──────
 * Sessions are the source of truth; an aggregate is a materialised view of one
 * day. The previous code inverted that — it read only persisted aggregates, so
 * any day whose aggregate was never written simply vanished from the weekly and
 * monthly views, with no error to indicate data was missing.
 *
 * This is therefore a read-through cache with validation. Two properties matter:
 *
 *  1. Absent  → rebuild from sessions and persist.
 *  2. Present but stale → also rebuild. "Present" is not sufficient: an
 *     aggregate written at 23:00 is missing everything after 23:00. Staleness is
 *     detected by comparing the aggregate's recorded sessionCount against a live
 *     count for that date, which is an index-only read and cheap enough to run
 *     on every access.
 *
 * Today is always rebuilt, since it is still accumulating by definition.
 *
 * Dependencies are injected so the policy above can be tested against an
 * in-memory store, with no IndexedDB and no browser.
 */
export class AggregateService {
  /** @type {AggregateStore} */
  #store;
  #buildAggregate;
  #clock;
  #logger;

  /**
   * In-flight rebuilds, keyed by date.
   *
   * A service worker handles many events in the same tick — a dashboard opening
   * fires overlapping range queries. Without coalescing, the same day gets
   * rebuilt N times concurrently and the writes race. This is per-worker-
   * lifetime only, which is sufficient: it is a duplicate-work optimisation,
   * and correctness does not depend on it because rebuilds are idempotent.
   *
   * @type {Map<string, Promise<Object>>}
   */
  #inFlight = new Map();

  /**
   * @param {Object}         deps
   * @param {AggregateStore} deps.store
   * @param {(date: string, sessions: Object[]) => Object} deps.buildAggregate
   * @param {() => Date}    [deps.clock]  - sole source of current time
   * @param {Object}        [deps.logger]
   */
  constructor({ store, buildAggregate, clock = () => new Date(), logger = console }) {
    if (!store) throw new TypeError('AggregateService requires a store');
    if (typeof buildAggregate !== 'function') {
      throw new TypeError('AggregateService requires a buildAggregate function');
    }
    this.#store = store;
    this.#buildAggregate = buildAggregate;
    this.#clock = clock;
    this.#logger = logger;
  }

  /**
   * Today's date key.
   *
   * Every time-dependent decision in this class routes through #clock, so the
   * class has no hidden dependency on the ambient clock and its date-window
   * logic is fully testable.
   */
  #todayKey() {
    return formatDate(this.#clock());
  }

  /**
   * Aggregate for a single day, rebuilding from sessions when the cached copy
   * is missing or stale.
   *
   * @param {string} date - YYYY-MM-DD
   * @returns {Promise<Object>} always an aggregate, never null
   */
  async getForDate(date) {
    if (!isValidDateKey(date)) {
      throw new TypeError(`getForDate expects YYYY-MM-DD, received ${JSON.stringify(date)}`);
    }

    // Today is still accumulating, so a cached copy is stale by construction.
    if (date === this.#todayKey()) {
      return this.#rebuild(date);
    }

    const [cached, liveCount] = await Promise.all([
      this.#store.getAggregate(date),
      this.#store.countSessionsByDate(date),
    ]);

    if (cached && cached.sessionCount === liveCount) {
      return cached;
    }

    // Nothing recorded for this day. Return an empty aggregate without
    // persisting it, so days the user did not browse don't accumulate rows.
    if (liveCount === 0) {
      return this.#buildAggregate(date, []);
    }

    if (cached) {
      this.#logger.info?.(
        `Rebuilding stale aggregate for ${date} (cached ${cached.sessionCount} of ${liveCount} sessions)`
      );
    }
    return this.#rebuild(date);
  }

  /**
   * Aggregates for an inclusive date range, one entry per day in order.
   *
   * Days with no activity are included as empty aggregates rather than omitted,
   * so callers can render a continuous timeline without reconstructing gaps.
   *
   * @param {string} startDate - YYYY-MM-DD
   * @param {string} endDate   - YYYY-MM-DD
   * @returns {Promise<Object[]>}
   */
  async getForRange(startDate, endDate) {
    if (!isValidDateKey(startDate)) {
      throw new TypeError(`getForRange expects a valid startDate, received ${JSON.stringify(startDate)}`);
    }
    if (!isValidDateKey(endDate)) {
      throw new TypeError(`getForRange expects a valid endDate, received ${JSON.stringify(endDate)}`);
    }
    if (startDate > endDate) return [];

    const dates = getDateRange(startDate, endDate);
    // Reads are independent; coalescing in #rebuild prevents duplicate work.
    return Promise.all(dates.map((date) => this.getForDate(date)));
  }

  /**
   * Re-derive the trailing window of days.
   *
   * Called from the periodic alarm. Covers the case where a day's last sessions
   * are written after that day's aggregate was last built — including sessions
   * flushed after midnight, which belong to the previous day.
   *
   * @param {number} [days]
   */
  async refreshRecent(days = AGGREGATE_REFRESH_DAYS) {
    const count = Number.isInteger(days) && days > 0 ? days : AGGREGATE_REFRESH_DAYS;
    const anchor = this.#clock();
    const results = [];

    for (let offset = count - 1; offset >= 0; offset--) {
      const day = new Date(anchor);
      day.setDate(anchor.getDate() - offset);
      const date = formatDate(day);
      try {
        results.push(await this.#rebuildIfAnySessions(date));
      } catch (err) {
        // One bad day must not abort the refresh for the others.
        this.#logger.warn?.(`Failed to refresh aggregate for ${date}:`, err?.message ?? err);
      }
    }
    return results.filter(Boolean);
  }

  async #rebuildIfAnySessions(date) {
    const liveCount = await this.#store.countSessionsByDate(date);
    if (liveCount === 0) return null;
    return this.#rebuild(date);
  }

  /**
   * Rebuild one day from its sessions and persist it, coalescing concurrent
   * callers onto a single operation.
   */
  #rebuild(date) {
    const existing = this.#inFlight.get(date);
    if (existing) return existing;

    const task = (async () => {
      const sessions = await this.#store.getSessionsByDate(date);
      const aggregate = this.#buildAggregate(date, sessions);
      await this.#store.saveAggregate(aggregate);
      return aggregate;
    })().finally(() => {
      this.#inFlight.delete(date);
    });

    this.#inFlight.set(date, task);
    return task;
  }
}
