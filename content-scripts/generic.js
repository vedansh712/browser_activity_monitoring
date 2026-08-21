// Generic content script — runs on all pages.
// Reports page info, visibility changes, and whether media is actually playing.

(function () {
  'use strict';

  // Kept in sync with MEDIA_SIGNAL_REFRESH_MS in shared/constants.js. Content
  // scripts are not loaded as ES modules, so the value cannot be imported.
  const MEDIA_REFRESH_MS = 5000;

  /*
   * Orphaned-script guard
   * ─────────────────────
   * Reloading or updating the extension severs this script's link to it, but
   * the page keeps running the script. Every chrome.* call then throws
   * *synchronously* — it does not return a rejected promise — so wrapping the
   * call in .catch() does not help, which is why these surfaced as uncaught
   * errors on unrelated pages.
   *
   * Once orphaned the script can never recover, so it tears down its timers and
   * observers and goes silent instead of throwing on every poll.
   *
   * Duplicated in youtube.js: manifest content scripts are not ES modules, so
   * there is nothing to import from.
   */
  let alive = true;
  const teardown = [];

  function extensionGone(error) {
    return !alive || /context invalidated|Receiving end does not exist/i.test(
      String(error?.message ?? error ?? '')
    );
  }

  function shutdown() {
    if (!alive) return;
    alive = false;
    for (const stop of teardown) {
      try { stop(); } catch { /* already gone */ }
    }
  }

  function send(type, data) {
    if (!alive) return;

    // chrome.runtime.id reads as undefined once the context is invalidated,
    // which catches the common case before anything can throw.
    try {
      if (!chrome.runtime?.id) return shutdown();
      const pending = chrome.runtime.sendMessage({ type, data });
      if (pending?.catch) {
        pending.catch((err) => {
          if (extensionGone(err)) shutdown();
        });
      }
    } catch (err) {
      if (extensionGone(err)) shutdown();
    }
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

  function stopRefresh() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }
  teardown.push(stopRefresh);

  function reportMedia(force = false) {
    if (!alive) return stopRefresh();

    const playing = isMediaPlaying();

    // Re-send while playing to keep the signal alive; send a stop exactly once.
    if (playing || force || lastReported !== playing) {
      send('MEDIA_STATE', { playing });
      lastReported = playing;
    }

    if (playing && !refreshTimer) {
      refreshTimer = setInterval(() => reportMedia(), MEDIA_REFRESH_MS);
    } else if (!playing) {
      stopRefresh();
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
    if (!alive) return;
    if (document.hidden) {
      stopRefresh();
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
    teardown.push(() => titleObserver.disconnect());
  }
})();
