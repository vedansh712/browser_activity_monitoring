import {
  DEFAULT_IDLE_THRESHOLD_SECONDS,
  MIN_IDLE_THRESHOLD_SECONDS,
} from '../shared/constants.js';

let onIdleCallback = null;
let onActiveCallback = null;

/**
 * Register the idle state listener.
 *
 * MUST be called synchronously at service-worker module top level. Registering
 * it inside an async callback means it only survives until the first MV3
 * worker teardown, after which idle detection silently stops working for the
 * rest of the browser session.
 *
 * @param {Object} callbacks - { onIdle, onActive }
 */
export function registerIdleListener({ onIdle, onActive }) {
  onIdleCallback = onIdle;
  onActiveCallback = onActive;
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
 * Set the idle detection threshold, clamped to the range chrome.idle accepts.
 * Values below 15s are rejected outright by the API.
 */
export function applyIdleThreshold(seconds) {
  const value = Number(seconds) || DEFAULT_IDLE_THRESHOLD_SECONDS;
  chrome.idle.setDetectionInterval(Math.max(MIN_IDLE_THRESHOLD_SECONDS, value));
}
