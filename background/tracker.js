import { createSession, endSession, pauseSession } from '../shared/data-models.js';
import { extractDomain, generateId } from '../shared/utils.js';
import * as storage from './storage-manager.js';

/**
 * Start tracking a new session for the given tab.
 * Ends the previous session if one exists.
 */
export async function startNewSession(tab, categoryId) {
  // End current session first
  await endCurrentSession();

  const domain = extractDomain(tab.url);
  if (!domain) return null; // Skip chrome:// and other internal pages

  const session = createSession({
    url: tab.url,
    title: tab.title || '',
    categoryId: categoryId || 'uncategorized',
  });

  await storage.setCurrentSession(session);
  return session;
}

/**
 * End the current active session and save it to IndexedDB.
 * Returns the ended session or null if there wasn't one.
 */
export async function endCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current || !current.isActive) return null;

  const ended = endSession(current);

  // Only save sessions longer than 1 second
  if (ended.duration > 1000) {
    const hasMeta = ended.meta && ended.meta.videoId;
    console.log('[Track Daily] Saving session:', ended.domain,
      '| duration:', Math.round(ended.duration / 1000) + 's',
      '| category:', ended.categoryId,
      '| hasMeta:', !!hasMeta,
      hasMeta ? '| video: ' + ended.meta.videoTitle?.substring(0, 30) : '');
    await storage.saveSession(ended);
  }

  await storage.clearCurrentSession();
  return ended;
}

/**
 * Pause the current session (user went idle or window lost focus).
 * Saves partial duration but keeps it restorable.
 */
export async function pauseCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current || !current.isActive) return null;

  const paused = pauseSession(current);
  await storage.setCurrentSession(paused);
  return paused;
}

/**
 * Resume a paused session (user came back).
 */
export async function resumeCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current) return null;

  const resumed = {
    ...current,
    startTime: Date.now(), // Reset timer from now
    isActive: true,
  };
  await storage.setCurrentSession(resumed);
  return resumed;
}

/**
 * Update the current session's metadata (e.g., YouTube video info).
 * MERGES with existing meta — prefers non-empty values so a later partial
 * update (e.g. DOM-only extract) doesn't wipe out previously-extracted data.
 */
export async function updateSessionMeta(meta) {
  const current = await storage.getCurrentSession();
  if (!current) return null;

  if (!meta) return current;

  // If videoId differs from what we have, this is a different video — replace
  const existing = current.meta || {};
  if (existing.videoId && meta.videoId && existing.videoId !== meta.videoId) {
    const replaced = { ...current, meta };
    await storage.setCurrentSession(replaced);
    return replaced;
  }

  // Same video — merge, keeping the best (longest non-empty) values
  const merged = { ...existing };
  for (const [key, value] of Object.entries(meta)) {
    // For strings: prefer longer non-empty value
    if (typeof value === 'string') {
      if (value && (!merged[key] || merged[key].length < value.length)) {
        merged[key] = value;
      }
    } else if (typeof value === 'number') {
      // For numbers: prefer non-zero
      if (value > 0) merged[key] = value;
    } else if (typeof value === 'boolean') {
      merged[key] = value;
    } else if (value != null) {
      merged[key] = value;
    }
  }

  const updated = { ...current, meta: merged };
  await storage.setCurrentSession(updated);
  return updated;
}

/**
 * Update the current session's category.
 */
export async function updateSessionCategory(categoryId) {
  const current = await storage.getCurrentSession();
  if (!current) return null;

  const updated = { ...current, categoryId };
  await storage.setCurrentSession(updated);
  return updated;
}

/**
 * Flush the current session's accumulated time to storage
 * without ending it. Called periodically by the alarm.
 */
export async function flushCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current || !current.isActive) return;

  // Save a snapshot to IndexedDB as a completed partial session
  const now = Date.now();
  const partialDuration = now - current.startTime;

  if (partialDuration > 1000) {
    const snapshot = {
      ...current,
      id: generateId(), // New unique ID so we don't overwrite previous flushes
      endTime: now,
      duration: partialDuration, // Only this flush period's duration
      isActive: false,
    };

    const hasMeta = snapshot.meta && snapshot.meta.videoId;
    console.log('[Track Daily] Flushing session:', snapshot.domain,
      '| duration:', Math.round(partialDuration / 1000) + 's',
      '| category:', snapshot.categoryId,
      '| hasMeta:', !!hasMeta);

    await storage.saveSession(snapshot);

    // Reset the current session's timer (keep meta and category)
    const reset = {
      ...current,
      startTime: now,
    };
    await storage.setCurrentSession(reset);
  }
}
