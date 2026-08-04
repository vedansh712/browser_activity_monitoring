import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyYouTube,
  inferYouTubeCategoryFromTitle,
  isYouTubeDomain,
} from '../background/category-engine.js';
import { YOUTUBE_CATEGORY_MAP } from '../shared/constants.js';

const noOverrides = { channelOverrides: {}, domainOverrides: {}, custom: [], builtIn: [] };

test('isYouTubeDomain matches normalized hosts', () => {
  assert.equal(isYouTubeDomain('youtube.com'), true);
  assert.equal(isYouTubeDomain('m.youtube.com'), true);
  assert.equal(isYouTubeDomain('notyoutube.com'), false);
});

test('channel override beats everything else', () => {
  const categories = { ...noOverrides, channelOverrides: { 'Chan A': 'development' } };
  const result = classifyYouTube(
    { channelName: 'Chan A', videoCategory: 'Music', videoTitle: 'official video' },
    categories
  );
  assert.equal(result.categoryId, 'development');
  assert.equal(result.method, 'youtube_channel_override');
});

test("YouTube's own category is used when there is no override", () => {
  const result = classifyYouTube(
    { channelName: 'Chan B', videoCategory: 'Education', videoTitle: 'whatever' },
    noOverrides
  );
  assert.equal(result.categoryId, YOUTUBE_CATEGORY_MAP['Education']);
  assert.equal(result.method, 'youtube_category');
});

test('title hints fill in when the category is missing', () => {
  const result = classifyYouTube(
    { channelName: 'Chan C', videoCategory: '', videoTitle: 'Python tutorial for beginners' },
    noOverrides
  );
  assert.equal(result.categoryId, 'education');
  assert.equal(result.method, 'youtube_title_hint');
});

test('unknown videos still count as YouTube rather than uncategorized', () => {
  const result = classifyYouTube(
    { channelName: '', videoCategory: '', videoTitle: 'zzzz qqqq' },
    noOverrides
  );
  assert.equal(result.categoryId, 'entertainment');
  assert.equal(result.method, 'youtube_default');
});

test('an unrecognised YouTube category falls through to title hints', () => {
  const result = classifyYouTube(
    { videoCategory: 'Something Invented', videoTitle: 'gameplay walkthrough' },
    noOverrides
  );
  assert.equal(result.categoryId, YOUTUBE_CATEGORY_MAP['Gaming']);
});

test('inferYouTubeCategoryFromTitle returns YouTube category names', () => {
  assert.equal(inferYouTubeCategoryFromTitle('Crash course in React'), 'Education');
  assert.equal(inferYouTubeCategoryFromTitle('Official Video - Some Song'), 'Music');
  assert.equal(inferYouTubeCategoryFromTitle('Minecraft gameplay'), 'Gaming');
  assert.equal(inferYouTubeCategoryFromTitle(''), '');
  assert.equal(inferYouTubeCategoryFromTitle('nothing matches here'), '');
});

test('every inferrable title hint maps to a real category', () => {
  // Guards against a hint table entry drifting away from YOUTUBE_CATEGORY_MAP.
  for (const name of Object.keys(YOUTUBE_CATEGORY_MAP)) {
    assert.ok(YOUTUBE_CATEGORY_MAP[name], `${name} must map to a category id`);
  }
});
