import { MSG, DEFAULT_CATEGORIES } from '../shared/constants.js';
import { formatDuration, formatDurationPrecise } from '../shared/utils.js';

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── DOM Elements ──────────────────────────────────────────────────

const trackingToggle = document.getElementById('tracking-toggle');
const currentDomain = document.getElementById('current-domain');
const currentTime = document.getElementById('current-time');
const totalTime = document.getElementById('total-time');
const categoryChart = document.getElementById('category-chart');
const domainList = document.getElementById('domain-list');
const uncatNotice = document.getElementById('uncategorized-notice');
const uncatDomain = document.getElementById('uncat-domain');
const categoryButtons = document.getElementById('category-buttons');
const openDashboard = document.getElementById('open-dashboard');
const openOptions = document.getElementById('open-options');
const pulseDot = document.querySelector('.pulse-dot');

let currentSessionTimer = null;
let sessionStartTime = 0;
let sessionElapsed = 0;

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await loadStats();
  await loadUncategorized();
  startSessionTimer();
});

// ─── Load Today's Stats ────────────────────────────────────────────

async function loadStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_TODAY_STATS });
    if (!response) return;

    const { aggregate, currentSession } = response;

    // Update total time
    if (aggregate) {
      let total = aggregate.totalTime || 0;
      // Add current session's live time
      if (currentSession && currentSession.isActive) {
        total += Date.now() - currentSession.startTime;
      }
      totalTime.textContent = formatDuration(total);

      // Update top domains
      renderTopDomains(aggregate.domainBreakdown || {});

      // Update category chart
      renderCategoryChart(aggregate.categoryBreakdown || {});
    }

    // Update current session display
    if (currentSession && currentSession.isActive) {
      currentDomain.textContent = currentSession.domain || 'Unknown';
      sessionStartTime = currentSession.startTime;
      sessionElapsed = currentSession.duration || 0;
      pulseDot.classList.remove('paused', 'disabled');
    } else {
      currentDomain.textContent = 'Not tracking';
      currentTime.textContent = '00:00:00';
      pulseDot.classList.add('paused');
    }

    // Load tracking state
    const settings = await chrome.storage.local.get('settings');
    const trackingEnabled = settings.settings?.trackingEnabled ?? true;
    trackingToggle.checked = trackingEnabled;
    if (!trackingEnabled) {
      pulseDot.classList.add('disabled');
    }
  } catch (err) {
    console.error('[Track Daily] Error loading stats:', err);
  }
}

// ─── Real-time Session Timer ───────────────────────────────────────

function startSessionTimer() {
  if (currentSessionTimer) clearInterval(currentSessionTimer);
  currentSessionTimer = setInterval(() => {
    if (sessionStartTime > 0) {
      const elapsed = sessionElapsed + (Date.now() - sessionStartTime);
      currentTime.textContent = formatDurationPrecise(elapsed);
    }
  }, 1000);
}

// ─── Top Domains ───────────────────────────────────────────────────

function renderTopDomains(domainBreakdown) {
  const entries = Object.entries(domainBreakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  if (entries.length === 0) {
    domainList.innerHTML = '<li class="empty-state">No data yet</li>';
    return;
  }

  const maxTime = entries[0][1];
  domainList.innerHTML = entries
    .map(([domain, time]) => {
      const barWidth = Math.max(5, (time / maxTime) * 100);
      const safeDomain = escapeHtml(domain);
      const encodedDomain = encodeURIComponent(domain);
      return `
        <li>
          <div style="flex:1; min-width:0;">
            <div class="domain-info">
              <img class="domain-icon" src="https://www.google.com/s2/favicons?domain=${encodedDomain}&sz=32" alt="" onerror="this.style.display='none'">
              <span class="domain-name">${safeDomain}</span>
            </div>
            <div class="domain-bar" style="width: ${barWidth}%"></div>
          </div>
          <span class="domain-time">${formatDuration(time)}</span>
        </li>
      `;
    })
    .join('');
}

// ─── Category Chart ────────────────────────────────────────────────

function renderCategoryChart(categoryBreakdown) {
  const ctx = categoryChart.getContext('2d');
  const entries = Object.entries(categoryBreakdown).filter(([, v]) => v > 0);

  if (entries.length === 0) {
    // Draw empty state
    ctx.clearRect(0, 0, 200, 200);
    ctx.fillStyle = '#444';
    ctx.font = '13px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('No data yet', 100, 105);
    return;
  }

  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  const categoryMap = {};
  for (const cat of DEFAULT_CATEGORIES) {
    categoryMap[cat.id] = cat;
  }

  // Draw doughnut chart
  ctx.clearRect(0, 0, 200, 200);
  const centerX = 100, centerY = 100;
  const outerRadius = 80, innerRadius = 50;
  let startAngle = -Math.PI / 2;

  for (const [categoryId, time] of entries) {
    const cat = categoryMap[categoryId] || { color: '#9E9E9E' };
    const sliceAngle = (time / total) * Math.PI * 2;

    ctx.beginPath();
    ctx.arc(centerX, centerY, outerRadius, startAngle, startAngle + sliceAngle);
    ctx.arc(centerX, centerY, innerRadius, startAngle + sliceAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = cat.color;
    ctx.fill();

    startAngle += sliceAngle;
  }

  // Center text
  ctx.fillStyle = '#e0e0e0';
  ctx.font = 'bold 16px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatDuration(total), centerX, centerY - 6);
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#888';
  ctx.fillText('total', centerX, centerY + 12);
}

// ─── Uncategorized Domains ─────────────────────────────────────────

async function loadUncategorized() {
  try {
    const uncategorized = await chrome.runtime.sendMessage({ type: MSG.GET_UNCATEGORIZED });
    if (!uncategorized || uncategorized.length === 0) {
      uncatNotice.style.display = 'none';
      return;
    }

    // Show the first uncategorized domain
    const first = uncategorized[0];
    uncatDomain.textContent = first.domain;
    uncatNotice.style.display = 'block';

    // Build category buttons
    const cats = DEFAULT_CATEGORIES.filter((c) => c.id !== 'uncategorized');
    categoryButtons.innerHTML = cats
      .map((c) => `<button class="cat-btn" data-id="${escapeHtml(c.id)}">${escapeHtml(c.icon)} ${escapeHtml(c.name)}</button>`)
      .join('');

    // Add click handlers
    categoryButtons.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: MSG.CATEGORIZE_DOMAIN,
          data: {
            domain: first.domain,
            categoryId: btn.dataset.id,
            title: first.title,
          },
        });
        await loadUncategorized(); // Refresh
        await loadStats(); // Refresh stats
      });
    });
  } catch (err) {
    console.error('[Track Daily] Error loading uncategorized:', err);
  }
}

// ─── Event Handlers ────────────────────────────────────────────────

trackingToggle.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: MSG.TOGGLE_TRACKING,
    data: { enabled: trackingToggle.checked },
  });

  if (trackingToggle.checked) {
    pulseDot.classList.remove('disabled');
  } else {
    pulseDot.classList.add('disabled');
    currentDomain.textContent = 'Tracking paused';
    currentTime.textContent = '00:00:00';
    sessionStartTime = 0;
  }
});

openDashboard.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});

openOptions.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
