import {
  DB_NAME,
  DB_VERSION,
  STORES,
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_CATEGORIES,
  REMOVED_SETTINGS_KEYS,
} from '../shared/constants.js';
import { formatDate, isValidDateKey } from '../shared/utils.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('storage');

/*
 * Infrastructure layer: the only module that knows about IndexedDB and
 * chrome.storage. Everything above it depends on the shape of these functions,
 * never on the storage technology.
 */

// ─── IndexedDB Setup ───────────────────────────────────────────────

/**
 * Cached connection *promise*, not the connection itself.
 *
 * Caching the resolved handle instead would let concurrent callers each start
 * their own indexedDB.open() before the first resolved — a real race in a
 * service worker, where several events can be handled in the same tick.
 */
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
        const sessionStore = database.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
        sessionStore.createIndex('date', 'date', { unique: false });
        sessionStore.createIndex('domain', 'domain', { unique: false });
        sessionStore.createIndex('categoryId', 'categoryId', { unique: false });
      }

      if (!database.objectStoreNames.contains(STORES.AGGREGATES)) {
        database.createObjectStore(STORES.AGGREGATES, { keyPath: 'date' });
      }

      if (!database.objectStoreNames.contains(STORES.SIMILARITY)) {
        const simStore = database.createObjectStore(STORES.SIMILARITY, { keyPath: 'id' });
        simStore.createIndex('categoryId', 'categoryId', { unique: false });
        simStore.createIndex('domain', 'domain', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      const database = event.target.result;
      // Drop the cached promise if the connection dies so the next call reopens.
      database.onclose = () => { dbPromise = null; };
      database.onversionchange = () => {
        database.close();
        dbPromise = null;
      };
      resolve(database);
    };

    request.onerror = () => {
      dbPromise = null; // allow retry
      reject(request.error);
    };

    request.onblocked = () => {
      log.warn('Database upgrade blocked by another connection');
    };
  });

  return dbPromise;
}

/**
 * Run a single IndexedDB request inside its own transaction.
 *
 * The transaction is created and used synchronously inside the executor. This
 * matters: an IndexedDB transaction becomes inactive once control returns to
 * the event loop, so creating it before an `await` and using it afterwards
 * throws TransactionInactiveError under load. Keeping creation and use in one
 * synchronous block makes that impossible by construction.
 *
 * @param {string} storeName
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} operation
 */
async function runRequest(storeName, mode, operation) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    let request;
    try {
      const tx = database.transaction(storeName, mode);
      tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
      request = operation(tx.objectStore(storeName));
    } catch (err) {
      reject(err);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const read = (storeName, operation) => runRequest(storeName, 'readonly', operation);
const write = (storeName, operation) => runRequest(storeName, 'readwrite', operation);

/**
 * Assert a date key is well-formed before it reaches IndexedDB.
 * @throws {TypeError}
 */
function assertDateKey(value, label = 'date') {
  if (!isValidDateKey(value)) {
    throw new TypeError(`Invalid ${label}: expected YYYY-MM-DD, received ${JSON.stringify(value)}`);
  }
}

// ─── Session Operations (IndexedDB) ────────────────────────────────

export async function saveSession(session) {
  if (!session?.id) throw new TypeError('saveSession requires a session with an id');
  return write(STORES.SESSIONS, (store) => store.put(session));
}

export async function getSessionsByDate(dateStr) {
  assertDateKey(dateStr);
  return read(STORES.SESSIONS, (store) => store.index('date').getAll(dateStr));
}

/**
 * Count sessions for a date without deserialising them.
 *
 * Used to detect a stale aggregate cheaply: IDBIndex.count() reads index
 * entries only, so this stays O(matching keys) with no record decoding.
 */
export async function countSessionsByDate(dateStr) {
  assertDateKey(dateStr);
  return read(STORES.SESSIONS, (store) => store.index('date').count(dateStr));
}

/**
 * All sessions in an inclusive date range.
 *
 * One key-range scan rather than one query per day: the previous
 * implementation issued 31 sequential round-trips to render a monthly view.
 * Date keys are zero-padded YYYY-MM-DD, so lexicographic order matches
 * chronological order and IDBKeyRange.bound is safe.
 */
export async function getSessionsForDateRange(startDate, endDate) {
  assertDateKey(startDate, 'startDate');
  assertDateKey(endDate, 'endDate');
  if (startDate > endDate) return [];

  return read(STORES.SESSIONS, (store) =>
    store.index('date').getAll(IDBKeyRange.bound(startDate, endDate))
  );
}

// ─── Aggregate Operations (IndexedDB) ──────────────────────────────

export async function saveAggregate(aggregate) {
  assertDateKey(aggregate?.date, 'aggregate.date');
  return write(STORES.AGGREGATES, (store) => store.put(aggregate));
}

export async function getAggregate(dateStr) {
  assertDateKey(dateStr);
  const result = await read(STORES.AGGREGATES, (store) => store.get(dateStr));
  return result ?? null;
}

// ─── Similarity Data (IndexedDB) ───────────────────────────────────

export async function saveSimilarityEntry(entry) {
  if (!entry?.id) throw new TypeError('saveSimilarityEntry requires an entry with an id');
  return write(STORES.SIMILARITY, (store) => store.put(entry));
}

export async function getAllSimilarityData() {
  return read(STORES.SIMILARITY, (store) => store.getAll());
}

// ─── Current Session (chrome.storage.session) ──────────────────────

export async function getCurrentSession() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.CURRENT_SESSION);
  return result[STORAGE_KEYS.CURRENT_SESSION] || null;
}

export async function setCurrentSession(session) {
  return chrome.storage.session.set({ [STORAGE_KEYS.CURRENT_SESSION]: session });
}

export async function clearCurrentSession() {
  return chrome.storage.session.remove(STORAGE_KEYS.CURRENT_SESSION);
}

// ─── Tracking State (chrome.storage.session) ───────────────────────

export async function getTrackingState() {
  const result = await chrome.storage.session.get(STORAGE_KEYS.TRACKING_STATE);
  return result[STORAGE_KEYS.TRACKING_STATE] || 'active';
}

export async function setTrackingState(state) {
  return chrome.storage.session.set({ [STORAGE_KEYS.TRACKING_STATE]: state });
}

// ─── Settings (chrome.storage.local) ───────────────────────────────

export async function getSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
}

export async function saveSettings(settings) {
  return chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

// ─── Categories (chrome.storage.local) ─────────────────────────────

export async function getCategories() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
  const stored = result[STORAGE_KEYS.CATEGORIES];
  if (stored) return stored;

  const initial = {
    builtIn: DEFAULT_CATEGORIES,
    custom: [],
    domainOverrides: {},
    channelOverrides: {},
  };
  await saveCategories(initial);
  return initial;
}

export async function saveCategories(categories) {
  return chrome.storage.local.set({ [STORAGE_KEYS.CATEGORIES]: categories });
}

/**
 * Serialises category writes within this context.
 *
 * chrome.storage has no transactions, so every category mutation is a
 * read-modify-write. Chaining them prevents two concurrent mutations in the
 * same context from reading the same snapshot and one overwriting the other.
 *
 * Limitation, stated explicitly: this does not serialise across contexts (the
 * options page and the service worker are separate JavaScript realms). It
 * narrows the window from the lifetime of a page to a single operation, which
 * eliminates the failure that actually occurred — the options page holding a
 * snapshot for minutes and writing the whole blob back on Save, discarding
 * anything the worker had classified in the meantime.
 */
let categoryWriteQueue = Promise.resolve();

/**
 * Apply a mutation to the stored categories as a queued read-modify-write.
 *
 * @param {(categories: Object) => Object|void} mutate - mutates in place or returns a replacement
 * @returns {Promise<Object>} the persisted categories
 */
export function updateCategories(mutate) {
  if (typeof mutate !== 'function') {
    return Promise.reject(new TypeError('updateCategories requires a mutator function'));
  }

  const task = categoryWriteQueue.then(async () => {
    const current = await getCategories();
    const next = mutate(current) ?? current;
    await saveCategories(next);
    return next;
  });

  // Keep the chain alive after a rejection so one failure can't wedge the queue.
  categoryWriteQueue = task.then(
    () => undefined,
    () => undefined
  );
  return task;
}

export async function addDomainOverride(domain, categoryId) {
  return updateCategories((categories) => {
    categories.domainOverrides[domain] = categoryId;
  });
}

export async function removeDomainOverride(domain) {
  return updateCategories((categories) => {
    delete categories.domainOverrides[domain];
  });
}

export async function addCustomCategory(category) {
  if (!category?.id) throw new TypeError('addCustomCategory requires a category with an id');
  return updateCategories((categories) => {
    categories.custom = [...(categories.custom || []), category];
  });
}

export async function removeCustomCategory(categoryId) {
  return updateCategories((categories) => {
    categories.custom = (categories.custom || []).filter((c) => c.id !== categoryId);
  });
}

// ─── Data Retention ────────────────────────────────────────────────

export async function pruneOldData(retentionDays) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) {
    throw new TypeError(`pruneOldData requires a positive retention period, got ${retentionDays}`);
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = formatDate(cutoff);
  const range = IDBKeyRange.upperBound(cutoffStr, true);

  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORES.SESSIONS, STORES.AGGREGATES], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Prune transaction aborted'));

    const deleteMatching = (request) => {
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
    };

    deleteMatching(tx.objectStore(STORES.SESSIONS).index('date').openCursor(range));
    deleteMatching(tx.objectStore(STORES.AGGREGATES).openCursor(range));
  });
}

// ─── Wipe Operations ───────────────────────────────────────────────

/**
 * Clear all browsing history (sessions, aggregates, similarity data).
 * Keeps settings, categories, and domain overrides.
 */
export async function clearBrowsingHistory() {
  const database = await openDB();

  await new Promise((resolve, reject) => {
    const tx = database.transaction(
      [STORES.SESSIONS, STORES.AGGREGATES, STORES.SIMILARITY],
      'readwrite'
    );
    tx.objectStore(STORES.SESSIONS).clear();
    tx.objectStore(STORES.AGGREGATES).clear();
    tx.objectStore(STORES.SIMILARITY).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Clear transaction aborted'));
  });

  await clearCurrentSession();
  log.info('Browsing history cleared');
}

/**
 * Reset everything to defaults.
 * Wipes browsing history AND settings, categories, domain overrides.
 */
export async function resetEverything() {
  await clearBrowsingHistory();
  await chrome.storage.local.clear();
  await chrome.storage.session.clear();

  // Re-seed defaults so the next read doesn't race against an empty store
  await getCategories();
  await getSettings();

  log.info('Everything reset to defaults');
}

// ─── Init ──────────────────────────────────────────────────────────

export async function initStorage() {
  await openDB();
  await getCategories();
  await getSettings();
  await purgeRemovedSettings();
}

/**
 * Delete settings belonging to removed features.
 *
 * Specifically the third-party AI credentials. Classification moved on-device,
 * so aiApiKey has no consumer — but merging defaults over stored settings would
 * leave the key sitting in chrome.storage indefinitely. Removing a feature that
 * handled a secret means removing the secret too.
 */
async function purgeRemovedSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = stored[STORAGE_KEYS.SETTINGS];
  if (!settings) return;

  const present = REMOVED_SETTINGS_KEYS.filter((key) => key in settings);
  if (present.length === 0) return;

  for (const key of present) delete settings[key];
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  log.info(`Removed obsolete settings: ${present.join(', ')}`);
}
