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
  console.log(TAG, 'Page-context script loaded');

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
          console.log(TAG, 'Skipping stale ytInitialPlayerResponse — prId:', prVideoId, 'urlId:', urlVideoId);
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
        console.log(TAG, 'Rejecting extract — videoId mismatch. data:', data.videoId, 'url:', urlVideoId);
        data = null;
      }

      console.log(TAG, 'Extract request — result:',
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
                  console.log(TAG, 'fetch interceptor — new video:', data.videoId, '| cat:', data.videoCategory);
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

  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    const originalOpen = xhr.open;
    let requestUrl = '';

    xhr.open = function (method, url) {
      requestUrl = url || '';
      return originalOpen.apply(this, arguments);
    };

    xhr.addEventListener('load', function () {
      try {
        if (typeof requestUrl === 'string' && requestUrl.includes('/youtubei/v1/player')) {
          const json = JSON.parse(xhr.responseText);
          if (json && json.videoDetails) {
            try { window.ytInitialPlayerResponse = json; } catch {}
            const data = extractFromPlayerResponse(json);
            console.log(TAG, 'XHR interceptor — new video:', data.videoId, '| cat:', data.videoCategory);
            postToContentScript(data, 'xhr-interceptor');
          }
        }
      } catch (e) {}
    });

    return xhr;
  }
  try {
    window.XMLHttpRequest = PatchedXHR;
  } catch (e) {}

  // ─── Signal readiness to the isolated world ─────────────────────────

  postToContentScript({ __ready: true }, 'ready');
})();
