import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  LOG_LEVELS,
  MSG,
} from '../shared/constants.js';
import {
  AI_STATUS,
  ACCENT_PRESETS,
  ACCENT_MODES,
  ACCENT_SPAN_LIMITS,
  DEFAULT_ACCENT,
} from '../shared/constants.js';
import { clampInt, formatDuration } from '../shared/utils.js';
import { html, render, cssColor } from '../shared/html.js';
import { createCategoryRegistry } from '../shared/category-registry.js';
import {
  initTheme,
  applyAccent,
  normalizeAccent,
  accentForDuration,
  fetchTodayTotalMs,
  gradientCss,
} from '../shared/theme.js';
import { createLogger } from '../shared/logger.js';
import * as storage from '../background/storage-manager.js';
import { aiClassifier } from '../background/container.js';

const log = createLogger('options');

/*
 * Options page.
 *
 * Two rules govern this module, both of them consequences of bugs that were
 * present before:
 *
 *  1. Destructive actions persist immediately. Previously, removing an excluded
 *     domain or a category only mutated an in-memory copy, so the change looked
 *     applied but silently reverted unless the user also pressed Save.
 *
 *  2. The Save button writes settings ONLY. Previously it wrote the entire
 *     categories blob from a snapshot taken at page load, so pressing Save
 *     discarded any categorization the service worker had performed while the
 *     page was open — and, after Reset Everything, restored the data the user
 *     had just deleted.
 *
 * All markup is built with the html`` tag, which escapes interpolated values.
 */

/** @type {Object} */
let settings = { ...DEFAULT_SETTINGS };
/** @type {Object} */
let categories = { custom: [], domainOverrides: {}, channelOverrides: {} };
/** Lookup over built-ins plus custom categories; rebuilt whenever state loads. */
let registry = createCategoryRegistry(categories);

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await initTheme();
    await loadState();
    renderAll();
    setupEventListeners();
    await checkAIStatus();
  } catch (err) {
    log.error('Failed to initialise options page:', err);
    showStatus('Could not load settings. See the console for details.', 'error');
  }
});

/**
 * Re-read all persisted state. Called on load and after any destructive action,
 * so the in-memory copy can never be used to resurrect deleted data.
 */
async function loadState() {
  [settings, categories] = await Promise.all([
    storage.getSettings(),
    storage.getCategories(),
  ]);
  registry = createCategoryRegistry(categories);
}

// ─── Render ────────────────────────────────────────────────────────

function renderAll() {
  document.getElementById('tracking-enabled').checked = settings.trackingEnabled;
  document.getElementById('idle-threshold').value = settings.idleThresholdSeconds;
  document.getElementById('retention-days').value = settings.retentionDays;
  document.getElementById('youtube-tracking').checked = settings.youtubeDeepTracking;

  renderLogLevels();
  document.getElementById('log-level').value = settings.logLevel ?? DEFAULT_SETTINGS.logLevel;

  document.getElementById('ai-enabled').checked = Boolean(settings.aiEnabled);

  renderAccent();
  renderExcludedDomains();
  renderCustomCategories();
  renderDomainOverrides();
}

// ─── Accent picker ─────────────────────────────────────────────────

/**
 * The colour wheel and its presets.
 *
 * Every accent variant in the theme is derived from one custom property, so
 * changing it here re-skins all three surfaces. The change is applied to the
 * live page immediately for feedback, and persisted on release — dragging
 * through a colour wheel fires `input` continuously, and writing to storage on
 * every one of those events would hammer it for no benefit.
 */
function renderAccent() {
  const isDynamic = settings.accentMode === ACCENT_MODES.DYNAMIC;

  document.querySelectorAll('.accent-mode button').forEach((btn) => {
    btn.classList.toggle('is-active', (btn.dataset.mode === ACCENT_MODES.DYNAMIC) === isDynamic);
  });

  document.getElementById('accent-fixed-panel').hidden = isDynamic;
  document.getElementById('accent-dynamic-panel').hidden = !isDynamic;

  document.getElementById('accent-span').value =
    settings.accentSpanHours ?? ACCENT_SPAN_LIMITS.fallback;

  if (isDynamic) renderDynamicPreview();

  const current = normalizeAccent(settings.accentColor ?? DEFAULT_ACCENT);

  document.getElementById('accent-color').value = current;
  document.getElementById('accent-hex').textContent = current.toUpperCase();

  const container = document.getElementById('accent-presets');
  render(container, html`${ACCENT_PRESETS.map((preset) => html`
    <button class="preset ${preset.value === current ? 'is-active' : ''}"
            data-color="${preset.value}"
            title="${preset.name}"
            aria-label="${preset.name}">
      <i style="background:${cssColor(preset.value)};color:${cssColor(preset.value)}"></i>
    </button>
  `)}`);

  bindAll(container, '.preset', 'click', (btn) => selectAccent(btn.dataset.color, true));
}

/**
 * Show where today's tracked time currently sits on the gradient, and update
 * the scale labels to match the configured span.
 */
async function renderDynamicPreview() {
  const span = clampInt(
    document.getElementById('accent-span').value ?? settings.accentSpanHours,
    ACCENT_SPAN_LIMITS
  );

  // Painted from the shared stops so the preview cannot drift from the ramp.
  document.getElementById('gradient-bar').style.background = gradientCss();

  document.getElementById('gradient-mid').textContent = `${(span / 2).toFixed(span % 2 ? 1 : 0)}h`;
  document.getElementById('gradient-end').textContent = `${span}h+`;

  const totalMs = await fetchTodayTotalMs();
  const spanMs = span * 60 * 60 * 1000;
  const fraction = Math.min(1, totalMs / spanMs);

  document.getElementById('gradient-marker').style.left = `${(fraction * 100).toFixed(1)}%`;

  const colour = accentForDuration(totalMs, span);
  document.getElementById('dynamic-now').textContent =
    `Today: ${formatDuration(totalMs)} tracked · currently ${colour.toUpperCase()}` +
    (fraction >= 1 ? ' (at the end of the scale)' : '');

  // Apply it so the page previews the mode it is describing.
  applyAccent(colour);
}

/** Preview the colour on this page without writing to storage. */
function previewAccent(value) {
  const colour = applyAccent(value);
  document.getElementById('accent-hex').textContent = colour.toUpperCase();
  return colour;
}

/** Apply and persist. */
async function selectAccent(value, rerender = false) {
  const colour = previewAccent(value);
  settings.accentColor = colour;

  await withErrorReporting('save accent colour', async () => {
    await storage.saveSettings(settings);
    if (rerender) renderAccent();
    else {
      document.getElementById('accent-color').value = colour;
      markActivePreset(colour);
    }
  });
}

/** Switch between a fixed colour and the time-driven ramp. */
async function selectAccentMode(mode) {
  if (mode !== ACCENT_MODES.FIXED && mode !== ACCENT_MODES.DYNAMIC) return;

  settings.accentMode = mode;

  await withErrorReporting('change colour mode', async () => {
    await storage.saveSettings(settings);
    renderAccent();
    // In fixed mode the stored colour has to be re-applied, since the dynamic
    // preview may have left a computed one on the page.
    if (mode === ACCENT_MODES.FIXED) applyAccent(settings.accentColor);
    showStatus(mode === ACCENT_MODES.DYNAMIC ? 'Colour now follows your tracked time' : 'Using a fixed colour');
  });
}

async function saveAccentSpan() {
  settings.accentSpanHours = clampInt(
    document.getElementById('accent-span').value,
    ACCENT_SPAN_LIMITS
  );
  document.getElementById('accent-span').value = settings.accentSpanHours;

  await withErrorReporting('save colour range', async () => {
    await storage.saveSettings(settings);
    await renderDynamicPreview();
  });
}

function markActivePreset(colour) {
  document.querySelectorAll('.preset').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.color === colour);
  });
}

function renderLogLevels() {
  const select = document.getElementById('log-level');
  render(select, html`${LOG_LEVELS.map((level) => html`<option value="${level}">${level}</option>`)}`);
}

function renderExcludedDomains() {
  const container = document.getElementById('excluded-list');
  const domains = settings.excludedDomains || [];

  if (domains.length === 0) {
    render(container, html`<span class="empty-hint">No excluded domains</span>`);
    return;
  }

  render(container, html`${domains.map((domain) => html`
    <span class="excluded-chip">
      ${domain}
      <button class="remove-btn" data-domain="${domain}" aria-label="Remove ${domain}">&times;</button>
    </span>
  `)}`);

  bindAll(container, '.remove-btn', 'click', (btn) => removeExcludedDomain(btn.dataset.domain));
}

function renderCustomCategories() {
  const container = document.getElementById('custom-categories');
  const custom = categories.custom || [];

  if (custom.length === 0) {
    render(container, html`<p class="empty-hint">No custom categories yet</p>`);
    return;
  }

  render(container, html`${custom.map((cat) => html`
    <div class="custom-cat-item">
      <span class="custom-cat-color" style="background:${cssColor(cat.color)}"></span>
      <span class="custom-cat-name">${cat.name}</span>
      <span class="custom-cat-rules">${cat.rules.map((r) => r.value).join(', ') || 'No rules'}</span>
      <button class="btn btn-danger btn-small" data-category-id="${cat.id}">Remove</button>
    </div>
  `)}`);

  bindAll(container, '[data-category-id]', 'click', (btn) => removeCustomCategory(btn.dataset.categoryId));
}

function renderDomainOverrides() {
  const container = document.getElementById('overrides-list');
  const entries = Object.entries(categories.domainOverrides || {});

  if (entries.length === 0) {
    render(container, html`<p class="empty-hint">No domain overrides</p>`);
    return;
  }

  render(container, html`${entries.map(([domain, catId]) => {
    const cat = registry.get(catId);
    return html`
      <div class="override-item">
        <span class="override-domain">${domain}</span>
        <div class="override-category">
          <span style="color:${cssColor(cat.color)}">${cat.icon} ${cat.name}</span>
          <button class="btn btn-danger btn-small" data-domain="${domain}">Remove</button>
        </div>
      </div>
    `;
  })}`);

  bindAll(container, '[data-domain]', 'click', (btn) => removeDomainOverride(btn.dataset.domain));
}

/** Attach a handler to every match, passing the element itself. */
function bindAll(container, selector, event, handler) {
  container.querySelectorAll(selector).forEach((el) => {
    el.addEventListener(event, () => handler(el));
  });
}

// ─── Mutations (persist immediately) ───────────────────────────────

async function removeExcludedDomain(domain) {
  await withErrorReporting('remove excluded domain', async () => {
    settings.excludedDomains = (settings.excludedDomains || []).filter((d) => d !== domain);
    await storage.saveSettings(settings);
    renderExcludedDomains();
    showStatus(`Removed ${domain}`);
  });
}

async function addExcludedDomain() {
  const input = document.getElementById('new-excluded');
  const domain = normalizeDomainInput(input.value);

  if (!domain) {
    showStatus('Enter a valid domain, e.g. example.com', 'error');
    return;
  }
  if ((settings.excludedDomains || []).includes(domain)) {
    showStatus(`${domain} is already excluded`, 'error');
    return;
  }

  await withErrorReporting('add excluded domain', async () => {
    settings.excludedDomains = [...(settings.excludedDomains || []), domain];
    await storage.saveSettings(settings);
    input.value = '';
    renderExcludedDomains();
    showStatus(`Excluded ${domain}`);
  });
}

async function removeCustomCategory(categoryId) {
  await withErrorReporting('remove category', async () => {
    categories = await storage.removeCustomCategory(categoryId);
    registry = createCategoryRegistry(categories);
    renderCustomCategories();
    renderDomainOverrides();
    showStatus('Category removed');
  });
}

async function addCustomCategory() {
  const nameInput = document.getElementById('new-cat-name');
  const colorInput = document.getElementById('new-cat-color');
  const domainInput = document.getElementById('new-cat-domain');

  const name = nameInput.value.trim();
  if (!name) {
    showStatus('Category name is required', 'error');
    return;
  }

  const domainRule = normalizeDomainInput(domainInput.value);
  if (domainInput.value.trim() && !domainRule) {
    showStatus('Domain rule is not a valid domain', 'error');
    return;
  }

  await withErrorReporting('add category', async () => {
    categories = await storage.addCustomCategory({
      id: `custom_${Date.now()}`,
      name,
      color: cssColor(colorInput.value, '#667eea'),
      icon: '🏷️',
      isBuiltIn: false,
      rules: domainRule ? [{ type: 'domain', value: domainRule }] : [],
    });
    registry = createCategoryRegistry(categories);

    nameInput.value = '';
    domainInput.value = '';
    renderCustomCategories();
    showStatus(`Added ${name}`);
  });
}

async function removeDomainOverride(domain) {
  await withErrorReporting('remove override', async () => {
    categories = await storage.removeDomainOverride(domain);
    registry = createCategoryRegistry(categories);
    renderDomainOverrides();
    showStatus(`Removed override for ${domain}`);
  });
}

/**
 * Normalise and validate a user-entered domain.
 * Accepts a bare host or a full URL; returns '' when it is not a usable host.
 */
function normalizeDomainInput(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return '';

  const host = value.includes('://')
    ? safeHostname(value)
    : value.split('/')[0];

  if (!host) return '';
  // Reject anything that is not a plausible hostname.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return '';
  return host.replace(/^www\./, '');
}

function safeHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ─── On-device Model Status ────────────────────────────────────────

/**
 * Report model availability and expose the download only when it is actually
 * needed. The download is several gigabytes, so it is never started implicitly.
 */
async function checkAIStatus() {
  const statusEl = document.getElementById('ai-status');
  const downloadRow = document.getElementById('ai-download-row');

  const status = await aiClassifier.status();
  downloadRow.hidden = status !== AI_STATUS.DOWNLOADABLE;

  const messages = {
    [AI_STATUS.AVAILABLE]: {
      className: 'ai-status available',
      text: settings.aiEnabled
        ? 'Model ready. Unknown sites are categorized on your device.'
        : 'Model ready. Turn on the switch above to use it.',
    },
    [AI_STATUS.DOWNLOADABLE]: {
      className: 'ai-status unavailable',
      text: 'Chrome supports on-device AI, but the model has not been downloaded yet. It is a large one-time download.',
    },
    [AI_STATUS.DOWNLOADING]: {
      className: 'ai-status unavailable',
      text: 'The model is downloading. This page will report when it is ready.',
    },
    [AI_STATUS.UNSUPPORTED]: {
      className: 'ai-status unavailable',
      text: 'This version of Chrome does not provide the built-in AI model. Unknown sites will be queued for manual categorization.',
    },
  };

  const { className, text } = messages[status] ?? {
    className: 'ai-status unavailable',
    text: 'The on-device model is unavailable on this device. Unknown sites will be queued for manual categorization.',
  };

  statusEl.className = className;
  statusEl.textContent = text;
}

async function downloadModel() {
  const button = document.getElementById('ai-download');
  const track = document.getElementById('ai-progress');
  const fill = document.getElementById('ai-progress-fill');

  button.disabled = true;
  track.hidden = false;
  fill.style.width = '0%';

  await withErrorReporting('download the model', async () => {
    try {
      await aiClassifier.download((fraction) => {
        fill.style.width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`;
      });
      showStatus('Model downloaded');
    } finally {
      button.disabled = false;
      track.hidden = true;
      await checkAIStatus();
    }
  });
}

// ─── Event Listeners ───────────────────────────────────────────────

function setupEventListeners() {
  const wheel = document.getElementById('accent-color');
  // `input` fires continuously while dragging — preview only.
  wheel.addEventListener('input', (e) => previewAccent(e.target.value));
  // `change` fires once the picker closes — that is when it is worth storing.
  wheel.addEventListener('change', (e) => selectAccent(e.target.value));

  document.querySelectorAll('.accent-mode button').forEach((btn) => {
    btn.addEventListener('click', () => selectAccentMode(btn.dataset.mode));
  });

  const span = document.getElementById('accent-span');
  span.addEventListener('input', () => renderDynamicPreview());
  span.addEventListener('change', () => saveAccentSpan());

  document.getElementById('ai-download').addEventListener('click', downloadModel);

  document.getElementById('add-excluded').addEventListener('click', addExcludedDomain);
  document.getElementById('new-excluded').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addExcludedDomain();
  });

  document.getElementById('add-category').addEventListener('click', addCustomCategory);
  document.getElementById('save-settings').addEventListener('click', saveSettings);

  document.getElementById('clear-history').addEventListener('click', () => {
    showConfirmDialog({
      title: 'Clear Browsing History?',
      message:
        'This will permanently delete all your tracked sessions, daily aggregates, and learned categorization data. Your settings, custom categories, and domain overrides will be preserved.\n\nThis cannot be undone.',
      onConfirm: async () => {
        await sendMessage({ type: MSG.CLEAR_HISTORY });
        showStatus('Browsing history cleared');
      },
    });
  });

  document.getElementById('clear-all').addEventListener('click', () => {
    showConfirmDialog({
      title: 'Reset Everything?',
      message:
        'This will permanently delete EVERYTHING:\n• All tracked sessions and aggregates\n• All settings (back to defaults)\n• All custom categories\n• All domain overrides\n• AI API keys\n\nThis cannot be undone.',
      onConfirm: async () => {
        await sendMessage({ type: MSG.RESET_EVERYTHING });
        // Re-read from storage rather than keeping the pre-reset snapshot,
        // which a later Save would otherwise write back.
        await loadState();
        renderAll();
        await checkAIStatus();
        showStatus('Everything reset to defaults');
      },
    });
  });
}

// ─── Save (settings only — see module header) ──────────────────────

async function saveSettings() {
  await withErrorReporting('save settings', async () => {
    settings.trackingEnabled = document.getElementById('tracking-enabled').checked;
    settings.idleThresholdSeconds = clampInt(
      document.getElementById('idle-threshold').value,
      SETTINGS_LIMITS.idleThresholdSeconds
    );
    settings.retentionDays = clampInt(
      document.getElementById('retention-days').value,
      SETTINGS_LIMITS.retentionDays
    );
    settings.youtubeDeepTracking = document.getElementById('youtube-tracking').checked;
    settings.aiEnabled = document.getElementById('ai-enabled').checked;

    const level = document.getElementById('log-level').value;
    settings.logLevel = LOG_LEVELS.includes(level) ? level : DEFAULT_SETTINGS.logLevel;

    await storage.saveSettings(settings);

    // Reflect any clamping back into the form so the user sees what was stored.
    document.getElementById('idle-threshold').value = settings.idleThresholdSeconds;
    document.getElementById('retention-days').value = settings.retentionDays;

    showStatus('Settings saved');
    await checkAIStatus();
  });
}

// ─── Confirmation Dialog ───────────────────────────────────────────

function showConfirmDialog({ title, message, onConfirm }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  modal.hidden = false;

  // Replace the buttons to drop listeners from any previous invocation.
  const okBtn = replaceNode(document.getElementById('confirm-ok'));
  const cancelBtn = replaceNode(document.getElementById('confirm-cancel'));

  const close = () => { modal.hidden = true; };

  okBtn.addEventListener('click', async () => {
    close();
    await withErrorReporting('complete action', onConfirm);
  });
  cancelBtn.addEventListener('click', close);
}

function replaceNode(node) {
  const clone = node.cloneNode(true);
  node.parentNode.replaceChild(clone, node);
  return clone;
}

// ─── Messaging & Status ────────────────────────────────────────────

/**
 * Send a message to the service worker, surfacing handler-side errors as
 * rejections rather than silently resolving with an error payload.
 */
async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

/**
 * Run an action, reporting failures to both the console and the user.
 * Previously these failures were invisible — the UI simply did nothing.
 */
async function withErrorReporting(label, action) {
  try {
    await action();
  } catch (err) {
    log.error(`Failed to ${label}:`, err);
    showStatus(`Could not ${label}: ${err.message}`, 'error');
  }
}

let statusTimer = null;

function showStatus(message, kind = 'success') {
  const status = document.getElementById('save-status');
  status.textContent = message;
  status.className = `save-status ${kind}`;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    status.textContent = '';
    status.className = 'save-status';
  }, 4000);
}
