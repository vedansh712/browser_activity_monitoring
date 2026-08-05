// Generic content script — runs on all pages.
// Reports page info, visibility changes, and whether media is actually playing.

(function () {
  'use strict';

  // Kept in sync with MEDIA_SIGNAL_REFRESH_MS in shared/constants.js. Content
  // scripts are not loaded as ES modules, so the value cannot be imported.
  const MEDIA_REFRESH_MS = 5000;

  function send(type, data) {
    chrome.runtime.sendMessage({ type, data }).catch(() => {
      // Extension context may be invalidated during reload; nothing to do.
    });
  }

  // ─── Page info ──────────────────────────────────────────────────────

  function sendPageInfo() {
    const metaDesc = document.querySelector('meta[name="description"]');
    send('PAGE_INFO', {
      title: document.title,
      url: location.href,
      metaDescription: metaDesc ? metaDesc.content : '',
    });
  }

  // ─── Visibility ─────────────────────────────────────────────────────

  document.addEventListener('visibilitychange', () => {
    send('VISIBILITY_CHANGE', { hidden: document.hidden });
  });

  // ─── Media playback ─────────────────────────────────────────────────
  //
  // The background worker uses this to decide whether an idle user is
  // watching something or has walked away. tab.audible alone is not enough:
  // it is false for muted playback, and someone watching a subtitled video
  // with the sound off is still watching.
  //
  // The signal expires in the background unless re-asserted, so it is resent
  // periodically while playing rather than only on change. That means a stuck
  // flag cannot disable idle detection — the worst case is that tracking
  // continues a few seconds too long.

  let lastReported = null;
  let refreshTimer = null;

  function isMediaPlaying() {
    for (const el of document.querySelectorAll('video, audio')) {
      // readyState > 2 means there is actually decodable data, which excludes
      // players that are "not paused" only because they are still buffering.
      if (!el.paused && !el.ended && el.readyState > 2 && el.currentTime > 0) {
        return true;
      }
    }
    return false;
  }

  function reportMedia(force = false) {
    const playing = isMediaPlaying();

    // Re-send while playing to keep the signal alive; send a stop exactly once.
    if (playing || force || lastReported !== playing) {
      send('MEDIA_STATE', { playing });
      lastReported = playing;
    }

    if (playing && !refreshTimer) {
      refreshTimer = setInterval(() => reportMedia(), MEDIA_REFRESH_MS);
    } else if (!playing && refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // Media events bubble only in the capture phase, so listen on the document
  // rather than on each element — this also covers players added later.
  for (const event of ['play', 'playing', 'pause', 'ended', 'emptied']) {
    document.addEventListener(event, () => reportMedia(true), true);
  }

  // A hidden tab cannot be the tracked tab; stop asserting playback for it so
  // background audio in another tab does not hold idle detection open.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      send('MEDIA_STATE', { playing: false });
      lastReported = false;
    } else {
      reportMedia(true);
    }
  });

  // ─── Startup ────────────────────────────────────────────────────────

  function start() {
    sendPageInfo();
    reportMedia(true);
  }

  if (document.readyState === 'complete') {
    start();
  } else {
    window.addEventListener('load', start);
  }

  // Title changes signal SPA navigation.
  let lastTitle = document.title;
  const titleObserver = new MutationObserver(() => {
    if (document.title !== lastTitle) {
      lastTitle = document.title;
      sendPageInfo();
    }
  });

  const titleEl = document.querySelector('title');
  if (titleEl) {
    titleObserver.observe(titleEl, { childList: true, characterData: true, subtree: true });
  }
})();
