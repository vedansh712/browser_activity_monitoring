import { DEFAULT_IDLE_THRESHOLD_SECONDS } from '../shared/constants.js';

let onIdleCallback = null;
let onActiveCallback = null;

/**
 * Initialize idle detection.
 * @param {Object} callbacks - { onIdle, onActive }
 * @param {number} thresholdSeconds - seconds before user is considered idle
 */
export function initIdleDetection({ onIdle, onActive }, thresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS) {
  onIdleCallback = onIdle;
  onActiveCallback = onActive;

  chrome.idle.setDetectionInterval(thresholdSeconds);

  chrome.idle.onStateChanged.addListener(handleStateChange);
}

function handleStateChange(newState) {
  switch (newState) {
    case 'idle':
    case 'locked':
      if (onIdleCallback) onIdleCallback(newState);
      break;
    case 'active':
      if (onActiveCallback) onActiveCallback();
      break;
  }
}

/**
 * Update the idle detection threshold.
 */
export function updateIdleThreshold(seconds) {
  chrome.idle.setDetectionInterval(seconds);
}

/**
 * Query the current idle state.
 */
export async function queryIdleState(thresholdSeconds = DEFAULT_IDLE_THRESHOLD_SECONDS) {
  return new Promise((resolve) => {
    chrome.idle.queryState(thresholdSeconds, resolve);
  });
}
