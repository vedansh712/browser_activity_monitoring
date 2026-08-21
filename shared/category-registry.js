import { DEFAULT_CATEGORIES } from './constants.js';

/**
 * Shown for a category id that no longer resolves — a deleted custom category
 * still referenced by historical sessions, for instance. Historical data must
 * stay renderable after its category is gone.
 */
export const UNKNOWN_CATEGORY = Object.freeze({
  id: 'uncategorized',
  name: 'Other',
  color: '#9E9E9E',
  icon: '❓',
  isBuiltIn: true,
  rules: [],
});

/**
 * Read-only lookup over the full category set: built-ins plus the user's
 * custom categories.
 *
 * Exists because the popup and dashboard each built their lookup from
 * DEFAULT_CATEGORIES alone, so custom categories rendered as raw ids —
 * the options page could create categories that were invisible everywhere else.
 *
 * Built-ins are always taken from constants rather than from the stored copy,
 * so categories added in an extension update appear immediately instead of
 * being pinned to whatever was persisted at first run. Only `custom` is
 * user-owned and read from storage.
 *
 * @param {{custom?: Array}} [categories] - as returned by storage.getCategories()
 */
export function createCategoryRegistry(categories = {}) {
  const custom = Array.isArray(categories.custom) ? categories.custom : [];
  const all = [...DEFAULT_CATEGORIES, ...custom];
  const byId = new Map(all.map((category) => [category.id, category]));

  return Object.freeze({
    /**
     * Resolve a category id. Never returns undefined: an unresolved id yields a
     * placeholder carrying that id, so the UI degrades to showing the raw id
     * rather than crashing or rendering blanks.
     */
    get(id) {
      const found = byId.get(id);
      if (found) return found;
      if (!id) return UNKNOWN_CATEGORY;
      return { ...UNKNOWN_CATEGORY, id, name: id };
    },

    has(id) {
      return byId.has(id);
    },

    /** Every category, built-in first, then custom. */
    all() {
      return [...all];
    },

    /** Categories a user can assign — excludes the catch-all bucket. */
    assignable() {
      return all.filter((category) => category.id !== UNKNOWN_CATEGORY.id);
    },
  });
}
