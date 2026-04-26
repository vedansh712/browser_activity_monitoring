import { STORAGE_KEYS, DEFAULT_CATEGORIES, DEFAULT_SETTINGS, MSG } from '../shared/constants.js';

let settings = { ...DEFAULT_SETTINGS };
let categories = { builtIn: DEFAULT_CATEGORIES, custom: [], domainOverrides: {}, channelOverrides: {} };

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadCategories();
  renderAll();
  setupEventListeners();
  checkAIStatus();
});

// ─── Load ──────────────────────────────────────────────────────────

async function loadSettings() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.SETTINGS] || {}) };
}

async function loadCategories() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CATEGORIES);
  if (result[STORAGE_KEYS.CATEGORIES]) {
    categories = result[STORAGE_KEYS.CATEGORIES];
  }
}

// ─── Render ────────────────────────────────────────────────────────

function renderAll() {
  // General settings
  document.getElementById('tracking-enabled').checked = settings.trackingEnabled;
  document.getElementById('idle-threshold').value = settings.idleThresholdSeconds;
  document.getElementById('retention-days').value = settings.retentionDays;
  document.getElementById('youtube-tracking').checked = settings.youtubeDeepTracking;

  // AI settings
  document.getElementById('ai-provider').value = settings.aiProvider || '';
  document.getElementById('ai-api-key').value = settings.aiApiKey || '';
  document.getElementById('api-key-row').style.display = settings.aiProvider ? 'flex' : 'none';

  // Excluded domains
  renderExcludedDomains();

  // Custom categories
  renderCustomCategories();

  // Domain overrides
  renderDomainOverrides();
}

function renderExcludedDomains() {
  const container = document.getElementById('excluded-list');
  if (settings.excludedDomains.length === 0) {
    container.innerHTML = '<span style="font-size:12px;color:#666;">No excluded domains</span>';
    return;
  }

  container.innerHTML = settings.excludedDomains
    .map((domain) => `
      <span class="excluded-chip">
        ${domain}
        <button class="remove-btn" data-domain="${domain}">&times;</button>
      </span>
    `)
    .join('');

  container.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      settings.excludedDomains = settings.excludedDomains.filter((d) => d !== btn.dataset.domain);
      renderExcludedDomains();
    });
  });
}

function renderCustomCategories() {
  const container = document.getElementById('custom-categories');
  if (!categories.custom || categories.custom.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:#666;">No custom categories yet</p>';
    return;
  }

  container.innerHTML = categories.custom
    .map((cat, i) => `
      <div class="custom-cat-item">
        <span class="custom-cat-color" style="background:${cat.color}"></span>
        <span class="custom-cat-name">${cat.name}</span>
        <span class="custom-cat-rules">${cat.rules.map((r) => r.value).join(', ') || 'No rules'}</span>
        <button class="btn btn-danger btn-small" data-index="${i}">Remove</button>
      </div>
    `)
    .join('');

  container.querySelectorAll('.btn-danger').forEach((btn) => {
    btn.addEventListener('click', () => {
      categories.custom.splice(parseInt(btn.dataset.index, 10), 1);
      renderCustomCategories();
    });
  });
}

function renderDomainOverrides() {
  const container = document.getElementById('overrides-list');
  const overrides = categories.domainOverrides || {};
  const entries = Object.entries(overrides);

  if (entries.length === 0) {
    container.innerHTML = '<p style="font-size:12px;color:#666;">No domain overrides</p>';
    return;
  }

  const allCats = [...DEFAULT_CATEGORIES, ...(categories.custom || [])];
  const catMap = {};
  for (const c of allCats) catMap[c.id] = c;

  container.innerHTML = entries
    .map(([domain, catId]) => {
      const cat = catMap[catId] || { name: catId, color: '#9E9E9E', icon: '?' };
      return `
        <div class="override-item">
          <span class="override-domain">${domain}</span>
          <div class="override-category">
            <span style="color:${cat.color}">${cat.icon} ${cat.name}</span>
            <button class="btn btn-danger btn-small" data-domain="${domain}">Remove</button>
          </div>
        </div>
      `;
    })
    .join('');

  container.querySelectorAll('.btn-danger').forEach((btn) => {
    btn.addEventListener('click', () => {
      delete categories.domainOverrides[btn.dataset.domain];
      renderDomainOverrides();
    });
  });
}

// ─── AI Status Check ───────────────────────────────────────────────

async function checkAIStatus() {
  const statusEl = document.getElementById('ai-status');

  // Check Chrome built-in AI
  let builtInAvailable = false;
  try {
    if (self.ai && self.ai.languageModel) {
      const caps = await self.ai.languageModel.capabilities();
      builtInAvailable = caps.available !== 'no';
    }
  } catch { /* ignore */ }

  if (builtInAvailable) {
    statusEl.className = 'ai-status available';
    statusEl.textContent = 'Chrome Built-in AI (Gemini Nano) is available. No API key needed.';
  } else if (settings.aiApiKey && settings.aiProvider) {
    statusEl.className = 'ai-status available';
    statusEl.textContent = `External AI configured: ${settings.aiProvider}`;
  } else {
    statusEl.className = 'ai-status unavailable';
    statusEl.textContent = 'No AI available. Unknown sites will be queued for manual categorization. Add an API key or enable Chrome built-in AI for auto-classification.';
  }
}

// ─── Event Listeners ───────────────────────────────────────────────

function setupEventListeners() {
  // AI provider toggle
  document.getElementById('ai-provider').addEventListener('change', (e) => {
    document.getElementById('api-key-row').style.display = e.target.value ? 'flex' : 'none';
  });

  // Add excluded domain
  document.getElementById('add-excluded').addEventListener('click', () => {
    const input = document.getElementById('new-excluded');
    const domain = input.value.trim().toLowerCase();
    if (domain && !settings.excludedDomains.includes(domain)) {
      settings.excludedDomains.push(domain);
      renderExcludedDomains();
      input.value = '';
    }
  });

  // Add custom category
  document.getElementById('add-category').addEventListener('click', () => {
    const name = document.getElementById('new-cat-name').value.trim();
    const color = document.getElementById('new-cat-color').value;
    const domainRule = document.getElementById('new-cat-domain').value.trim();

    if (!name) return;

    const id = 'custom_' + Date.now();
    const newCat = {
      id,
      name,
      color,
      icon: '\uD83C\uDFF7\uFE0F',
      isBuiltIn: false,
      rules: domainRule ? [{ type: 'domain', value: domainRule }] : [],
    };

    if (!categories.custom) categories.custom = [];
    categories.custom.push(newCat);
    renderCustomCategories();

    document.getElementById('new-cat-name').value = '';
    document.getElementById('new-cat-domain').value = '';
  });

  // Save settings
  document.getElementById('save-settings').addEventListener('click', saveAll);

  // Danger zone
  document.getElementById('clear-history').addEventListener('click', () => {
    showConfirmDialog({
      title: 'Clear Browsing History?',
      message: 'This will permanently delete all your tracked sessions, daily aggregates, and learned categorization data. Your settings, custom categories, and domain overrides will be preserved.\n\nThis cannot be undone.',
      onConfirm: async () => {
        await chrome.runtime.sendMessage({ type: MSG.CLEAR_HISTORY });
        showSaveStatus('Browsing history cleared');
      },
    });
  });

  document.getElementById('clear-all').addEventListener('click', () => {
    showConfirmDialog({
      title: 'Reset Everything?',
      message: 'This will permanently delete EVERYTHING:\n\u2022 All tracked sessions and aggregates\n\u2022 All settings (back to defaults)\n\u2022 All custom categories\n\u2022 All domain overrides\n\u2022 AI API keys\n\nThis cannot be undone.',
      onConfirm: async () => {
        await chrome.runtime.sendMessage({ type: MSG.RESET_EVERYTHING });
        showSaveStatus('Everything reset');
        // Reload the page to show defaults
        setTimeout(() => location.reload(), 1000);
      },
    });
  });
}

// ─── Confirmation Dialog ────────────────────────────────────────────

function showConfirmDialog({ title, message, onConfirm }) {
  const modal = document.getElementById('confirm-modal');
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-message').textContent = message;
  modal.style.display = 'flex';

  const okBtn = document.getElementById('confirm-ok');
  const cancelBtn = document.getElementById('confirm-cancel');

  // Remove any previous listeners by cloning
  const newOkBtn = okBtn.cloneNode(true);
  const newCancelBtn = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOkBtn, okBtn);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  newOkBtn.addEventListener('click', async () => {
    modal.style.display = 'none';
    try {
      await onConfirm();
    } catch (err) {
      console.error('[Track Daily] Action failed:', err);
      alert('Action failed: ' + err.message);
    }
  });

  newCancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });
}

function showSaveStatus(msg) {
  const status = document.getElementById('save-status');
  status.textContent = msg;
  setTimeout(() => { status.textContent = ''; }, 3000);
}

// ─── Save ──────────────────────────────────────────────────────────

async function saveAll() {
  // Collect settings from form
  settings.trackingEnabled = document.getElementById('tracking-enabled').checked;
  settings.idleThresholdSeconds = parseInt(document.getElementById('idle-threshold').value, 10) || 120;
  settings.retentionDays = parseInt(document.getElementById('retention-days').value, 10) || 90;
  settings.youtubeDeepTracking = document.getElementById('youtube-tracking').checked;
  settings.aiProvider = document.getElementById('ai-provider').value;
  settings.aiApiKey = document.getElementById('ai-api-key').value;

  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: settings,
    [STORAGE_KEYS.CATEGORIES]: categories,
  });

  const status = document.getElementById('save-status');
  status.textContent = 'Settings saved!';
  setTimeout(() => { status.textContent = ''; }, 3000);

  checkAIStatus();
}
