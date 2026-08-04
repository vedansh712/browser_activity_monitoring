// Storage keys
export const STORAGE_KEYS = {
  SETTINGS: 'settings',
  CATEGORIES: 'categories',
  CURRENT_SESSION: 'current_session',
  TRACKING_STATE: 'tracking_state',
  YT_EXPANDED: 'yt_expanded', // YouTube is in theater or fullscreen mode
  UNCATEGORIZED: 'uncategorized_queue', // pending domains awaiting user categorization
  AI_CACHE: 'ai_cache', // domain -> categoryId (or null for "AI gave up")
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
};

// Intervals
export const FLUSH_INTERVAL_MINUTES = 5;
export const DEFAULT_IDLE_THRESHOLD_SECONDS = 120;
export const DEFAULT_RETENTION_DAYS = 90;

// Sessions shorter than this are noise (tab flicked through on the way elsewhere).
export const MIN_SESSION_MS = 1000;

// The flush alarm resets a live session's clock every FLUSH_INTERVAL_MINUTES, so a
// single uninterrupted interval should never exceed that. If it does, the alarm
// didn't fire — almost always because the machine slept or was suspended. Counting
// that gap would silently add hours of phantom browsing, so we clamp it away.
export const MAX_TRACKED_INTERVAL_MS = FLUSH_INTERVAL_MINUTES * 2 * 60 * 1000;

// chrome.idle rejects intervals below 15s.
export const MIN_IDLE_THRESHOLD_SECONDS = 15;

// Default log threshold. 'warn' keeps normal operation silent so that anything
// reaching the console is genuinely actionable; users can raise it in settings.
export const LOG_LEVEL = 'warn';
export const LOG_LEVELS = Object.freeze(['silent', 'error', 'warn', 'info', 'debug']);

// On-device classification. Inference runs locally, but it still has to finish:
// an unbounded await would keep the service worker alive indefinitely.
export const AI_CLASSIFY_TIMEOUT_MS = 15_000;

// Page titles and descriptions are attacker-controlled and go into the prompt.
// Truncating bounds both the token cost and the injection surface.
export const AI_MAX_TITLE_LENGTH = 120;
export const AI_MAX_DESCRIPTION_LENGTH = 200;

// chrome.storage.session values must be structured-cloneable, so a "no result"
// outcome is stored as this sentinel rather than as undefined.
export const AI_NO_MATCH = '__none__';

/**
 * Model availability, mirroring the Chrome Prompt API's own vocabulary.
 * 'downloadable' means usable only after a multi-gigabyte download, which is
 * never triggered implicitly — see AiClassifier.
 */
export const AI_STATUS = Object.freeze({
  UNSUPPORTED: 'unsupported',
  UNAVAILABLE: 'unavailable',
  DOWNLOADABLE: 'downloadable',
  DOWNLOADING: 'downloading',
  AVAILABLE: 'available',
});

// How many trailing days the periodic refresh re-derives. Two covers the common
// failure: a day's final sessions are written after its aggregate was last built
// (or after midnight), leaving that day permanently short in weekly/monthly views.
export const AGGREGATE_REFRESH_DAYS = 2;

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
      { type: 'domain', value: 'twitter.com' },
      { type: 'domain', value: 'x.com' },
      { type: 'domain', value: 'instagram.com' },
      { type: 'domain', value: 'reddit.com' },
      { type: 'domain', value: 'linkedin.com' },
      { type: 'domain', value: 'tiktok.com' },
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
      { type: 'domain', value: 'netflix.com' },
      { type: 'domain', value: 'twitch.tv' },
      { type: 'domain', value: 'spotify.com' },
      { type: 'domain', value: 'open.spotify.com' },
      { type: 'domain', value: 'disneyplus.com' },
      { type: 'domain', value: 'primevideo.com' },
      { type: 'domain', value: 'hotstar.com' },
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
      { type: 'domain', value: 'cnn.com' },
      { type: 'domain', value: 'reuters.com' },
      { type: 'domain', value: 'nytimes.com' },
      { type: 'domain', value: 'theguardian.com' },
      { type: 'domain', value: 'medium.com' },
      { type: 'domain', value: 'substack.com' },
      { type: 'domain', value: 'techcrunch.com' },
      { type: 'domain', value: 'theverge.com' },
      { type: 'domain', value: 'arstechnica.com' },
      { type: 'domain', value: 'ndtv.com' },
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
      { type: 'domain', value: 'trello.com' },
      { type: 'domain', value: 'asana.com' },
      { type: 'domain', value: 'slack.com' },
      { type: 'domain', value: 'app.slack.com' },
      { type: 'domain', value: 'teams.microsoft.com' },
      { type: 'domain', value: 'clickup.com' },
      { type: 'domain', value: 'monday.com' },
      { type: 'domain', value: 'figma.com' },
      { type: 'domain', value: 'canva.com' },
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
      { type: 'domain', value: 'amazon.in' },
      { type: 'domain', value: 'flipkart.com' },
      { type: 'domain', value: 'ebay.com' },
      { type: 'domain', value: 'etsy.com' },
      { type: 'domain', value: 'myntra.com' },
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
      { type: 'domain', value: 'udemy.com' },
      { type: 'domain', value: 'khanacademy.org' },
      { type: 'domain', value: 'wikipedia.org' },
      { type: 'domain', value: 'en.wikipedia.org' },
      { type: 'domain', value: 'brilliant.org' },
      { type: 'domain', value: 'edx.org' },
      { type: 'domain', value: 'skillshare.com' },
      { type: 'domain', value: 'freecodecamp.org' },
      { type: 'domain', value: 'w3schools.com' },
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
      { type: 'domain', value: 'bing.com' },
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

// Title keyword hints → YouTube's own category names.
//
// Used only when a video's real category can't be read from the page. Results
// feed back through YOUTUBE_CATEGORY_MAP above, so this table never needs to
// know about our internal category IDs — that mapping lives in exactly one place.
export const YOUTUBE_TITLE_HINTS = {
  'Education': [
    'tutorial', 'course', 'learn', 'explained', 'how to', 'lecture', 'lesson',
    'programming', 'python', 'javascript', 'coding', 'beginners', 'complete guide',
    'crash course', 'masterclass', 'for beginners', 'step by step',
    'full course', 'web development', 'data science', 'machine learning',
  ],
  'Science & Technology': [
    'tech', 'review', 'unboxing', 'setup', 'software', 'hardware', ' ai ',
    'gadget', 'benchmark',
  ],
  'Music': [
    'official video', 'official audio', 'music video', 'lyrics', 'album', 'remix',
  ],
  'Gaming': [
    'gameplay', 'walkthrough', 'playthrough', 'gaming', 'lets play',
    'minecraft', 'fortnite', 'valorant',
  ],
  'News & Politics': ['politics', 'election', 'debate', 'breaking news'],
  'Entertainment': ['funny', 'comedy', 'prank', 'challenge', 'reaction', 'vlog'],
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

// Accepted ranges for numeric settings.
//
// Authoritative: the matching min/max attributes in options.html are a UI
// affordance only. Values are re-validated here on save, because HTML
// constraints are trivially bypassed and settings are also written by code.
export const SETTINGS_LIMITS = Object.freeze({
  idleThresholdSeconds: Object.freeze({
    min: MIN_IDLE_THRESHOLD_SECONDS,
    max: 3600,
    fallback: DEFAULT_IDLE_THRESHOLD_SECONDS,
  }),
  retentionDays: Object.freeze({
    min: 1,
    max: 3650,
    fallback: DEFAULT_RETENTION_DAYS,
  }),
});

// Default settings
export const DEFAULT_SETTINGS = {
  idleThresholdSeconds: DEFAULT_IDLE_THRESHOLD_SECONDS,
  trackingEnabled: true,
  excludedDomains: [],
  retentionDays: DEFAULT_RETENTION_DAYS,
  youtubeDeepTracking: true,
  // Off by default. Classification is on-device, but it is still inference over
  // the user's browsing data and must be an explicit choice.
  aiEnabled: false,
  logLevel: LOG_LEVEL,
};

// Settings removed in the move to on-device-only classification. Actively
// deleted on upgrade rather than left in place: aiApiKey held a third-party
// credential in plaintext, and a dead feature must not leave one behind.
export const REMOVED_SETTINGS_KEYS = Object.freeze(['aiApiKey', 'aiProvider']);
