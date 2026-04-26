// Generic content script — runs on all pages
// Sends page info and tracks visibility changes

(function () {
  'use strict';

  // Send page info to service worker
  function sendPageInfo() {
    const metaDesc = document.querySelector('meta[name="description"]');
    chrome.runtime.sendMessage({
      type: 'PAGE_INFO',
      data: {
        title: document.title,
        url: location.href,
        metaDescription: metaDesc ? metaDesc.content : '',
      },
    }).catch(() => {
      // Extension context may be invalidated, ignore
    });
  }

  // Track visibility changes (tab hidden/shown)
  document.addEventListener('visibilitychange', () => {
    chrome.runtime.sendMessage({
      type: 'VISIBILITY_CHANGE',
      data: { hidden: document.hidden },
    }).catch(() => {});
  });

  // Send info once the page is ready
  if (document.readyState === 'complete') {
    sendPageInfo();
  } else {
    window.addEventListener('load', sendPageInfo);
  }

  // Also send on title changes (SPA navigations)
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
