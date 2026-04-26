// Storage keys
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  CATEGORIES: 'categories',
  SIMILARITY_DATA: 'similarity_data',
  CURRENT_SESSION: 'current_session',
  TRACKING_STATE: 'tracking_state',
  YT_EXPANDED: 'yt_expanded', // YouTube is in theater or fullscreen mode
};

// IndexedDB
export const DB_NAME = 'track_daily_db';
export const DB_VERSION = 1;
export const STORES = {
  SESSIONS: 'sessions',
  AGGREGATES: 'aggregates',
  SIMILARITY: 'similarity_data',
};

// Tracking states
export const TRACKING_STATES = {
  ACTIVE: 'active',
  IDLE: 'idle',
  PAUSED: 'paused',
  DISABLED: 'disabled',
};

// Alarm names
export const ALARMS = {
  FLUSH_SESSION: 'flush_session',
  REBUILD_AGGREGATES: 'rebuild_aggregates',
};

// Intervals
export const FLUSH_INTERVAL_MINUTES = 5;
export const DEFAULT_IDLE_THRESHOLD_SECONDS = 120;
export const DEFAULT_RETENTION_DAYS = 90;

// Message types
export const MSG = {
  // Content script → Background
  PAGE_INFO: 'PAGE_INFO',
  YOUTUBE_META: 'YOUTUBE_META',
  YOUTUBE_FULLSCREEN: 'YOUTUBE_FULLSCREEN',
  YOUTUBE_THEATER: 'YOUTUBE_THEATER',
  VISIBILITY_CHANGE: 'VISIBILITY_CHANGE',

  // Background → Content Script
  REREQUEST_YT_META: 'REREQUEST_YT_META',

  // Popup/Dashboard → Background
  GET_CURRENT_SESSION: 'GET_CURRENT_SESSION',
  GET_TODAY_STATS: 'GET_TODAY_STATS',
  GET_SESSIONS: 'GET_SESSIONS',
  GET_AGGREGATES: 'GET_AGGREGATES',
  TOGGLE_TRACKING: 'TOGGLE_TRACKING',
  CATEGORIZE_DOMAIN: 'CATEGORIZE_DOMAIN',
  GET_UNCATEGORIZED: 'GET_UNCATEGORIZED',
  CLEAR_HISTORY: 'CLEAR_HISTORY',
  RESET_EVERYTHING: 'RESET_EVERYTHING',

  // Background → Popup
  SESSION_UPDATED: 'SESSION_UPDATED',
  ASK_CATEGORIZE: 'ASK_CATEGORIZE',
};

// Default categories
export const DEFAULT_CATEGORIES = [
  {
    id: 'social_media',
    name: 'Social Media',
    color: '#E91E63',
    icon: '\uD83D\uDC65',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'facebook.com' },
      { type: 'domain', value: 'www.facebook.com' },
      { type: 'domain', value: 'twitter.com' },
      { type: 'domain', value: 'x.com' },
      { type: 'domain', value: 'instagram.com' },
      { type: 'domain', value: 'www.instagram.com' },
      { type: 'domain', value: 'reddit.com' },
      { type: 'domain', value: 'www.reddit.com' },
      { type: 'domain', value: 'linkedin.com' },
      { type: 'domain', value: 'www.linkedin.com' },
      { type: 'domain', value: 'tiktok.com' },
      { type: 'domain', value: 'www.tiktok.com' },
      { type: 'domain', value: 'threads.net' },
      { type: 'domain', value: 'bsky.app' },
      { type: 'domain', value: 'snapchat.com' },
    ],
  },
  {
    id: 'entertainment',
    name: 'Entertainment',
    color: '#9C27B0',
    icon: '\uD83C\uDFAC',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'youtube.com' },
      { type: 'domain', value: 'www.youtube.com' },
      { type: 'domain', value: 'netflix.com' },
      { type: 'domain', value: 'www.netflix.com' },
      { type: 'domain', value: 'twitch.tv' },
      { type: 'domain', value: 'www.twitch.tv' },
      { type: 'domain', value: 'spotify.com' },
      { type: 'domain', value: 'open.spotify.com' },
      { type: 'domain', value: 'disneyplus.com' },
      { type: 'domain', value: 'primevideo.com' },
      { type: 'domain', value: 'hotstar.com' },
      { type: 'domain', value: 'www.hotstar.com' },
      { type: 'domain', value: 'crunchyroll.com' },
      { type: 'domain', value: 'soundcloud.com' },
    ],
  },
  {
    id: 'news',
    name: 'News & Media',
    color: '#2196F3',
    icon: '\uD83D\uDCF0',
    isBuiltIn: true,
    rules: [
      { type: 'domain_contains', value: 'news' },
      { type: 'domain', value: 'bbc.com' },
      { type: 'domain', value: 'www.bbc.com' },
      { type: 'domain', value: 'cnn.com' },
      { type: 'domain', value: 'www.cnn.com' },
      { type: 'domain', value: 'reuters.com' },
      { type: 'domain', value: 'nytimes.com' },
      { type: 'domain', value: 'theguardian.com' },
      { type: 'domain', value: 'medium.com' },
      { type: 'domain', value: 'substack.com' },
      { type: 'domain', value: 'techcrunch.com' },
      { type: 'domain', value: 'theverge.com' },
      { type: 'domain', value: 'arstechnica.com' },
      { type: 'domain', value: 'ndtv.com' },
      { type: 'domain', value: 'www.ndtv.com' },
      { type: 'domain', value: 'timesofindia.indiatimes.com' },
    ],
  },
  {
    id: 'productivity',
    name: 'Productivity & Work',
    color: '#4CAF50',
    icon: '\uD83D\uDCBC',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'docs.google.com' },
      { type: 'domain', value: 'sheets.google.com' },
      { type: 'domain', value: 'slides.google.com' },
      { type: 'domain', value: 'drive.google.com' },
      { type: 'domain', value: 'notion.so' },
      { type: 'domain', value: 'www.notion.so' },
      { type: 'domain', value: 'trello.com' },
      { type: 'domain', value: 'asana.com' },
      { type: 'domain', value: 'slack.com' },
      { type: 'domain', value: 'app.slack.com' },
      { type: 'domain', value: 'teams.microsoft.com' },
      { type: 'domain', value: 'clickup.com' },
      { type: 'domain', value: 'monday.com' },
      { type: 'domain', value: 'figma.com' },
      { type: 'domain', value: 'www.figma.com' },
      { type: 'domain', value: 'canva.com' },
      { type: 'domain', value: 'www.canva.com' },
      { type: 'domain', value: 'calendar.google.com' },
      { type: 'domain', value: 'airtable.com' },
    ],
  },
  {
    id: 'development',
    name: 'Development',
    color: '#FF9800',
    icon: '\uD83D\uDCBB',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'github.com' },
      { type: 'domain', value: 'gitlab.com' },
      { type: 'domain', value: 'stackoverflow.com' },
      { type: 'domain', value: 'developer.mozilla.org' },
      { type: 'domain', value: 'npmjs.com' },
      { type: 'domain', value: 'www.npmjs.com' },
      { type: 'domain', value: 'pypi.org' },
      { type: 'domain', value: 'codepen.io' },
      { type: 'domain', value: 'codesandbox.io' },
      { type: 'domain', value: 'vercel.com' },
      { type: 'domain', value: 'netlify.com' },
      { type: 'domain', value: 'bitbucket.org' },
      { type: 'domain', value: 'hashnode.dev' },
      { type: 'domain', value: 'dev.to' },
      { type: 'domain_contains', value: 'developer' },
    ],
  },
  {
    id: 'shopping',
    name: 'Shopping',
    color: '#FF5722',
    icon: '\uD83D\uDED2',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'amazon.com' },
      { type: 'domain', value: 'www.amazon.com' },
      { type: 'domain', value: 'amazon.in' },
      { type: 'domain', value: 'www.amazon.in' },
      { type: 'domain', value: 'flipkart.com' },
      { type: 'domain', value: 'www.flipkart.com' },
      { type: 'domain', value: 'ebay.com' },
      { type: 'domain', value: 'www.ebay.com' },
      { type: 'domain', value: 'etsy.com' },
      { type: 'domain', value: 'myntra.com' },
      { type: 'domain', value: 'www.myntra.com' },
      { type: 'domain_contains', value: 'shop' },
    ],
  },
  {
    id: 'education',
    name: 'Education & Learning',
    color: '#00BCD4',
    icon: '\uD83C\uDF93',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'coursera.org' },
      { type: 'domain', value: 'www.coursera.org' },
      { type: 'domain', value: 'udemy.com' },
      { type: 'domain', value: 'www.udemy.com' },
      { type: 'domain', value: 'khanacademy.org' },
      { type: 'domain', value: 'wikipedia.org' },
      { type: 'domain', value: 'en.wikipedia.org' },
      { type: 'domain', value: 'brilliant.org' },
      { type: 'domain', value: 'edx.org' },
      { type: 'domain', value: 'skillshare.com' },
      { type: 'domain', value: 'freecodecamp.org' },
      { type: 'domain', value: 'w3schools.com' },
      { type: 'domain', value: 'www.w3schools.com' },
      { type: 'domain', value: 'leetcode.com' },
      { type: 'domain_contains', value: 'learn' },
      { type: 'domain_contains', value: 'edu' },
    ],
  },
  {
    id: 'search',
    name: 'Search',
    color: '#607D8B',
    icon: '\uD83D\uDD0D',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'google.com' },
      { type: 'domain', value: 'www.google.com' },
      { type: 'domain', value: 'bing.com' },
      { type: 'domain', value: 'www.bing.com' },
      { type: 'domain', value: 'duckduckgo.com' },
      { type: 'domain', value: 'search.yahoo.com' },
      { type: 'domain', value: 'perplexity.ai' },
    ],
  },
  {
    id: 'email',
    name: 'Email & Communication',
    color: '#795548',
    icon: '\u2709\uFE0F',
    isBuiltIn: true,
    rules: [
      { type: 'domain', value: 'mail.google.com' },
      { type: 'domain', value: 'outlook.live.com' },
      { type: 'domain', value: 'outlook.office.com' },
      { type: 'domain', value: 'mail.yahoo.com' },
      { type: 'domain', value: 'discord.com' },
      { type: 'domain', value: 'web.whatsapp.com' },
      { type: 'domain', value: 'web.telegram.org' },
      { type: 'domain', value: 'meet.google.com' },
      { type: 'domain', value: 'zoom.us' },
    ],
  },
  {
    id: 'uncategorized',
    name: 'Other',
    color: '#9E9E9E',
    icon: '\u2753',
    isBuiltIn: true,
    rules: [],
  },
];

// YouTube category mapping → our category IDs
// Full list of YouTube's 15 video categories
export const YOUTUBE_CATEGORY_MAP = {
  'Music': 'entertainment',
  'Gaming': 'entertainment',
  'Entertainment': 'entertainment',
  'Comedy': 'entertainment',
  'Film & Animation': 'entertainment',
  'Sports': 'entertainment',
  'Pets & Animals': 'entertainment',
  'People & Blogs': 'social_media',
  'News & Politics': 'news',
  'Education': 'education',
  'Science & Technology': 'development',  // tech content → development category
  'Howto & Style': 'education',
  'Autos & Vehicles': 'entertainment',
  'Travel & Events': 'entertainment',
  'Nonprofits & Activism': 'news',
};

// Keyword heuristics for categorization fallback
export const KEYWORD_HINTS = {
  social_media: ['social', 'feed', 'profile', 'follow', 'tweet', 'post', 'share', 'friends'],
  entertainment: ['watch', 'stream', 'movie', 'music', 'video', 'play', 'game', 'anime', 'tv show'],
  news: ['news', 'breaking', 'report', 'journalist', 'politics', 'opinion', 'editorial', 'headline'],
  productivity: ['project', 'task', 'kanban', 'spreadsheet', 'document', 'collaborate', 'workspace'],
  development: ['code', 'programming', 'developer', 'api', 'repository', 'framework', 'library', 'debug'],
  shopping: ['buy', 'price', 'cart', 'order', 'deal', 'discount', 'product', 'shipping', 'delivery'],
  education: ['course', 'learn', 'tutorial', 'lesson', 'quiz', 'study', 'lecture', 'certificate'],
  search: ['search', 'results', 'query'],
  email: ['inbox', 'email', 'message', 'chat', 'call', 'meeting'],
};

// Default settings
export const DEFAULT_SETTINGS = {
  idleThresholdSeconds: DEFAULT_IDLE_THRESHOLD_SECONDS,
  trackingEnabled: true,
  excludedDomains: [],
  retentionDays: DEFAULT_RETENTION_DAYS,
  youtubeDeepTracking: true,
  dashboardDefaultView: 'daily',
  aiApiKey: '',
  aiProvider: '',
};
