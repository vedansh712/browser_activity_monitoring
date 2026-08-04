// YouTube page-context extractor — runs in MAIN world (page's JS context).
// Loaded via manifest with "world": "MAIN" which bypasses CSP.
//
// This script CAN access window.ytInitialPlayerResponse, ytInitialData,
// and intercept YouTube's internal fetch calls for SPA navigations.
//
// It communicates with the isolated-world content script (youtube.js)
// via window.postMessage, which works across worlds because the DOM is shared.

(function () {
  'use strict';

  const TAG = '[Track Daily :: injected]';

  // This script runs in the page's own world and therefore has no access to
  // chrome.storage, so the user's log-level setting is unreachable here. Verbose
  // output is a build-time switch instead, defaulting to off: this code sees
  // every video title the user watches, and writing those into the page console
  // by default would leak them into somewhere the user does not expect.
  const DEBUG = false;

  function debug(...args) {
    if (DEBUG) console.log(TAG, ...args);
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  function getCurrentVideoIdFromURL() {
    try {
      const u = new URL(location.href);
      if (u.pathname.startsWith('/watch')) return u.searchParams.get('v') || '';
      if (u.pathname.startsWith('/shorts/')) {
        return u.pathname.split('/shorts/')[1]?.split('/')[0] || '';
      }
    } catch {}
    return '';
  }

  function cleanText(s) {
    if (!s || typeof s !== 'string') return '';
    return s.replace(/\s+/g, ' ').trim();
  }

  function extractFromPlayerResponse(pr) {
    if (!pr) return null;
    const details = pr.videoDetails || {};
    const micro = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};
    return {
      videoId: details.videoId || '',
      videoTitle: cleanText(details.title),
      channelName: cleanText(details.author),
      channelUrl: micro.ownerProfileUrl || '',
      videoDuration: parseInt(details.lengthSeconds, 10) || 0,
      videoCategory: cleanText(micro.category),
      isLiveStream: !!details.isLiveContent,
    };
  }

  // ─── Helper: send data to isolated-world content script ─────────────

  function postToContentScript(data, source) {
    window.postMessage(
      {
        __trackdaily: true,
        type: 'YT_META_FROM_PAGE',
        source: source || 'unknown',
        data,
      },
      location.origin
    );
  }

  // ─── Handler: respond to extract requests ───────────────────────────

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (!event.data || !event.data.__trackdaily) return;
    if (event.data.type !== 'YT_EXTRACT_REQUEST') return;

    try {
      const urlVideoId = getCurrentVideoIdFromURL();
      let data = null;

      // Method 1: Direct read of ytInitialPlayerResponse
      // Only trust it if its videoId matches the current URL (not stale)
      if (window.ytInitialPlayerResponse) {
        const pr = window.ytInitialPlayerResponse;
        const prVideoId = pr.videoDetails?.videoId || '';
        if (!urlVideoId || !prVideoId || prVideoId === urlVideoId) {
          data = extractFromPlayerResponse(pr);
        } else {
          debug('Skipping stale ytInitialPlayerResponse — prId:', prVideoId, 'urlId:', urlVideoId);
        }
      }

      // Method 2: Use player API — also verify videoId matches
      if (!data || !data.videoCategory) {
        try {
          const player = document.getElementById('movie_player');
          if (player && typeof player.getVideoData === 'function') {
            const vd = player.getVideoData();
            if (vd && (!urlVideoId || !vd.video_id || vd.video_id === urlVideoId)) {
              data = data || { videoId: urlVideoId };
              data.videoId = data.videoId || vd.video_id || '';
              data.videoTitle = data.videoTitle || cleanText(vd.title);
              data.channelName = data.channelName || cleanText(vd.author);
            }
          }
        } catch (e) {}
      }

      // Method 3: Pull category from ytInitialData if still missing
      if (data && !data.videoCategory && window.ytInitialData) {
        try {
          const results =
            window.ytInitialData.contents &&
            window.ytInitialData.contents.twoColumnWatchNextResults;
          if (results?.results?.results?.contents) {
            for (const item of results.results.results.contents) {
              const secondary = item.videoSecondaryInfoRenderer;
              if (secondary?.metadataRowContainer?.metadataRowContainerRenderer?.rows) {
                for (const r of secondary.metadataRowContainer.metadataRowContainerRenderer.rows) {
                  const row = r.metadataRowRenderer;
                  if (row?.title?.simpleText === 'Category') {
                    const cat = row.contents?.[0];
                    if (cat?.runs?.[0]?.text) {
                      data.videoCategory = cleanText(cat.runs[0].text);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {}
      }

      // Final safeguard: reject data if videoId doesn't match URL
      if (data && urlVideoId && data.videoId && data.videoId !== urlVideoId) {
        debug('Rejecting extract — videoId mismatch. data:', data.videoId, 'url:', urlVideoId);
        data = null;
      }

      debug('Extract request — result:',
        data ? { id: data.videoId, title: (data.videoTitle || '').substring(0, 30), cat: data.videoCategory } : 'null');
      postToContentScript(data, 'on-request');
    } catch (err) {
      console.warn(TAG, 'Extraction error:', err.message);
      postToContentScript(null, 'error');
    }
  });

  // ─── Intercept fetch for SPA navigations ────────────────────────────
  // YouTube loads /youtubei/v1/player when you navigate to a new video.
  // By intercepting, we catch the new player response and update.

  const originalFetch = window.fetch;
  window.fetch = function () {
    const fetchPromise = originalFetch.apply(this, arguments);

    try {
      const urlArg = arguments[0];
      const url = typeof urlArg === 'string' ? urlArg : urlArg?.url || '';

      if (url && url.includes('/youtubei/v1/player')) {
        fetchPromise
          .then((response) => {
            response
              .clone()
              .json()
              .then((json) => {
                if (json && json.videoDetails) {
                  // Update the global so subsequent extract requests see fresh data
                  try { window.ytInitialPlayerResponse = json; } catch {}
                  const data = extractFromPlayerResponse(json);
                  debug('fetch interceptor — new video:', data.videoId, '| cat:', data.videoCategory);
                  postToContentScript(data, 'fetch-interceptor');
                }
              })
              .catch(() => {});
          })
          .catch(() => {});
      }
    } catch (e) {}

    return fetchPromise;
  };

  // ─── Also catch XMLHttpRequest (older YouTube code paths) ───────────

  // Subclass rather than wrap.
  //
  // The previous version was a plain function that constructed and returned an
  // XMLHttpRequest. Replacing the global with it broke three contracts that
  // page code legitimately relies on: `xhr instanceof XMLHttpRequest` was
  // false, the static readyState constants (XMLHttpRequest.DONE and friends)
  // were undefined, and `new.target` was lost. Extending the original preserves
  // the prototype chain, the statics and instanceof for free.
  const OriginalXHR = window.XMLHttpRequest;

  class TrackDailyXHR extends OriginalXHR {
    #requestUrl = '';

    constructor(...args) {
      super(...args);
      this.addEventListener('load', () => {
        if (!this.#requestUrl.includes('/youtubei/v1/player')) return;
        try {
          const json = JSON.parse(this.responseText);
          if (!json || !json.videoDetails) return;
          try { window.ytInitialPlayerResponse = json; } catch {}
          postToContentScript(extractFromPlayerResponse(json), 'xhr-interceptor');
        } catch {
          // Non-JSON or cross-origin response; nothing to extract.
        }
      });
    }

    open(method, url, ...rest) {
      this.#requestUrl = typeof url === 'string' ? url : String(url ?? '');
      return super.open(method, url, ...rest);
    }
  }

  try {
    window.XMLHttpRequest = TrackDailyXHR;
  } catch {
    // Some pages freeze the global; the fetch interceptor above still applies.
  }

  // ─── Signal readiness to the isolated world ─────────────────────────

  postToContentScript({ __ready: true }, 'ready');
})();
