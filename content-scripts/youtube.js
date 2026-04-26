// YouTube content script — runs in ISOLATED world.
// Receives video metadata from the MAIN-world injected script (youtube-injected.js)
// via window.postMessage, then forwards to the service worker.
//
// Also watches the DOM for theater/fullscreen state changes using MutationObserver
// (YouTube theater mode doesn't fire the Fullscreen API's fullscreenchange event).

(function () {
  'use strict';

  const TAG = '[Track Daily]';
  console.log(TAG, 'YouTube content script loaded on', location.href);

  // ─── State ──────────────────────────────────────────────────────────

  let lastSentVideoId = null;
  let lastSentFingerprint = null;
  let lastTheaterOrFull = false;
  let pendingPageData = null;
  let lastPageDataVideoId = null;
  let lastUrl = location.href;
  let currentVideoId = getVideoId();

  // ─── Data sanitization helpers ──────────────────────────────────────

  /**
   * Collapse whitespace and trim. Removes embedded newlines/tabs/extra spaces
   * that often come from DOM textContent on nested elements.
   */
  function cleanText(s) {
    if (!s || typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim();
  }

  /**
   * Clean document.title for YouTube — strip the "(N)" notification prefix
   * AND the " - YouTube" suffix.
   */
  function cleanDocTitle(raw) {
    if (!raw) return '';
    return cleanText(
      raw
        .replace(/^\(\d+\)\s*/, '')           // strip (3) notification count
        .replace(/\s*-\s*YouTube\s*$/i, '')   // strip trailing "- YouTube"
    );
  }

  // ─── Receive data from the MAIN-world script ────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || !event.data.__trackdaily) return;
    if (event.data.type !== 'YT_META_FROM_PAGE') return;

    const pageData = event.data.data;

    if (pageData && pageData.__ready) {
      console.log(TAG, 'Injected script ready');
      // Trigger an initial extraction now that the bridge is up
      setTimeout(requestExtraction, 500);
      return;
    }

    if (!pageData) return;

    // Validate: page data's videoId must match the URL we're on.
    // Otherwise it's stale (from a previous video) — ignore it.
    const urlVideoId = getVideoId();
    if (pageData.videoId && urlVideoId && pageData.videoId !== urlVideoId) {
      console.log(TAG, 'Ignoring stale pageData — videoId mismatch',
        'pageData:', pageData.videoId, 'URL:', urlVideoId);
      return;
    }

    pendingPageData = pageData;
    lastPageDataVideoId = pageData.videoId || urlVideoId;
    processAndSend(pageData);
  });

  // ─── Request extraction from the injected script ────────────────────

  function requestExtraction() {
    window.postMessage(
      { __trackdaily: true, type: 'YT_EXTRACT_REQUEST' },
      location.origin
    );
  }

  // ─── Build full metadata and send to service worker ─────────────────

  function processAndSend(pageData) {
    const videoId = getVideoId();
    if (!videoId) return;

    // Safety: pageData must match current videoId or be null
    const pageDataMatches = pageData && pageData.videoId === videoId;
    const effectivePageData = pageDataMatches ? pageData : null;

    const meta = {
      videoId,
      videoTitle: '',
      channelName: '',
      channelUrl: '',
      videoDuration: 0,
      videoCategory: '',
      isLiveStream: false,
      isShort: location.pathname.startsWith('/shorts/'),
    };

    // Fill from page-context data (if it matches current videoId)
    if (effectivePageData) {
      meta.videoTitle = cleanText(effectivePageData.videoTitle);
      meta.channelName = cleanText(effectivePageData.channelName);
      meta.channelUrl = effectivePageData.channelUrl || '';
      meta.videoDuration = effectivePageData.videoDuration || 0;
      meta.videoCategory = cleanText(effectivePageData.videoCategory);
      meta.isLiveStream = !!effectivePageData.isLiveStream;
    }

    // DOM fallbacks for any missing fields
    fillFromDOM(meta);

    // Category inference from title as last resort
    if (!meta.videoCategory) {
      meta.videoCategory = inferCategoryFromTitle(meta.videoTitle);
    }

    // QUALITY GATE: require videoId AND a non-trivial title before sending.
    // Prevents sending partial/wrong data during SPA transitions.
    if (!meta.videoId) return;
    if (!meta.videoTitle || meta.videoTitle.length < 2) {
      // Schedule one more attempt after DOM settles
      return;
    }

    // Deduplicate — only skip if everything is identical (incl. title)
    const fingerprint = [
      meta.videoId,
      meta.videoTitle,
      meta.channelName,
      meta.videoCategory,
    ].join('|');
    if (fingerprint === lastSentFingerprint) return;

    lastSentFingerprint = fingerprint;
    lastSentVideoId = meta.videoId;

    console.log(TAG, 'YouTube metadata ready:', {
      videoId: meta.videoId,
      title: meta.videoTitle.substring(0, 60),
      channel: meta.channelName || '(no channel)',
      category: meta.videoCategory || '(no category)',
      duration: meta.videoDuration,
    });

    chrome.runtime.sendMessage({ type: 'YOUTUBE_META', data: meta }).catch((err) => {
      console.warn(TAG, 'sendMessage error:', err?.message);
    });
  }

  // ─── DOM helpers ────────────────────────────────────────────────────

  function fillFromDOM(meta) {
    if (!meta.videoTitle) {
      // Try multiple title sources
      meta.videoTitle =
        cleanText(getAttr('meta[property="og:title"]', 'content')) ||
        cleanText(getText('h1.ytd-watch-metadata yt-formatted-string')) ||
        cleanText(getText('h1.title yt-formatted-string')) ||
        cleanDocTitle(document.title);
    }
    if (!meta.channelName) {
      // Try specific channel selectors — avoid overly generic ones that
      // might grab "Subscribe" text or verified badge contents
      meta.channelName =
        cleanText(getText('ytd-channel-name #text a')) ||
        cleanText(getText('ytd-channel-name yt-formatted-string a')) ||
        cleanText(getText('ytd-video-owner-renderer .ytd-channel-name a')) ||
        cleanText(getText('#owner #channel-name a')) ||
        cleanText(getText('ytd-channel-name a')) ||
        '';
    }
    if (!meta.channelUrl) {
      const link =
        document.querySelector('ytd-channel-name #text a') ||
        document.querySelector('ytd-channel-name a') ||
        document.querySelector('ytd-video-owner-renderer a');
      if (link) meta.channelUrl = link.href || '';
    }
    if (!meta.videoCategory) {
      meta.videoCategory = cleanText(getAttr('meta[itemprop="genre"]', 'content'));
    }
    if (!meta.videoDuration) {
      const video = document.querySelector('video.html5-main-video');
      if (video && video.duration && isFinite(video.duration)) {
        meta.videoDuration = Math.round(video.duration);
      }
    }
  }

  function getText(selector) {
    const el = document.querySelector(selector);
    return el ? el.textContent : '';
  }

  function getAttr(selector, attr) {
    const el = document.querySelector(selector);
    return el ? el.getAttribute(attr) || '' : '';
  }

  function getVideoId() {
    try {
      const url = new URL(location.href);
      if (url.pathname.startsWith('/watch')) {
        return url.searchParams.get('v') || null;
      }
      if (url.pathname.startsWith('/shorts/')) {
        return url.pathname.split('/shorts/')[1]?.split('/')[0] || null;
      }
    } catch {}
    return null;
  }

  function inferCategoryFromTitle(title) {
    if (!title) return '';
    const t = title.toLowerCase();
    const hints = {
      Education: [
        'tutorial', 'course', 'learn', 'explained', 'how to', 'lecture', 'lesson',
        'programming', 'python', 'javascript', 'coding', 'beginners', 'complete guide',
        'crash course', 'masterclass', 'for beginners', 'step by step', 'in hindi',
        'full course', 'web development', 'data science', 'machine learning',
      ],
      'Science & Technology': [
        'tech', 'review', 'unboxing', 'setup', 'software', 'hardware', ' ai ',
        'gadget', 'benchmark',
      ],
      Music: [
        'official video', 'official audio', 'music video', 'lyrics',
        'album', 'remix',
      ],
      Gaming: [
        'gameplay', 'walkthrough', 'playthrough', 'gaming', 'lets play',
        'minecraft', 'fortnite', 'valorant',
      ],
      'News & Politics': ['politics', 'election', 'debate'],
      Entertainment: ['funny', 'comedy', 'prank', 'challenge', 'reaction', 'vlog'],
    };
    for (const [category, keywords] of Object.entries(hints)) {
      if (keywords.some((k) => t.includes(k))) return category;
    }
    return '';
  }

  // ─── Listen for re-request messages from service worker ─────────────

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'REREQUEST_YT_META') {
      console.log(TAG, 'Re-extraction requested by service worker');
      // Reset dedup so we re-send
      lastSentFingerprint = null;
      lastSentVideoId = null;
      requestExtraction();
      // Also try DOM-based extraction shortly after
      setTimeout(() => processAndSend(pendingPageData), 1500);
      // Re-report theater/fullscreen state — the service worker may have
      // reset it on tab switch and needs to know our current state
      lastTheaterOrFull = null; // Force re-send even if state is same
      checkTheaterFullscreen();
    }
  });

  // ─── Navigation handling ────────────────────────────────────────────

  function onNavigate() {
    const newVideoId = getVideoId();
    console.log(TAG, 'Navigation detected — new videoId:', newVideoId, 'old:', currentVideoId);

    // CRITICAL: clear stale pending data from the previous video
    pendingPageData = null;
    lastPageDataVideoId = null;
    lastSentFingerprint = null;
    lastSentVideoId = null;
    currentVideoId = newVideoId;

    // Request fresh data from the injected script
    setTimeout(requestExtraction, 1200);
    // Scheduled DOM-only attempt as backup (only uses current DOM, no stale pageData)
    setTimeout(() => processAndSend(null), 2800);
  }

  document.addEventListener('yt-navigate-finish', onNavigate);
  window.addEventListener('popstate', onNavigate);

  // URL change observer (catch-all). Only fires when videoId actually changes
  // to avoid triggering on notification-count updates in document.title.
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      const newVid = getVideoId();
      const oldVid = currentVideoId;
      lastUrl = location.href;
      // Only treat as navigation if the videoId changed (not just query params)
      if (newVid !== oldVid) {
        onNavigate();
      }
    }
  });
  const titleEl = document.querySelector('title');
  if (titleEl) {
    urlObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // Initial extraction when script loads
  function initialExtract() {
    setTimeout(() => {
      requestExtraction();
      setTimeout(() => processAndSend(pendingPageData), 2000);
    }, 800);
  }
  if (document.readyState === 'complete') {
    initialExtract();
  } else {
    window.addEventListener('load', initialExtract);
  }

  // ─── Theater / Fullscreen detection ─────────────────────────────────

  function checkTheaterFullscreen() {
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    const isTheater = watchFlexy ? watchFlexy.hasAttribute('theater') : false;
    const isFullscreenAttr = watchFlexy ? watchFlexy.hasAttribute('fullscreen') : false;
    const isFullscreenAPI = !!document.fullscreenElement;

    const isExpanded = isTheater || isFullscreenAttr || isFullscreenAPI;

    if (isExpanded !== lastTheaterOrFull) {
      lastTheaterOrFull = isExpanded;
      console.log(TAG, 'YouTube expanded state changed:', isExpanded,
        '| theater:', isTheater, '| fullscreen:', isFullscreenAttr || isFullscreenAPI);
      chrome.runtime.sendMessage({
        type: 'YOUTUBE_THEATER',
        data: { isExpanded, isTheater, isFullscreen: isFullscreenAttr || isFullscreenAPI },
      }).catch(() => {});
    }
  }

  const bodyObserver = new MutationObserver(checkTheaterFullscreen);

  function startTheaterObserver() {
    const watchFlexy = document.querySelector('ytd-watch-flexy');
    if (watchFlexy) {
      bodyObserver.observe(watchFlexy, {
        attributes: true,
        attributeFilter: ['theater', 'fullscreen'],
      });
      checkTheaterFullscreen();
    } else {
      setTimeout(startTheaterObserver, 1000);
    }
  }
  startTheaterObserver();

  document.addEventListener('fullscreenchange', checkTheaterFullscreen);
  setInterval(checkTheaterFullscreen, 5000);
})();
