import {
  KEYWORD_HINTS,
  YOUTUBE_CATEGORY_MAP,
  YOUTUBE_TITLE_HINTS,
} from '../shared/constants.js';
import { tokenize, jaccardSimilarity } from '../shared/utils.js';
import { findMatchingRule, exampleDomains } from '../shared/category-rules.js';
import * as storage from './storage-manager.js';

const SIMILARITY_THRESHOLD = 0.25;

/*
 * Classification pipeline
 * ───────────────────────
 * An ordered chain of named strategies. Each is given the page and either
 * claims it or declines, and the first claim wins.
 *
 * Written as a list rather than a run of if-statements for one practical
 * reason: the on-device model is an optional extra tier, and expressing it as
 * an entry that is present or absent keeps "do we have AI" a wiring decision
 * in one place instead of a condition threaded through the logic. Everything
 * below is deterministic and works with no model at all; AI only ever appends
 * to the end.
 *
 * The tiers also feed each other. A model result, like a manual
 * categorization, is recorded as a similarity exemplar — so the deterministic
 * path learns from the model and classifies comparable sites later without it.
 */

/**
 * @typedef {Object} PageContext
 * @property {string}  domain
 * @property {string}  url
 * @property {string} [title]
 * @property {string} [metaDescription]
 * @property {Object} [youtubeMeta]
 * @property {Object}  categories - as returned by storage.getCategories()
 */

/**
 * @typedef {Object} Classification
 * @property {string} categoryId
 * @property {string} method - which strategy claimed it, for debugging and display
 */

/** The deterministic chain, in priority order. */
const STRATEGIES = [
  { name: 'domain_override', classify: byDomainOverride },
  { name: 'youtube', classify: byYouTube },
  { name: 'rule', classify: byRule },
  { name: 'keyword', classify: byKeyword },
  { name: 'similarity', classify: bySimilarity },
];

/**
 * Classify a page using the deterministic chain.
 *
 * Returns 'uncategorized' when nothing claims it, which is the signal for the
 * caller to try the optional model tier — deliberately not attempted here,
 * because inference can involve a wait and classification sits on the path
 * that starts a session.
 *
 * @param {PageContext} context
 * @returns {Promise<Classification>}
 */
export async function classifyPage({ domain, url, title, metaDescription, youtubeMeta }) {
  if (!domain) return { categoryId: 'uncategorized', method: 'none' };

  const categories = await storage.getCategories();
  const context = { domain, url, title, metaDescription, youtubeMeta, categories };

  for (const strategy of STRATEGIES) {
    const result = await strategy.classify(context);
    if (result) return { ...result, method: result.method ?? strategy.name };
  }

  return { categoryId: 'uncategorized', method: 'none' };
}

/** Strategy names in order, for diagnostics. */
export const strategyNames = () => STRATEGIES.map((s) => s.name);

// ─── 1. Domain override ────────────────────────────────────────────

function byDomainOverride({ domain, categories }) {
  const override = categories.domainOverrides?.[domain];
  return override ? { categoryId: override } : null;
}

// ─── 2. YouTube ────────────────────────────────────────────────────

export function isYouTubeDomain(domain) {
  // extractDomain() has already stripped "www.", so only real subdomains remain.
  return domain === 'youtube.com' || domain === 'm.youtube.com';
}

function byYouTube({ domain, youtubeMeta, categories }) {
  // Runs before rules on purpose: youtube.com matches the Entertainment rule,
  // so checking rules first would funnel every video into Entertainment and
  // the per-video categorization below would never run.
  if (!isYouTubeDomain(domain) || !youtubeMeta) return null;
  return classifyYouTube(youtubeMeta, categories);
}

/**
 * Classify a YouTube video. The single source of truth for YouTube: the
 * content script reports raw metadata and does no guessing of its own.
 *
 * Always returns a result — YouTube time is never left uncategorized, because
 * we already know at minimum that it is YouTube.
 *
 * @returns {{categoryId: string, method: string}}
 */
export function classifyYouTube(youtubeMeta, categories) {
  const channelOverride = youtubeMeta.channelName &&
    categories.channelOverrides?.[youtubeMeta.channelName];
  if (channelOverride) {
    return { categoryId: channelOverride, method: 'youtube_channel_override' };
  }

  if (youtubeMeta.videoCategory) {
    const mapped = YOUTUBE_CATEGORY_MAP[youtubeMeta.videoCategory];
    if (mapped) return { categoryId: mapped, method: 'youtube_category' };
  }

  const inferred = inferYouTubeCategoryFromTitle(youtubeMeta.videoTitle);
  if (inferred && YOUTUBE_CATEGORY_MAP[inferred]) {
    return { categoryId: YOUTUBE_CATEGORY_MAP[inferred], method: 'youtube_title_hint' };
  }

  return { categoryId: 'entertainment', method: 'youtube_default' };
}

/** Guess YouTube's own category name from a video title. */
export function inferYouTubeCategoryFromTitle(title) {
  if (!title) return '';
  const text = title.toLowerCase();
  for (const [category, keywords] of Object.entries(YOUTUBE_TITLE_HINTS)) {
    if (keywords.some((k) => text.includes(k))) return category;
  }
  return '';
}

// ─── 3. Category rules ─────────────────────────────────────────────

function byRule({ domain, url, title, categories }) {
  // Custom first: a user's own category should win over a built-in default.
  const all = [...(categories.custom ?? []), ...(categories.builtIn ?? [])];
  const page = { domain, url, title };

  for (const category of all) {
    const rule = findMatchingRule(category.rules, page);
    if (rule) return { categoryId: category.id, method: `rule:${rule.type}` };
  }
  return null;
}

// ─── 4. Keyword heuristics ─────────────────────────────────────────

function byKeyword({ title, metaDescription, url }) {
  const text = `${title || ''} ${metaDescription || ''} ${url || ''}`.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const [categoryId, keywords] of Object.entries(KEYWORD_HINTS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) score++;
    }
    // Two independent hits before believing a guess made from loose words.
    if (score > bestScore && score >= 2) {
      bestScore = score;
      best = categoryId;
    }
  }

  return best ? { categoryId: best } : null;
}

// ─── 5. Similarity ─────────────────────────────────────────────────

async function bySimilarity({ domain, title }) {
  const similarityData = await storage.getAllSimilarityData();
  if (similarityData.length === 0) return null;

  const titleTokens = tokenize(title);
  const domainTokens = tokenize(domain.replace(/\./g, ' '));

  let best = null;
  let bestScore = 0;

  for (const entry of similarityData) {
    if (entry.domain === domain) return { categoryId: entry.categoryId };

    const score =
      jaccardSimilarity(titleTokens, entry.titleTokens) * 0.6 +
      jaccardSimilarity(domainTokens, entry.domainTokens) * 0.4;

    if (score > bestScore && score >= SIMILARITY_THRESHOLD) {
      bestScore = score;
      best = entry.categoryId;
    }
  }

  return best ? { categoryId: best } : null;
}

// ─── Learning ──────────────────────────────────────────────────────

/**
 * Record an exemplar for similarity matching.
 *
 * The entry ID is the domain, so re-categorizing a site overwrites its
 * previous entry instead of appending another row. With random IDs this store
 * grew without bound and every classification scanned the accumulated
 * duplicates.
 */
export async function learnFromUserCategorization(domain, title, categoryId) {
  if (!domain || !categoryId) return;
  await storage.saveSimilarityEntry({
    id: domain,
    domain,
    titleTokens: tokenize(title),
    domainTokens: tokenize(domain.replace(/\./g, ' ')),
    categoryId,
    createdAt: Date.now(),
  });
}

/**
 * Teach the similarity engine from a newly created category.
 *
 * Without this a custom category only ever matches the literal strings in its
 * rules: naming a category "Research" and giving arxiv.org as an example
 * matched arxiv.org and nothing else, which is not what giving an example
 * implies. Seeding an exemplar per example domain, tokenised alongside the
 * category name, lets comparable sites be recognised on their own.
 *
 * @param {{id: string, name: string, rules: Array}} category
 * @returns {Promise<number>} exemplars written
 */
export async function seedSimilarityFromCategory(category) {
  const domains = exampleDomains(category?.rules);
  if (domains.length === 0) return 0;

  for (const domain of domains) {
    // The category name stands in for a page title: it is the best available
    // description of what the user means this category to be about.
    await learnFromUserCategorization(domain, category.name ?? '', category.id);
  }
  return domains.length;
}
