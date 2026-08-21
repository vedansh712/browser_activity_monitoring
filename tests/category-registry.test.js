import test from 'node:test';
import assert from 'node:assert/strict';

import { createCategoryRegistry, UNKNOWN_CATEGORY } from '../shared/category-registry.js';
import { DEFAULT_CATEGORIES } from '../shared/constants.js';
import { bucketSessionsByHour, HOURS_PER_DAY } from '../shared/data-models.js';

const customCategory = {
  id: 'custom_1',
  name: 'Research',
  color: '#123456',
  icon: '🔬',
  isBuiltIn: false,
  rules: [],
};

// ─── Registry ──────────────────────────────────────────────────────

test('built-in categories resolve', () => {
  const registry = createCategoryRegistry();
  assert.equal(registry.get('entertainment').name, 'Entertainment');
  assert.equal(registry.has('development'), true);
});

test('custom categories resolve — the bug that made them invisible', () => {
  const registry = createCategoryRegistry({ custom: [customCategory] });
  assert.equal(registry.get('custom_1').name, 'Research');
  assert.equal(registry.get('custom_1').color, '#123456');
});

test('an unknown id degrades to a placeholder carrying that id', () => {
  // Historical sessions may reference a category the user has since deleted;
  // the dashboard must still render them.
  const registry = createCategoryRegistry();
  const result = registry.get('deleted_category');
  assert.equal(result.id, 'deleted_category');
  assert.equal(result.name, 'deleted_category');
  assert.equal(result.color, UNKNOWN_CATEGORY.color);
});

test('a missing id falls back to the catch-all category', () => {
  const registry = createCategoryRegistry();
  assert.equal(registry.get(undefined).id, UNKNOWN_CATEGORY.id);
  assert.equal(registry.get('').id, UNKNOWN_CATEGORY.id);
});

test('built-ins come from constants, not from stored state', () => {
  // Guards against pinning built-ins to whatever was persisted at first run,
  // which would hide categories added in a later extension update.
  const registry = createCategoryRegistry({ builtIn: [], custom: [] });
  assert.equal(registry.has('entertainment'), true);
});

test('all() returns built-ins plus custom', () => {
  const registry = createCategoryRegistry({ custom: [customCategory] });
  assert.equal(registry.all().length, DEFAULT_CATEGORIES.length + 1);
});

test('assignable() excludes the catch-all bucket', () => {
  const registry = createCategoryRegistry({ custom: [customCategory] });
  const ids = registry.assignable().map((c) => c.id);
  assert.ok(!ids.includes('uncategorized'));
  assert.ok(ids.includes('custom_1'));
});

test('malformed custom data does not break the registry', () => {
  for (const bad of [{ custom: null }, { custom: 'nope' }, {}, undefined]) {
    const registry = createCategoryRegistry(bad);
    assert.equal(registry.has('entertainment'), true);
  }
});

// ─── Hourly bucketing ──────────────────────────────────────────────

const at = (hour, duration) => ({
  startTime: new Date(2026, 0, 15, hour, 30).getTime(),
  duration,
  isActive: false,
});

test('sessions are bucketed into their starting hour', () => {
  const buckets = bucketSessionsByHour([at(9, 60_000), at(9, 30_000), at(14, 120_000)]);
  assert.equal(buckets.length, HOURS_PER_DAY);
  assert.equal(buckets[9], 90_000);
  assert.equal(buckets[14], 120_000);
  assert.equal(buckets[0], 0);
});

test('live and zero-length sessions are excluded', () => {
  const buckets = bucketSessionsByHour([
    { ...at(9, 60_000), isActive: true },
    at(9, 0),
    { startTime: 0, duration: 5000, isActive: false },
  ]);
  assert.equal(buckets.reduce((a, b) => a + b, 0), 0);
});

test('bucketSessionsByHour tolerates junk input', () => {
  for (const bad of [null, undefined, 'nope', [null, undefined, {}]]) {
    const buckets = bucketSessionsByHour(bad);
    assert.equal(buckets.length, HOURS_PER_DAY);
    assert.equal(buckets.reduce((a, b) => a + b, 0), 0);
  }
});
