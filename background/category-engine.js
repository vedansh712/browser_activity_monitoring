import { KEYWORD_HINTS, YOUTUBE_CATEGORY_MAP } from '../shared/constants.js';
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

  // Step 2: Domain Rules (built-in + custom)
  const allCategories = [...categories.custom, ...categories.builtIn];
  const ruleMatch = matchDomainRules(domain, url, allCategories);
  if (ruleMatch) {
    // Step 3: YouTube sub-classification (refine if domain matched youtube)
    if (isYouTubeDomain(domain) && youtubeMeta) {
      const ytResult = classifyYouTube(youtubeMeta, categories);
      if (ytResult) return ytResult;
    }
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

function isYouTubeDomain(domain) {
  return domain === 'youtube.com' || domain === 'www.youtube.com' || domain === 'm.youtube.com';
}

function classifyYouTube(youtubeMeta, categories) {
  // Check channel override first
  if (youtubeMeta.channelName && categories.channelOverrides) {
    const channelOverride = categories.channelOverrides[youtubeMeta.channelName];
    if (channelOverride) {
      return { categoryId: channelOverride, method: 'youtube_channel_override' };
    }
  }

  // Map YouTube's category to our categories
  if (youtubeMeta.videoCategory) {
    const mapped = YOUTUBE_CATEGORY_MAP[youtubeMeta.videoCategory];
    if (mapped) {
      return { categoryId: mapped, method: 'youtube_category' };
    }
  }

  return null; // Fall back to default entertainment
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
 */
export async function learnFromUserCategorization(domain, title, categoryId) {
  const { createSimilarityEntry } = await import('../shared/data-models.js');
  const entry = createSimilarityEntry({
    domain,
    titleTokens: tokenize(title),
    domainTokens: tokenize(domain.replace(/\./g, ' ')),
    categoryId,
  });
  await storage.saveSimilarityEntry(entry);
}
