import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RULE_TYPES,
  RULE_TYPE_OPTIONS,
  matchesRule,
  findMatchingRule,
  validateRule,
  describeRule,
  exampleDomains,
} from '../shared/category-rules.js';
import { DEFAULT_CATEGORIES } from '../shared/constants.js';

const page = (over = {}) => ({
  domain: 'example.com',
  url: 'https://example.com/docs/intro',
  title: 'Getting Started Tutorial',
  ...over,
});

// ─── Domain matching ───────────────────────────────────────────────

test('domain matches the exact host only', () => {
  const rule = { type: RULE_TYPES.DOMAIN, value: 'example.com' };
  assert.equal(matchesRule(rule, page()), true);
  assert.equal(matchesRule(rule, page({ domain: 'docs.example.com' })), false);
  assert.equal(matchesRule(rule, page({ domain: 'notexample.com' })), false);
});

test('domain_suffix also covers subdomains', () => {
  const rule = { type: RULE_TYPES.DOMAIN_SUFFIX, value: 'example.com' };
  assert.equal(matchesRule(rule, page()), true);
  assert.equal(matchesRule(rule, page({ domain: 'docs.example.com' })), true);
  assert.equal(matchesRule(rule, page({ domain: 'a.b.example.com' })), true);
});

test('domain_suffix does not match a lookalike host', () => {
  // "notexample.com" must not be treated as a subdomain of "example.com".
  const rule = { type: RULE_TYPES.DOMAIN_SUFFIX, value: 'example.com' };
  assert.equal(matchesRule(rule, page({ domain: 'notexample.com' })), false);
  assert.equal(matchesRule(rule, page({ domain: 'example.com.evil.net' })), false);
});

test('exact domain rules keep Gmail out of the Search category', () => {
  // Regression guard. The built-ins list google.com under Search ahead of
  // mail.google.com under Email, so if a plain domain rule swallowed
  // subdomains, Search would claim Gmail purely by appearing earlier.
  const search = DEFAULT_CATEGORIES.find((c) => c.id === 'search');
  const gmail = page({ domain: 'mail.google.com', url: 'https://mail.google.com/' });
  assert.equal(findMatchingRule(search.rules, gmail), null);
});

test('domain_contains matches a fragment of the host', () => {
  const rule = { type: RULE_TYPES.DOMAIN_CONTAINS, value: 'ample' };
  assert.equal(matchesRule(rule, page()), true);
  assert.equal(matchesRule(rule, page({ domain: 'other.org' })), false);
});

// ─── URL and title ─────────────────────────────────────────────────

test('url_contains matches anywhere in the address', () => {
  assert.equal(matchesRule({ type: RULE_TYPES.URL_CONTAINS, value: '/docs/' }, page()), true);
  assert.equal(matchesRule({ type: RULE_TYPES.URL_CONTAINS, value: '/blog/' }, page()), false);
});

test('title_contains is case insensitive', () => {
  assert.equal(matchesRule({ type: RULE_TYPES.TITLE_CONTAINS, value: 'TUTORIAL' }, page()), true);
});

test('url_regex matches and never throws on a bad pattern', () => {
  assert.equal(matchesRule({ type: RULE_TYPES.URL_REGEX, value: '^https://example\\.com' }, page()), true);
  assert.equal(matchesRule({ type: RULE_TYPES.URL_REGEX, value: '^https://other' }, page()), false);
  // An invalid pattern must not break classification for every other rule.
  assert.equal(matchesRule({ type: RULE_TYPES.URL_REGEX, value: '([unclosed' }, page()), false);
});

// ─── Robustness ────────────────────────────────────────────────────

test('malformed rules and pages never throw', () => {
  for (const rule of [null, undefined, {}, { type: 'nonsense', value: 'x' }, { type: RULE_TYPES.DOMAIN }]) {
    assert.equal(matchesRule(rule, page()), false);
  }
  assert.equal(matchesRule({ type: RULE_TYPES.DOMAIN, value: 'example.com' }, null), false);
  assert.equal(matchesRule({ type: RULE_TYPES.TITLE_CONTAINS, value: 'x' }, {}), false);
});

test('findMatchingRule returns the first match, or null', () => {
  const rules = [
    { type: RULE_TYPES.DOMAIN, value: 'other.com' },
    { type: RULE_TYPES.TITLE_CONTAINS, value: 'tutorial' },
  ];
  assert.equal(findMatchingRule(rules, page()).type, RULE_TYPES.TITLE_CONTAINS);
  assert.equal(findMatchingRule([], page()), null);
  assert.equal(findMatchingRule(null, page()), null);
});

// ─── Validation ────────────────────────────────────────────────────

test('validateRule normalises a pasted URL down to a host', () => {
  const result = validateRule({ type: RULE_TYPES.DOMAIN, value: 'https://www.Example.com/some/path' });
  assert.equal(result.ok, true);
  assert.equal(result.rule.value, 'example.com');
});

test('validateRule rejects things that are not domains', () => {
  for (const bad of ['not a domain', 'localhost', '', '   ']) {
    assert.equal(validateRule({ type: RULE_TYPES.DOMAIN, value: bad }).ok, false);
  }
});

test('validateRule rejects an unparseable regex with the reason', () => {
  const result = validateRule({ type: RULE_TYPES.URL_REGEX, value: '([unclosed' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Invalid regular expression/);
});

test('validateRule bounds regex length', () => {
  // A user pattern is evaluated on every page load, so an unbounded one could
  // stall the worker.
  const result = validateRule({ type: RULE_TYPES.URL_REGEX, value: 'a'.repeat(500) });
  assert.equal(result.ok, false);
  assert.match(result.error, /too long/);
});

test('validateRule rejects unknown types and empty values', () => {
  assert.equal(validateRule({ type: 'invented', value: 'x' }).ok, false);
  assert.equal(validateRule({ type: RULE_TYPES.TITLE_CONTAINS, value: '  ' }).ok, false);
});

test('validateRule lowercases stored values', () => {
  const result = validateRule({ type: RULE_TYPES.TITLE_CONTAINS, value: '  Tutorial  ' });
  assert.equal(result.rule.value, 'tutorial');
});

// ─── Presentation and seeding ──────────────────────────────────────

test('every rule type is offered in the UI options', () => {
  const offered = RULE_TYPE_OPTIONS.map((o) => o.type).sort();
  assert.deepEqual(offered, Object.values(RULE_TYPES).sort());
});

test('describeRule reads as a sentence', () => {
  assert.equal(describeRule({ type: RULE_TYPES.DOMAIN, value: 'a.com' }), 'Domain is a.com');
});

test('exampleDomains collects the domain-like rules for seeding', () => {
  const rules = [
    { type: RULE_TYPES.DOMAIN, value: 'arxiv.org' },
    { type: RULE_TYPES.DOMAIN_SUFFIX, value: 'nature.com' },
    { type: RULE_TYPES.TITLE_CONTAINS, value: 'paper' },
    { type: RULE_TYPES.URL_REGEX, value: '^https' },
  ];
  assert.deepEqual(exampleDomains(rules), ['arxiv.org', 'nature.com']);
  assert.deepEqual(exampleDomains(null), []);
});

// ─── Built-ins stay valid under the new matcher ────────────────────

test('every built-in rule uses a known type and non-empty value', () => {
  for (const category of DEFAULT_CATEGORIES) {
    for (const rule of category.rules) {
      assert.ok(
        Object.values(RULE_TYPES).includes(rule.type),
        `${category.id} uses unknown rule type ${rule.type}`
      );
      assert.ok(rule.value, `${category.id} has an empty rule value`);
    }
  }
});
