import { DB_NAME, DB_VERSION, STORES, STORAGE_KEYS, DEFAULT_SETTINGS, DEFAULT_CATEGORIES } from '../shared/constants.js';
import { formatDate, getDateRange } from '../shared/utils.js';

let db = null;

// ─── IndexedDB Setup ───────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;

      // Sessions store
      if (!database.objectStoreNames.contains(STORES.SESSIONS)) {
        const sessionStore = database.createObjectStore(STORES.SESSIONS, { keyPath: 'id' });
        sessionStore.createIndex('date', 'date', { unique: false });
        sessionStore.createIndex('domain', 'domain', { unique: false });
        sessionStore.createIndex('categoryId', 'categoryId', { unique: false });
      }

      // Aggregates store
      if (!database.objectStoreNames.contains(STORES.AGGREGATES)) {
        database.createObjectStore(STORES.AGGREGATES, { keyPath: 'date' });
      }

      // Similarity data store
      if (!database.objectStoreNames.contains(STORES.SIMILARITY)) {
        const simStore = database.createObjectStore(STORES.SIMILARITY, { keyPath: 'id' });
        simStore.createIndex('categoryId', 'categoryId', { unique: false });
        simStore.createIndex('domain', 'domain', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      db.onclose = () => { db = null; };
      resolve(db);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
  });
}

function getStore(storeName, mode = 'readonly') {
  return openDB().then((database) => {
    const tx = database.transaction(storeName, mode);
    return tx.objectStore(storeName);
  });
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ─── Session Operations (IndexedDB) ────────────────────────────────

export async function saveSession(session) {
  const store = await getStore(STORES.SESSIONS, 'readwrite');
  return idbRequest(store.put(session));
}

export async function getSessionsByDate(dateStr) {
  const store = await getStore(STORES.SESSIONS);
  const index = store.index('date');
  return idbRequest(index.getAll(dateStr));
}

export async function getSessionsForDateRange(startDate, endDate) {
  const dates = getDateRange(startDate, endDate);
  const allSessions = [];
  for (const date of dates) {
    const sessions = await getSessionsByDate(date);
    allSessions.push(...sessions);
  }
  return allSessions;
}

export async function getSessionsByDomain(domain) {
  const store = await getStore(STORES.SESSIONS);
  const index = store.index('domain');
  return idbRequest(index.getAll(domain));
}

// ─── Aggregate Operations (IndexedDB) ──────────────────────────────

export async function saveAggregate(aggregate) {
  const store = await getStore(STORES.AGGREGATES, 'readwrite');
  return idbRequest(store.put(aggregate));
}

export async function getAggregate(dateStr) {
  const store = await getStore(STORES.AGGREGATES);
  return idbRequest(store.get(dateStr));
}

export async function getAggregatesForRange(startDate, endDate) {
  const dates = getDateRange(startDate, endDate);
  const aggregates = [];
  for (const date of dates) {
    const agg = await getAggregate(date);
    if (agg) aggregates.push(agg);
  }
  return aggregates;
}

// ─── Similarity Data (IndexedDB) ───────────────────────────────────

export async function saveSimilarityEntry(entry) {
  const store = await getStore(STORES.SIMILARITY, 'readwrite');
  return idbRequest(store.put(entry));
}

export async function getAllSimilarityData() {
  const store = await getStore(STORES.SIMILARITY);
  return idbRequest(store.getAll());
}

export async function getSimilarityByDomain(domain) {
  const store = await getStore(STORES.SIMILARITY);
  const index = store.index('domain');
  return idbRequest(index.getAll(domain));
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

  // Initialize with defaults
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

export async function addDomainOverride(domain, categoryId) {
  const categories = await getCategories();
  categories.domainOverrides[domain] = categoryId;
  await saveCategories(categories);
}

export async function addChannelOverride(channelName, categoryId) {
  const categories = await getCategories();
  categories.channelOverrides[channelName] = categoryId;
  await saveCategories(categories);
}

// ─── Data Retention ────────────────────────────────────────────────

export async function pruneOldData(retentionDays) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffStr = formatDate(cutoffDate);

  // Prune sessions
  const database = await openDB();
  const tx = database.transaction([STORES.SESSIONS, STORES.AGGREGATES], 'readwrite');

  const sessionStore = tx.objectStore(STORES.SESSIONS);
  const dateIndex = sessionStore.index('date');
  const range = IDBKeyRange.upperBound(cutoffStr, true);

  const cursorRequest = dateIndex.openCursor(range);
  cursorRequest.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  // Prune aggregates
  const aggStore = tx.objectStore(STORES.AGGREGATES);
  const aggRange = IDBKeyRange.upperBound(cutoffStr, true);
  const aggCursor = aggStore.openCursor(aggRange);
  aggCursor.onsuccess = (event) => {
    const cursor = event.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
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
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });

  // Also clear the live session
  await clearCurrentSession();

  console.log('[Track Daily] Browsing history cleared');
}

/**
 * Reset everything to defaults.
 * Wipes browsing history AND settings, categories, domain overrides.
 */
export async function resetEverything() {
  // 1. Wipe IndexedDB
  await clearBrowsingHistory();

  // 2. Wipe all chrome.storage.local
  await chrome.storage.local.clear();

  // 3. Wipe all chrome.storage.session
  await chrome.storage.session.clear();

  // 4. Re-initialize defaults
  await getCategories();
  await getSettings();

  console.log('[Track Daily] Everything reset to defaults');
}

// ─── Init ──────────────────────────────────────────────────────────

export async function initStorage() {
  await openDB();
  await getCategories(); // ensure defaults are set
  await getSettings();   // ensure defaults are set
}
