import {
  KEYWORD_HINTS,
  YOUTUBE_CATEGORY_MAP,
  YOUTUBE_TITLE_HINTS,
} from '../shared/constants.js';
import { tokenize, jaccardSimilarity } from '../shared/utils.js';
import * as storage from './storage-manager.js';

const SIMILARITY_THRESHOLD = 0.25;

/**
 * Main classification pipeline. Runs steps 1-6 in order, returns first match.
 * Step 7 (ask user) is handled by the service worker when this returns 'uncategorized'.
 *
 * @param {string} domain
 * @param {string} url
 * @param {string} title - page title
 * @param {string} metaDescription - page meta description (from content script)
 * @param {Object|null} youtubeMeta - YouTube metadata if applicable
 * @returns {Promise<{categoryId: string, method: string}>}
 */
export async function classifyPage({ domain, url, title, metaDescription, youtubeMeta }) {
  if (!domain) return { categoryId: 'uncategorized', method: 'none' };

  const categories = await storage.getCategories();

  // Step 1: Domain Override (user manually assigned this domain)
  const override = categories.domainOverrides[domain];
  if (override) {
    return { categoryId: override, method: 'domain_override' };
  }

  // Step 2: YouTube sub-classification.
  // Runs BEFORE domain rules: youtube.com matches the Entertainment rule, so
  // checking rules first would short-circuit every video into Entertainment
  // and the per-video categorization below would never run.
  if (isYouTubeDomain(domain) && youtubeMeta) {
    return classifyYouTube(youtubeMeta, categories);
  }

  // Step 3: Domain Rules (built-in + custom)
  const allCategories = [...(categories.custom || []), ...categories.builtIn];
  const ruleMatch = matchDomainRules(domain, url, allCategories);
  if (ruleMatch) {
    return { categoryId: ruleMatch, method: 'domain_rule' };
  }

  // Step 4: Keyword Heuristics
  const keywordMatch = matchKeywords(title, metaDescription, url);
  if (keywordMatch) {
    return { categoryId: keywordMatch, method: 'keyword_heuristic' };
  }

  // Step 5: Similarity Match (learned from user categorizations)
  const similarityMatch = await matchSimilarity(domain, title);
  if (similarityMatch) {
    return { categoryId: similarityMatch, method: 'similarity' };
  }

  // Step 6: AI Classification (handled externally — returns null if unavailable)
  // The service worker will attempt AI classification if we return uncategorized

  return { categoryId: 'uncategorized', method: 'none' };
}

// ─── Step 2: Domain Rule Matching ──────────────────────────────────

function matchDomainRules(domain, url, categories) {
  for (const category of categories) {
    for (const rule of category.rules) {
      switch (rule.type) {
        case 'domain':
          if (domain === rule.value) return category.id;
          break;
        case 'domain_contains':
          if (domain.includes(rule.value)) return category.id;
          break;
        case 'url_regex':
          try {
            if (new RegExp(rule.value).test(url)) return category.id;
          } catch { /* invalid regex, skip */ }
          break;
      }
    }
  }
  return null;
}

// ─── Step 3: YouTube Sub-classification ────────────────────────────

export function isYouTubeDomain(domain) {
  // extractDomain() has already stripped "www.", so only real subdomains remain.
  return domain === 'youtube.com' || domain === 'm.youtube.com';
}

/**
 * Classify a YouTube video. This is the single source of truth for YouTube
 * categorization — the content script reports raw metadata and nothing else,
 * so the keyword tables and the category mapping live in one place only.
 *
 * Always returns a result: YouTube time is never left uncategorized, because
 * we already know at minimum that it is YouTube.
 *
 * @returns {{categoryId: string, method: string}}
 */
export function classifyYouTube(youtubeMeta, categories) {
  // 1. Channel override — the user's explicit choice wins
  const channelOverride = youtubeMeta.channelName &&
    categories.channelOverrides?.[youtubeMeta.channelName];
  if (channelOverride) {
    return { categoryId: channelOverride, method: 'youtube_channel_override' };
  }

  // 2. YouTube's own category for the video
  if (youtubeMeta.videoCategory) {
    const mapped = YOUTUBE_CATEGORY_MAP[youtubeMeta.videoCategory];
    if (mapped) {
      return { categoryId: mapped, method: 'youtube_category' };
    }
  }

  // 3. Infer YouTube's category from the title, then map it as above
  const inferred = inferYouTubeCategoryFromTitle(youtubeMeta.videoTitle);
  if (inferred && YOUTUBE_CATEGORY_MAP[inferred]) {
    return { categoryId: YOUTUBE_CATEGORY_MAP[inferred], method: 'youtube_title_hint' };
  }

  // 4. It is still YouTube
  return { categoryId: 'entertainment', method: 'youtube_default' };
}

/**
 * Guess YouTube's category name from a video title.
 * Returns '' when nothing matches.
 */
export function inferYouTubeCategoryFromTitle(title) {
  if (!title) return '';
  const text = title.toLowerCase();
  for (const [category, keywords] of Object.entries(YOUTUBE_TITLE_HINTS)) {
    if (keywords.some((k) => text.includes(k))) return category;
  }
  return '';
}

// ─── Step 4: Keyword Heuristics ────────────────────────────────────

function matchKeywords(title, metaDescription, url) {
  const text = `${title || ''} ${metaDescription || ''} ${url || ''}`.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const [categoryId, keywords] of Object.entries(KEYWORD_HINTS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) score++;
    }
    if (score > bestScore && score >= 2) {
      // Require at least 2 keyword matches for confidence
      bestScore = score;
      bestMatch = categoryId;
    }
  }

  return bestMatch;
}

// ─── Step 5: Similarity Match ──────────────────────────────────────

async function matchSimilarity(domain, title) {
  const similarityData = await storage.getAllSimilarityData();
  if (similarityData.length === 0) return null;

  const titleTokens = tokenize(title);
  const domainTokens = tokenize(domain.replace(/\./g, ' '));

  let bestMatch = null;
  let bestScore = 0;

  for (const entry of similarityData) {
    // Check exact domain match first
    if (entry.domain === domain) {
      return entry.categoryId;
    }

    // Compute similarity
    const titleSim = jaccardSimilarity(titleTokens, entry.titleTokens);
    const domainSim = jaccardSimilarity(domainTokens, entry.domainTokens);
    const score = titleSim * 0.6 + domainSim * 0.4;

    if (score > bestScore && score >= SIMILARITY_THRESHOLD) {
      bestScore = score;
      bestMatch = entry.categoryId;
    }
  }

  return bestMatch;
}

/**
 * Record a user's manual categorization for future similarity matching.
 *
 * The entry ID is the domain itself, so re-categorizing a site overwrites its
 * previous entry instead of appending another row. With random IDs this store
 * grew without bound and every classification did a linear Jaccard scan over
 * the accumulated duplicates.
 */
export async function learnFromUserCategorization(domain, title, categoryId) {
  await storage.saveSimilarityEntry({
    id: domain,
    domain,
    titleTokens: tokenize(title),
    domainTokens: tokenize(domain.replace(/\./g, ' ')),
    categoryId,
    createdAt: Date.now(),
  });
}
