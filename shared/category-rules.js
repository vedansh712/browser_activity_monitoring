/**
 * Category rule matching.
 *
 * A rule is `{ type, value }`. Rules are the deterministic half of
 * classification: they say exactly what a category covers, with no inference
 * and no model, and they are the only part a user can state directly.
 *
 * Pure — no storage, no DOM, no chrome APIs — so the matching semantics are
 * testable in isolation from everything that decides when to apply them.
 */

export const RULE_TYPES = Object.freeze({
  DOMAIN: 'domain',
  DOMAIN_SUFFIX: 'domain_suffix',
  DOMAIN_CONTAINS: 'domain_contains',
  URL_CONTAINS: 'url_contains',
  TITLE_CONTAINS: 'title_contains',
  URL_REGEX: 'url_regex',
});

/**
 * DOMAIN is an exact host match and DOMAIN_SUFFIX also covers subdomains.
 *
 * Keeping them apart rather than quietly making DOMAIN match subdomains is a
 * correctness requirement, not a preference. The built-in categories list
 * google.com under Search ahead of mail.google.com under Email, so a DOMAIN
 * rule that swallowed subdomains would let Search claim Gmail purely because
 * it appears earlier in the list.
 */
export const RULE_TYPE_OPTIONS = Object.freeze([
  { type: RULE_TYPES.DOMAIN, label: 'Domain is', placeholder: 'example.com' },
  { type: RULE_TYPES.DOMAIN_SUFFIX, label: 'Domain or subdomain of', placeholder: 'example.com' },
  { type: RULE_TYPES.DOMAIN_CONTAINS, label: 'Domain contains', placeholder: 'wiki' },
  { type: RULE_TYPES.URL_CONTAINS, label: 'URL contains', placeholder: '/docs/' },
  { type: RULE_TYPES.TITLE_CONTAINS, label: 'Title contains', placeholder: 'tutorial' },
  { type: RULE_TYPES.URL_REGEX, label: 'URL matches regex', placeholder: '^https://.*\\.edu/' },
]);

/**
 * A user-authored regex is evaluated against every page load, so a
 * catastrophically backtracking pattern would stall the service worker.
 * Length is not a real defence against that, but it does bound the damage and
 * discourages pasting something unreviewed.
 */
const MAX_REGEX_LENGTH = 200;
const MAX_VALUE_LENGTH = 500;

/**
 * Does a rule match this page?
 *
 * @param {{type: string, value: string}} rule
 * @param {{domain?: string, url?: string, title?: string}} page
 * @returns {boolean}
 */
export function matchesRule(rule, page) {
  if (!rule || typeof rule.value !== 'string' || !rule.value) return false;

  const value = rule.value.toLowerCase();
  const domain = (page?.domain ?? '').toLowerCase();
  const url = (page?.url ?? '').toLowerCase();
  const title = (page?.title ?? '').toLowerCase();

  switch (rule.type) {
    case RULE_TYPES.DOMAIN:
      return domain === value;

    case RULE_TYPES.DOMAIN_SUFFIX:
      return domain === value || domain.endsWith(`.${value}`);

    case RULE_TYPES.DOMAIN_CONTAINS:
      return domain.includes(value);

    case RULE_TYPES.URL_CONTAINS:
      return url.includes(value);

    case RULE_TYPES.TITLE_CONTAINS:
      return title.includes(value);

    case RULE_TYPES.URL_REGEX:
      try {
        return new RegExp(rule.value, 'i').test(page?.url ?? '');
      } catch {
        // An invalid pattern must not break classification for every other rule.
        return false;
      }

    default:
      return false;
  }
}

/**
 * The first matching rule, or null.
 * @returns {{type: string, value: string}|null}
 */
export function findMatchingRule(rules, page) {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    if (matchesRule(rule, page)) return rule;
  }
  return null;
}

/**
 * Validate a rule before storing it.
 *
 * @returns {{ok: true, rule: Object}|{ok: false, error: string}}
 */
export function validateRule(rule) {
  const type = rule?.type;
  const raw = typeof rule?.value === 'string' ? rule.value.trim() : '';

  if (!Object.values(RULE_TYPES).includes(type)) {
    return { ok: false, error: 'Unknown rule type' };
  }
  if (!raw) {
    return { ok: false, error: 'Rule value cannot be empty' };
  }
  if (raw.length > MAX_VALUE_LENGTH) {
    return { ok: false, error: `Rule value is too long (max ${MAX_VALUE_LENGTH})` };
  }

  if (type === RULE_TYPES.URL_REGEX) {
    if (raw.length > MAX_REGEX_LENGTH) {
      return { ok: false, error: `Pattern is too long (max ${MAX_REGEX_LENGTH})` };
    }
    try {
      new RegExp(raw);
    } catch (err) {
      return { ok: false, error: `Invalid regular expression: ${err.message}` };
    }
  }

  if (type === RULE_TYPES.DOMAIN || type === RULE_TYPES.DOMAIN_SUFFIX) {
    // Accept a pasted URL and reduce it to a host, since that is what people
    // have on the clipboard.
    const domain = raw.toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
      return { ok: false, error: 'Enter a domain such as example.com' };
    }
    return { ok: true, rule: { type, value: domain } };
  }

  return { ok: true, rule: { type, value: raw.toLowerCase() } };
}

/**
 * Human-readable description, for showing a rule back to the user.
 * @returns {string}
 */
export function describeRule(rule) {
  const option = RULE_TYPE_OPTIONS.find((o) => o.type === rule?.type);
  return option ? `${option.label} ${rule.value}` : String(rule?.value ?? '');
}

/**
 * Domain-like values a category's rules refer to.
 *
 * Used to seed the similarity engine when a category is created, so an
 * example the user gives teaches the deterministic pipeline instead of only
 * matching that one string.
 *
 * @returns {string[]}
 */
export function exampleDomains(rules) {
  if (!Array.isArray(rules)) return [];
  const domainish = [RULE_TYPES.DOMAIN, RULE_TYPES.DOMAIN_SUFFIX, RULE_TYPES.DOMAIN_CONTAINS];
  return rules
    .filter((r) => domainish.includes(r?.type))
    .map((r) => String(r.value || '').trim())
    .filter(Boolean);
}
