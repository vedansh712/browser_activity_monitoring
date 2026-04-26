# Track Daily - Comprehensive Project Report

**Version:** 1.0.0  
**Project Type:** Chrome Browser Extension  
**Date Created:** April 26, 2026

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [File Structure and Architecture](#file-structure-and-architecture)
3. [Detailed Component Analysis](#detailed-component-analysis)
4. [Technologies and Dependencies](#technologies-and-dependencies)
5. [Component Interactions](#component-interactions)
6. [Data Models and Storage](#data-models-and-storage)
7. [Key Features and Workflows](#key-features-and-workflows)

---

## 1. Project Overview

### Purpose
**Track Daily** is a comprehensive browser extension designed to monitor and analyze user browsing habits with intelligent time tracking, automatic categorization, and deep YouTube analytics. It helps users understand where their time goes online by providing detailed statistics, visual analytics, and behavioral insights.

### Key Capabilities
- **Browsing Activity Tracking**: Real-time monitoring of websites visited and time spent
- **Automatic Categorization**: Multi-level classification using domain rules, keywords, AI, and similarity matching
- **YouTube Deep Analytics**: Advanced video metadata extraction (video title, channel, category, duration)
- **Idle Detection**: Automatic pause when user is inactive
- **Data Persistence**: IndexedDB storage for sessions, aggregates, and analytics
- **Visual Dashboard**: Daily, weekly, and monthly analytics with charts and breakdowns
- **Customizable Categories**: User-defined categories and domain overrides
- **AI-Powered Classification**: Optional integration with ChatGPT, Claude, or Google Gemini for smart categorization
- **Data Export**: Export browsing history and analytics

---

## 2. File Structure and Architecture

```
Track Daily/
├── manifest.json                      # Chrome extension manifest (MV3)
├── background/                        # Service worker (background logic)
│   ├── service-worker.js             # Main background script and event handlers
│   ├── tracker.js                    # Session tracking and lifecycle
│   ├── storage-manager.js            # IndexedDB and chrome.storage operations
│   ├── category-engine.js            # Classification logic (7-step pipeline)
│   ├── ai-classifier.js              # AI-powered categorization
│   ├── message-router.js             # Message handler between components
│   └── idle-manager.js               # Idle detection wrapper
├── content-scripts/                   # Scripts injected into web pages
│   ├── generic.js                    # Generic page tracking (all sites)
│   ├── youtube.js                    # YouTube metadata extraction (isolated world)
│   └── youtube-injected.js           # YouTube page context access (main world)
├── popup/                            # Quick-access popup UI
│   ├── popup.html                    # Popup layout
│   ├── popup.js                      # Popup interactivity and stats
│   └── popup.css                     # Popup styling
├── dashboard/                        # Detailed analytics dashboard
│   ├── dashboard.html                # Dashboard layout
│   ├── dashboard.js                  # Dashboard logic and visualization
│   ├── dashboard.css                 # Dashboard styling
│   └── components/                   # Reusable UI components (future)
├── options/                          # Settings/preferences page
│   ├── options.html                  # Settings layout
│   ├── options.js                    # Settings management
│   └── options.css                   # Settings styling
├── shared/                           # Shared utilities and constants
│   ├── constants.js                  # Global constants, default categories, message types
│   ├── data-models.js                # Session and aggregate data structures
│   └── utils.js                      # Helper functions (date, formatting, tokenization)
├── lib/                              # External libraries
│   └── chart.umd.min.js             # Chart rendering library
└── icons/                            # Extension icons
    ├── icon-16.png
    ├── icon-48.png
    └── icon-128.png
```

---

## 3. Detailed Component Analysis

### 3.1 Core Background Service (`background/service-worker.js`)

**Purpose**: Main orchestrator for tracking logic, event handling, and system coordination

**Key Functions**:
- `init()` - Initialize extension on install/startup
- `startTrackingTab(tab)` - Begin session for active tab
- `handleUserIdle(source)` - Pause tracking when user is idle
- `handleUserActive()` - Resume tracking when user returns
- `rebuildTodayAggregate()` - Recalculate daily statistics
- `checkIfMediaPlaying()` - Check if audio/video is playing

**Key Event Listeners**:
```javascript
// Tab activation and updates
chrome.tabs.onActivated.addListener() // Track tab switches
chrome.tabs.onUpdated.addListener()   // Track navigation
chrome.tabs.onRemoved.addListener()  // Clean up closed tabs

// Window focus changes
chrome.windows.onFocusChanged.addListener()

// Periodic tasks
chrome.alarms.onAlarm.addListener()
```

**Critical Logic**:
- Implements YouTube fullscreen/theater mode detection to continue tracking during expanded playback
- Resets YouTube expand flags on tab switches to prevent state persistence issues
- Coordinates between idle detection and session tracking
- Manages category classification pipeline (delegates to `category-engine.js`)

---

### 3.2 Session Tracker (`background/tracker.js`)

**Purpose**: Manage individual browsing session lifecycle and metadata

**Key Functions**:
```javascript
startNewSession(tab, categoryId)           // Create new tracking session
endCurrentSession()                         // Finalize and save session
pauseCurrentSession()                       // Pause without ending
resumeCurrentSession()                       // Resume paused session
updateSessionMeta(meta)                     // Update with YouTube/page info
updateSessionCategory(categoryId)           // Change category
flushCurrentSession()                       // Save partial session snapshot
```

**Session Structure**:
```javascript
{
  id: string,                    // Unique identifier
  url: string,                   // Full URL
  domain: string,                // Extracted hostname
  title: string,                 // Page title
  categoryId: string,            // Assigned category
  startTime: number,             // Unix timestamp
  endTime: number,               // Unix timestamp
  duration: number,              // Total time (ms)
  isActive: boolean,             // Currently tracking
  date: string,                  // YYYY-MM-DD
  meta: {                        // YouTube metadata
    videoId: string,
    videoTitle: string,
    channelName: string,
    videoDuration: number,
    videoCategory: string,
    isLiveStream: boolean
  }
}
```

---

### 3.3 Storage Management (`background/storage-manager.js`)

**Purpose**: Unified interface for all data persistence operations

**Storage Types**:
1. **IndexedDB** (`track_daily_db`):
   - `sessions` store - Browse activity records
   - `aggregates` store - Daily/weekly/monthly statistics
   - `similarity_data` store - Machine learning data for classification

2. **chrome.storage.local** - Settings and categories (persistent)

3. **chrome.storage.session** - Current session and state (ephemeral, cleared on browser restart)

**Key Functions**:
```javascript
// Session operations
saveSession(session)
getSessionsByDate(dateStr)
getSessionsForDateRange(startDate, endDate)

// Aggregates
saveAggregate(aggregate)
getAggregate(dateStr)
getAggregatesForRange(startDate, endDate)

// Settings/Categories
getSettings()
getCategories()
addDomainOverride(domain, categoryId)

// Lifecycle
pruneOldData(retentionDays)
resetEverything()
```

**Database Schema**:
```javascript
// Sessions index
index('date', { unique: false })        // Query by date
index('domain', { unique: false })      // Query by domain
index('categoryId', { unique: false })  // Query by category

// Aggregates key
keyPath: 'date'                         // Daily aggregates keyed by date

// Similarity data
index('categoryId', { unique: false })
index('domain', { unique: false })
```

---

### 3.4 Category Engine (`background/category-engine.js`)

**Purpose**: Seven-step intelligent classification pipeline

**Classification Steps** (in order):
1. **Domain Override** - Check user's manual assignments (highest priority)
2. **Domain Rules** - Match against built-in and custom patterns
3. **YouTube Sub-classification** - Refine YouTube videos by channel/category
4. **Keyword Heuristics** - Score page title, description, URL for keywords
5. **Similarity Matching** - Compare against learned user categorizations
6. **AI Classification** - External AI if available (ChatGPT, Claude, Gemini)
7. **Default** - Mark as 'uncategorized' if no match (prompts user)

**Rule Types**:
- `domain`: Exact match (e.g., `github.com`)
- `domain_contains`: Partial match (e.g., `contains: "github"`)
- `url_regex`: Regular expression matching

**Key Functions**:
```javascript
classifyPage({ domain, url, title, metaDescription, youtubeMeta })
  → { categoryId: string, method: string }

matchDomainRules(domain, url, categories)
classifyYouTube(youtubeMeta, categories)
matchKeywords(title, metaDescription, url)
matchSimilarity(domain, title)
learnFromUserCategorization(domain, title, categoryId)
```

**Built-in Categories** (9 total):
- **Social Media**: Facebook, Twitter, Instagram, Reddit, LinkedIn, TikTok, etc.
- **Entertainment**: YouTube, Netflix, Twitch, Spotify, Disney+, etc.
- **News & Media**: News sites, tech publications
- **Productivity & Work**: Google Workspace, Notion, Slack, Teams, etc.
- **Development**: GitHub, Stack Overflow, NPM, etc.
- **Shopping**: Amazon, eBay, etc.
- **Education**: Online learning platforms
- **Health & Fitness**: Fitness and health websites
- **Other**: Miscellaneous sites

---

### 3.5 AI Classifier (`background/ai-classifier.js`)

**Purpose**: Leverage AI models for smart categorization

**Supported Providers**:
1. **Chrome Built-in AI** (Gemini Nano) - No API key needed
2. **OpenAI** (GPT-4 mini)
3. **Anthropic** (Claude Haiku)
4. **Google Gemini**

**Caching**: Per-domain results cached to avoid repeated calls for same domain

**Prompt Structure**:
```
Classify this website into exactly one of these categories: [list].
Website: domain='example.com', title='Page Title', description='Meta desc'.
Reply with ONLY the category name, nothing else.
```

---

### 3.6 Message Router (`background/message-router.js`)

**Purpose**: Central hub for inter-component communication

**Message Types**:

| Message | Source | Handler | Purpose |
|---------|--------|---------|---------|
| `PAGE_INFO` | Generic content script | Update session title/metadata |
| `YOUTUBE_META` | YouTube content script | Update with video metadata |
| `YOUTUBE_FULLSCREEN` | YouTube content script | Track fullscreen mode |
| `YOUTUBE_THEATER` | YouTube content script | Track theater/expanded mode |
| `VISIBILITY_CHANGE` | Generic content script | Pause/resume on tab visibility |
| `GET_CURRENT_SESSION` | Popup/Dashboard | Fetch active session |
| `GET_TODAY_STATS` | Popup/Dashboard | Fetch daily metrics |
| `GET_SESSIONS` | Dashboard | Fetch sessions for date range |
| `GET_AGGREGATES` | Dashboard | Fetch aggregates for date range |
| `TOGGLE_TRACKING` | Popup | Enable/disable tracking |
| `CATEGORIZE_DOMAIN` | Popup | Manual categorization |
| `GET_UNCATEGORIZED` | Popup | List uncategorized domains |
| `CLEAR_HISTORY` | Options | Delete all browsing data |
| `RESET_EVERYTHING` | Options | Factory reset |

**Uncategorized Domain Tracking**:
- Domains without successful classification are tracked
- Extension badge shows count of uncategorized domains
- User prompted to categorize via popup UI
- Learned for future similarity matching

---

### 3.7 Idle Detection (`background/idle-manager.js`)

**Purpose**: Detect user inactivity and pause tracking

**Default Threshold**: 120 seconds

**Detection States**:
- `idle` - User away from keyboard
- `locked` - Screen locked
- `active` - User returned

**Callbacks**:
```javascript
onIdle(source)      // Pause session
onActive()          // Resume session
```

---

### 3.8 Generic Content Script (`content-scripts/generic.js`)

**Purpose**: Track basic page information on all websites

**Functionality**:
- Sends page title and meta description on page load
- Tracks visibility changes (tab hidden/shown)
- Sends data on SPA route changes

**Events Tracked**:
```javascript
window.addEventListener('load', sendPageInfo)
document.addEventListener('visibilitychange', trackVisibility)
MutationObserver on <title> element
```

---

### 3.9 YouTube Integrated Tracking (`content-scripts/youtube.js` + `youtube-injected.js`)

**Architecture**: Two-tier system to bypass Content Security Policy

**youtube-injected.js** (Main World):
- Runs in page's JavaScript context
- Accesses `window.ytInitialPlayerResponse` and YouTube's player API
- Extracts complete metadata

**youtube.js** (Isolated World):
- Runs in extension's isolated context
- Receives data from injected script via `window.postMessage`
- Fills gaps from DOM parsing
- Sends to service worker

**Data Extracted**:
```javascript
{
  videoId: string,            // YouTube video ID
  videoTitle: string,         // Video title
  channelName: string,        // Channel author
  channelUrl: string,         // Channel URL
  videoDuration: number,      // Duration in seconds
  videoCategory: string,      // YouTube's category
  isLiveStream: boolean,      // Live stream flag
  isShort: boolean           // YouTube Shorts indicator
}
```

**Video Source Methods** (in order of preference):
1. `ytInitialPlayerResponse` - Direct from YouTube API response
2. Player API (`getVideoData()`)
3. `ytInitialData` - Embedded page data
4. DOM parsing - Fallback extraction
5. Title inference - Category guessing from title

**Safeguards**:
- Validates video ID matches current URL
- Rejects stale data from previous videos
- Quality gates (requires videoId + non-trivial title)
- Deduplicates identical metadata
- Handles SPA navigation via fetch interception

---

### 3.10 Popup UI (`popup/popup.js`)

**Purpose**: Quick-access widget for daily stats and uncategorized domains

**Displays**:
- Current domain and live session timer
- Today's total tracked time
- Top 5 domains by duration
- Category breakdown (pie chart)
- Tracking toggle switch

**Features**:
- Real-time session timer (updates every 1s)
- Pie chart visualization using `chart.js`
- Uncategorized domain notice with quick categorization buttons
- Links to full dashboard and settings

**Key Functions**:
```javascript
loadStats()              // Fetch data from service worker
renderTopDomains()       // Create domain list with bars
renderCategoryChart()    // Draw pie chart
startSessionTimer()      // Update timer every second
```

---

### 3.11 Dashboard (`dashboard/dashboard.js`)

**Purpose**: Comprehensive analytics interface

**Views**:
1. **Overview** - Aggregate statistics and trends
2. **Domains** - Detailed domain breakdown
3. **YouTube** - YouTube-specific analytics
4. **Categories** - Category performance metrics

**Time Ranges**:
- Daily (24 hours)
- Weekly (Mon-Sun)
- Monthly (full month)

**Visualizations**:
- Time series charts
- Pie charts for category/domain breakdown
- Bar charts for comparisons
- Top performers lists

**Features**:
- Date navigation (previous/next period)
- Data export (CSV, JSON)
- Real-time updates
- Responsive design

---

### 3.12 Settings Page (`options/options.js`)

**Purpose**: User configuration and preferences

**Settings Managed**:
```javascript
{
  trackingEnabled: boolean,         // Master on/off
  idleThresholdSeconds: number,     // Idle timeout
  retentionDays: number,            // Data retention period
  youtubeDeepTracking: boolean,     // YouTube metadata extraction
  excludedDomains: string[],        // Domains to skip
  aiProvider: 'none'|'openai'|'anthropic'|'gemini',
  aiApiKey: string,
}
```

**Categories Configuration**:
- Built-in categories (read-only)
- Custom categories (user-defined)
- Domain overrides (manual assignments)
- Channel overrides (YouTube channel assignments)

---

## 4. Technologies and Dependencies

### Technologies Used

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Manifest** | Manifest V3 | Chrome extension specification |
| **Storage** | IndexedDB | Local database for sessions/aggregates |
| **Storage** | chrome.storage API | Local and session storage |
| **Runtime** | Service Worker | Background execution |
| **Content Scripts** | ES6 Modules | Page injection for tracking |
| **Messaging** | chrome.runtime.sendMessage | Inter-component communication |
| **Idle Detection** | chrome.idle API | User activity detection |
| **Alarms** | chrome.alarms API | Periodic tasks |
| **UI** | HTML5/CSS3 | Interface rendering |
| **Visualization** | chart.js (UMD bundle) | Chart rendering |
| **APIs** | OpenAI/Anthropic/Google APIs | Optional AI classification |

### Permissions Required

```json
{
  "permissions": [
    "tabs",              // Access tab information
    "idle",              // Monitor user idle state
    "storage",           // Access chrome.storage
    "alarms",            // Schedule periodic tasks
    "webNavigation",     // Track navigation events
    "unlimitedStorage"   // Bypass storage quota
  ],
  "host_permissions": [
    "*://*.youtube.com/*" // YouTube special access
  ]
}
```

### External Dependencies
- **chart.js** - Charting library for visualizations
- **OpenAI API** - Optional GPT-4 mini integration
- **Anthropic API** - Optional Claude integration
- **Google Generative AI API** - Optional Gemini integration
- **Chrome Built-in AI** (Experimental) - Gemini Nano

### Browser APIs Used
- `chrome.tabs` - Tab management
- `chrome.runtime` - Extension runtime and messaging
- `chrome.storage` - Data persistence
- `chrome.idle` - Idle state detection
- `chrome.alarms` - Scheduling
- `chrome.windows` - Window management
- `chrome.action` - Extension icon/badge
- `indexedDB` - Client-side database
- `Fetch API` - HTTP requests (AI APIs)

---

## 5. Component Interactions

### 5.1 Data Flow Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         USER ACTIONS                             │
└────────────────────────┬────────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼
    ┌────────┐    ┌──────────┐    ┌────────────┐
    │Popup   │    │Dashboard │    │Options Page│
    │(UI)    │    │(UI)      │    │(UI)        │
    └────────┘    └──────────┘    └────────────┘
        │                │                │
        │ sendMessage    │ sendMessage    │ sendMessage
        ├────────────────┼────────────────┤
        │                │                │
        ▼                ▼                ▼
    ┌────────────────────────────────────────────┐
    │      Service Worker (Background Script)     │
    │  ┌──────────────────────────────────────┐  │
    │  │ Message Router (message-router.js)   │  │
    │  │  • Route incoming messages           │  │
    │  │  • Update uncategorized domain list  │  │
    │  │  • Trigger AI classification         │  │
    │  └──────────────────────────────────────┘  │
    │                  ▲                          │
    │                  │                          │
    │  ┌───────────────┼────────────────────┐   │
    │  │               │                    │   │
    │  ▼               ▼                    ▼   │
    │ ┌──────────┐ ┌─────────────┐ ┌──────────┐│
    │ │ Tracker  │ │ Category    │ │ AI       ││
    │ │(Session  │ │ Engine      │ │Classifier││
    │ │Lifecycle)│ │(7-step      │ │          ││
    │ │          │ │ pipeline)   │ └──────────┘│
    │ └──────────┘ └─────────────┘             │
    │       │              │                    │
    │       ▼              ▼                    │
    │ ┌─────────────────────────────┐          │
    │ │ Storage Manager             │          │
    │ │ • IndexedDB operations      │          │
    │ │ • chrome.storage operations │          │
    │ │ • Data persistence          │          │
    │ └─────────────────────────────┘          │
    └────────────────────────────────────────────┘
        │        ▲        │        ▲
        │        │        │        │
        ├────────┼────────┼────────┘
        │        │        │
        ▼        │        ▼
    ┌─────────────────────────────┐
    │    IndexedDB Database        │
    │  • sessions store            │
    │  • aggregates store          │
    │  • similarity_data store     │
    └─────────────────────────────┘
        │        │
        ▼        ▼
    ┌─────────────────────────────┐
    │ chrome.storage.local        │
    │ • Settings                  │
    │ • Categories                │
    │ • Domain overrides          │
    └─────────────────────────────┘
        │        │
        ▼        ▼
    ┌─────────────────────────────┐
    │ chrome.storage.session      │
    │ • Current session           │
    │ • YouTube expand state      │
    │ • Tracking state            │
    └─────────────────────────────┘
```

### 5.2 Page Tracking Flow

```
User visits website.com
        │
        ▼
Browser tab activates
        │
        ▼
Service Worker: chrome.tabs.onActivated
        │
        ▼
Extract domain from URL
        │
        ▼
Check excluded domains
        │
        ▼
Create new session in tracker.js
        │
        ▼
Classify domain (category-engine.js pipeline)
        │
        ├─ Step 1-6: Check override/rules/keywords/similarity/AI
        │
        ├─ If matched: ✓ Set category
        │
        └─ If not matched: Add to uncategorized queue, prompt user
        │
        ▼
Update extension badge (if uncategorized)
        │
        ▼
Save to chrome.storage.session (current session)
        │
        ▼
(Every 5 min) Flush session to IndexedDB
        │
        ▼
(Periodic) Rebuild daily aggregate from sessions
```

### 5.3 YouTube Metadata Extraction Flow

```
User visits youtube.com/watch?v=VIDEO_ID
        │
        ▼
youtube-injected.js (Main world) initializes
        │
        ▼
Waits for ytInitialPlayerResponse to load
        │
        ▼
youtube.js (Isolated world) sends extraction request
        │
        ▼
youtube-injected.js extracts data:
  ├─ Method 1: ytInitialPlayerResponse.videoDetails
  ├─ Method 2: player.getVideoData()
  ├─ Method 3: ytInitialData parsing
  ├─ Method 4: DOM fallback
        │
        ▼
Validates video ID matches URL (anti-stale)
        │
        ▼
Posts data back to youtube.js via postMessage
        │
        ▼
youtube.js cleans and augments:
  ├─ Sanitizes strings
  ├─ Fills missing fields from DOM
  └─ Infers category if missing
        │
        ▼
Quality gate: Require videoId + title
        │
        ▼
Deduplicate against last sent fingerprint
        │
        ▼
Send to service worker via chrome.runtime.sendMessage
        │
        ▼
Service Worker: YOUTUBE_META message handler
        │
        ▼
Update current session metadata
        │
        ▼
Classify video (YouTube-specific rules)
        │
        ├─ Check channel override
        ├─ Map YouTube category → our category
        └─ Keyword heuristics on title
        │
        ▼
Update session category
```

### 5.4 Categorization Decision Tree

```
Domain received
        │
        ├─ Step 1: Domain Override? ─ YES ─→ Use override
        │
        ├─ Step 2: Match domain rules? ─ YES ─→ Apply rule
        │              ├─ Is YouTube? ─ YES ─→ YouTube sub-classify
        │              │                  ├─ Check channel override
        │              │                  ├─ Map YouTube category
        │              │                  └─ Title keyword heuristics
        │              │
        │              └─ NO ─→ Continue
        │
        ├─ Step 3: Keyword heuristics (title+desc+url) ─ YES ─→ Categorize
        │
        ├─ Step 4: Similarity to past categorizations ─ YES ─→ Categorize
        │
        ├─ Step 5: AI Classification ─ YES ─→ Categorize
        │
        └─ Step 6: No match ─ Mark UNCATEGORIZED
                └─ Add to uncategorized queue
                └─ Update badge
                └─ Prompt user to categorize
```

### 5.5 Message Flow Example: Get Daily Stats

```
User opens popup
        │
        ▼
popup.js: loadStats()
        │
        ▼
chrome.runtime.sendMessage({
  type: MSG.GET_TODAY_STATS
})
        │
        ▼
Service Worker receives message
        │
        ▼
message-router.js: MSG.GET_TODAY_STATS handler
        │
        ├─ todayKey() → "2025-04-26"
        │
        ├─ storage.getAggregate("2025-04-26")
        │   └─ Opens IndexedDB aggregates store, retrieves record
        │
        ├─ If not exists, rebuild from sessions:
        │   ├─ storage.getSessionsByDate("2025-04-26")
        │   ├─ buildAggregate() computes totals
        │   └─ storage.saveAggregate() persists
        │
        ├─ storage.getCurrentSession()
        │   └─ Reads from chrome.storage.session
        │
        └─ Return { aggregate, currentSession }
        │
        ▼
Popup receives response
        │
        ▼
renderTopDomains(aggregate.domainBreakdown)
renderCategoryChart(aggregate.categoryBreakdown)
Update total time display
```

---

## 6. Data Models and Storage

### 6.1 Session Data Model

```javascript
{
  // Identification
  id: "550e8400-e29b-41d4-a716-446655440000",  // UUID
  date: "2025-04-26",                           // YYYY-MM-DD
  
  // Location
  url: "https://github.com/user/repo",
  domain: "github.com",
  title: "GitHub - user/repo",
  
  // Categorization
  categoryId: "development",
  
  // Timing
  startTime: 1703001234567,                     // Unix ms
  endTime: 1703001289567,
  duration: 55000,                              // ms
  isActive: false,
  
  // YouTube metadata
  meta: {
    videoId: "dQw4w9WgXcQ",
    videoTitle: "How to Learn Web Development",
    channelName: "Tech Academy",
    channelUrl: "https://youtube.com/channel/UC...",
    videoDuration: 1234,                        // seconds
    videoCategory: "Education",
    isLiveStream: false
  }
}
```

### 6.2 Aggregate Data Model

```javascript
{
  date: "2025-04-26",
  totalTime: 18000000,                          // ms (5 hours)
  sessionCount: 42,
  
  // Time per domain
  domainBreakdown: {
    "github.com": 3600000,
    "stackoverflow.com": 2700000,
    "youtube.com": 5400000,
    // ...
  },
  
  // Time per category
  categoryBreakdown: {
    "development": 6300000,
    "entertainment": 8100000,
    "productivity": 3600000
  },
  
  // Top pages
  topPages: [
    {
      url: "https://github.com/user/repo",
      title: "GitHub - user/repo",
      domain: "github.com",
      totalTime: 1800000
    },
    // ...
  ],
  
  // YouTube-specific stats
  youtubeStats: {
    totalTime: 5400000,
    videoCount: 15,
    topChannels: [
      { name: "Tech Academy", time: 2700000 },
      { name: "DevTube", time: 1800000 }
    ],
    categoryBreakdown: {
      "Education": 3600000,
      "Entertainment": 1800000
    }
  }
}
```

### 6.3 Similarity Data Entry (Machine Learning)

```javascript
{
  id: "uuid",
  domain: "example.com",
  title: "Example Page",
  titleTokens: ["example", "page"],            // Tokenized, de-stopped
  domainTokens: ["example"],
  categoryId: "productivity"
}
```

### 6.4 Settings Storage

```javascript
{
  trackingEnabled: true,
  idleThresholdSeconds: 120,
  retentionDays: 90,
  youtubeDeepTracking: true,
  excludedDomains: ["localhost:*", "127.0.0.1"],
  
  // AI Configuration
  aiProvider: "openai" | "anthropic" | "gemini" | "none",
  aiApiKey: "sk-..." // encrypted recommended
}
```

### 6.5 Categories Storage

```javascript
{
  builtIn: [ /* DEFAULT_CATEGORIES */ ],
  custom: [
    {
      id: "custom_1",
      name: "Client Sites",
      color: "#FF5733",
      icon: "🏢",
      rules: [
        { type: "domain", value: "client.com" }
      ]
    }
  ],
  domainOverrides: {
    "mysite.com": "productivity",
    "competitor.com": "research"
  },
  channelOverrides: {
    "Tech Academy": "education",
    "Gaming Channel": "entertainment"
  }
}
```

---

## 7. Key Features and Workflows

### 7.1 Automatic Session Lifecycle

**Session Creation**:
1. User navigates to new tab or activates existing tab
2. Service worker extracts domain from tab URL
3. Checks if domain is excluded
4. Creates new session with `startTime = Date.now()`
5. Initiates classification pipeline
6. Updates UI

**Session Flushing** (every 5 minutes via alarm):
1. Service worker alarm triggers
2. Current session is "frozen" as completed session
3. Copy saved to IndexedDB with unique ID
4. Current session keeps running
5. Daily aggregates rebuilt from all sessions

**Session Ending**:
1. Tab closed or navigation to non-trackable URL
2. Service worker ends current session
3. Duration calculated: `endTime - startTime`
4. Saved to IndexedDB (if > 1 second)
5. Current session cleared

**Idle Handling**:
1. Chrome idle API detects user inactive (default 120s)
2. Service worker calls `pauseCurrentSession()`
3. Session "frozen" with partial duration
4. Session timer stopped but marked active
5. On user return: `resumeCurrentSession()` resets timer

---

### 7.2 Smart Categorization Pipeline

**7-Step Classification Process**:

| Step | Source | Match Type | Example |
|------|--------|-----------|---------|
| 1 | User manual | Exact | User says github.com → development |
| 2 | Built-in/custom rules | Domain pattern | Domain rule: github.com → development |
| 3 | YouTube special | Channel/category map | YouTube category "Music" → entertainment |
| 4 | Keyword hints | String matching | Keywords in title/description |
| 5 | Similarity learning | Cosine/Jaccard | Title similar to past pages |
| 6 | AI model | LLM inference | ChatGPT categorizes based on content |
| 7 | Default | None | Mark uncategorized, prompt user |

**Keyword Heuristics Example**:
```javascript
KEYWORD_HINTS = {
  'education': ['tutorial', 'course', 'learn', 'explained', 'programming'],
  'news': ['news', 'breaking', 'report', 'politics'],
  'development': ['code', 'developer', 'github', 'npm', 'react']
}
```

**Similarity Matching**:
- Tokenizes page title (removes stop words, short words)
- Computes Jaccard similarity against learned entries
- Returns category if similarity > 0.25 threshold
- Learns new similarities when user manually categorizes

---

### 7.3 YouTube Deep Analytics

**Data Collection**:
1. Detects YouTube watch/shorts pages
2. Extracts video metadata from multiple sources
3. Maps YouTube's native categories to extension categories
4. Tracks channel names for channel-specific preferences
5. Detects fullscreen/theater mode to continue tracking