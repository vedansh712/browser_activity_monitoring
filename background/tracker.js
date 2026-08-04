import {
  createSession,
  endSession,
  pauseSession,
  resumeSession,
  sessionElapsed,
} from '../shared/data-models.js';
import { MIN_SESSION_MS } from '../shared/constants.js';
import { extractDomain, generateId, formatDate } from '../shared/utils.js';
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
    tabId: tab.id ?? null,
  });

  await storage.setCurrentSession(session);
  return session;
}

/**
 * End the current session and save it to IndexedDB.
 *
 * Paused sessions are ended too — their banked time is real and must not be
 * discarded just because the clock happened to be stopped.
 *
 * Returns the ended session or null if there wasn't one.
 */
export async function endCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current) return null;

  const ended = endSession(current);

  // Only save sessions longer than the noise floor
  if (ended.duration > MIN_SESSION_MS) {
    await storage.saveSession(ended);
  }

  await storage.clearCurrentSession();
  return ended;
}

/**
 * Pause the current session (user went idle or window lost focus).
 * Banks elapsed time; the session stays restorable.
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
  if (!current || current.isActive) return current;

  const resumed = resumeSession(current);
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
 * Flush the current session's accumulated time to storage without ending it.
 * Called periodically by the alarm.
 *
 * Writes a closed snapshot carrying everything banked so far, then zeroes the
 * live session's banked time and restarts its clock. Splitting the record this
 * way is also what keeps a long session's time attributed to the right day.
 */
export async function flushCurrentSession() {
  const current = await storage.getCurrentSession();
  if (!current || !current.isActive) return;

  const now = Date.now();
  const elapsed = sessionElapsed(current, now);
  if (elapsed <= MIN_SESSION_MS) return;

  const snapshot = {
    ...current,
    id: generateId(), // New unique ID so we don't overwrite previous flushes
    endTime: now,
    duration: elapsed,
    isActive: false,
    date: formatDate(new Date(now)),
  };

  await storage.saveSession(snapshot);

  // Restart the live session's clock with nothing banked (keep meta and category)
  await storage.setCurrentSession({
    ...current,
    startTime: now,
    duration: 0,
  });
}
