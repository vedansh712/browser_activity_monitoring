import * as storage from './storage-manager.js';
import { buildAggregate } from '../shared/data-models.js';
import { STORAGE_KEYS } from '../shared/constants.js';
import { createLogger } from '../shared/logger.js';
import { AggregateService } from './aggregate-service.js';
import { AiClassifier, chromeLanguageModelProvider } from './ai-classifier.js';

/**
 * Composition root.
 *
 * The one place where concrete implementations are chosen and wired together.
 * Services declare their dependencies as constructor parameters and never
 * import their collaborators directly, which keeps the dependency graph
 * explicit and lets every service be constructed with test doubles.
 *
 * A DI framework would be pure overhead at this size — the graph is shallow and
 * fully known at build time, so manual wiring is both simpler and faster to
 * start, which matters in a service worker that is re-evaluated constantly.
 *
 * Instances are module-level singletons. In MV3 that means "one per worker
 * lifetime": module state is discarded on teardown, so nothing here may hold
 * state that must survive. It holds none — all persistence goes through
 * storage-manager.
 */

/**
 * Adapter exposing exactly the storage surface AggregateService needs.
 * Declaring the narrow port explicitly (rather than passing the whole storage
 * module) keeps the dependency honest and documents the coupling.
 */
const aggregateStore = {
  getAggregate: storage.getAggregate,
  saveAggregate: storage.saveAggregate,
  getSessionsByDate: storage.getSessionsByDate,
  countSessionsByDate: storage.countSessionsByDate,
};

export const aggregateService = new AggregateService({
  store: aggregateStore,
  buildAggregate,
  logger: createLogger('aggregates'),
});

/**
 * Classification cache backed by chrome.storage.session.
 *
 * A module-level Map would be discarded on every MV3 worker teardown — roughly
 * every 30 seconds of inactivity — so the same domain would be re-inferred
 * indefinitely. Session storage lasts for the browser session and is cleared on
 * exit, which is the right lifetime for a derived, reconstructible cache.
 */
const aiCache = {
  async get(key) {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.AI_CACHE);
    return stored[STORAGE_KEYS.AI_CACHE]?.[key];
  },
  async set(key, value) {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.AI_CACHE);
    const cache = stored[STORAGE_KEYS.AI_CACHE] ?? {};
    cache[key] = value;
    await chrome.storage.session.set({ [STORAGE_KEYS.AI_CACHE]: cache });
  },
};

export const aiClassifier = new AiClassifier({
  model: chromeLanguageModelProvider,
  cache: aiCache,
  logger: createLogger('ai'),
});
