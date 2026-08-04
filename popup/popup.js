import { MSG } from '../shared/constants.js';
import { formatDuration, formatDurationPrecise, faviconUrl, todayKey } from '../shared/utils.js';
import { html, render, cssColor } from '../shared/html.js';
import { createCategoryRegistry } from '../shared/category-registry.js';
import { computeFocusScore } from '../shared/metrics.js';
import { initTheme, themeColor } from '../shared/theme.js';
import { createLogger } from '../shared/logger.js';
import * as storage from '../background/storage-manager.js';

const log = createLogger('popup');

/** Populated on load so custom categories render here, not just built-ins. */
let categories = createCategoryRegistry();

// ─── DOM ───────────────────────────────────────────────────────────

const trackingToggle = document.getElementById('tracking-toggle');
const currentDomain = document.getElementById('current-domain');
const currentTime = document.getElementById('current-time');
const totalTime = document.getElementById('total-time');
const todayMeta = document.getElementById('today-meta');
const focusScoreEl = document.getElementById('focus-score');
const categoryChart = document.getElementById('category-chart');
const domainList = document.getElementById('domain-list');
const uncatNotice = document.getElementById('uncategorized-notice');
const uncatDomain = document.getElementById('uncat-domain');
const categoryButtons = document.getElementById('category-buttons');
const openDashboard = document.getElementById('open-dashboard');
const openOptions = document.getElementById('open-options');
const pulseDot = document.getElementById('pulse-dot');

let sessionTimer = null;
let sessionStartTime = 0;
let sessionElapsedBase = 0;

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();

  try {
    categories = createCategoryRegistry(await storage.getCategories());
  } catch (err) {
    log.error('Could not load categories:', err);
  }

  await loadStats();
  await loadUncategorized();
  startSessionTimer();
});

// ─── Today's stats ─────────────────────────────────────────────────

async function loadStats() {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG.GET_TODAY_STATS });
    if (!response) return;

    const { aggregate, currentSession } = response;

    if (aggregate) {
      let total = aggregate.totalTime || 0;
      if (currentSession?.isActive) {
        total += Date.now() - currentSession.startTime;
      }
      totalTime.textContent = formatDuration(total);
      todayMeta.textContent = `${aggregate.sessionCount || 0} SESSIONS`;

      renderTopDomains(aggregate.domainBreakdown || {});
      renderCategoryChart(aggregate.categoryBreakdown || {});
    }

    await renderFocusScore();

    if (currentSession?.isActive) {
      currentDomain.textContent = currentSession.domain || 'Unknown';
      sessionStartTime = currentSession.startTime;
      sessionElapsedBase = currentSession.duration || 0;
      pulseDot.classList.remove('is-idle', 'is-off');
    } else if (currentSession) {
      currentDomain.textContent = `${currentSession.domain} · paused`;
      sessionStartTime = 0;
      currentTime.textContent = formatDurationPrecise(currentSession.duration || 0);
      pulseDot.classList.add('is-idle');
    } else {
      currentDomain.textContent = 'Not tracking';
      currentTime.textContent = '00:00:00';
      pulseDot.classList.add('is-off');
    }

    const settings = await storage.getSettings();
    trackingToggle.checked = settings.trackingEnabled;
    if (!settings.trackingEnabled) pulseDot.classList.add('is-off');
  } catch (err) {
    log.error('Error loading stats:', err);
  }
}

/** Today's focus score, shown in the middle of the category ring. */
async function renderFocusScore() {
  try {
    const today = todayKey();
    const sessions = await chrome.runtime.sendMessage({
      type: MSG.GET_SESSIONS,
      data: { startDate: today, endDate: today },
    });
    const { score } = computeFocusScore(sessions ?? []);
    // null means too little data to judge — never render that as a zero.
    focusScoreEl.textContent = score === null ? '--' : String(score);
  } catch (err) {
    log.warn('Could not compute focus score:', err?.message);
  }
}

// ─── Live timer ────────────────────────────────────────────────────

function startSessionTimer() {
  if (sessionTimer) clearInterval(sessionTimer);
  sessionTimer = setInterval(() => {
    if (sessionStartTime > 0) {
      currentTime.textContent = formatDurationPrecise(
        sessionElapsedBase + (Date.now() - sessionStartTime)
      );
    }
  }, 1000);
}

// ─── Top domains ───────────────────────────────────────────────────

function renderTopDomains(domainBreakdown) {
  const entries = Object.entries(domainBreakdown)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);

  if (entries.length === 0) {
    render(domainList, html`<li class="hud-empty">NO DATA YET</li>`);
    return;
  }

  const maxTime = entries[0][1];
  render(domainList, html`${entries.map(([domain, time]) => {
    const barWidth = Math.max(4, (time / maxTime) * 100).toFixed(1);
    return html`
      <li>
        <div style="flex:1; min-width:0;">
          <div class="domain-info">
            <img class="domain-icon" src="${faviconUrl(domain)}" alt=""
                 onerror="this.style.visibility='hidden'">
            <span class="domain-name">${domain}</span>
          </div>
          <div class="domain-bar" style="width:${barWidth}%"></div>
        </div>
        <span class="domain-time">${formatDuration(time)}</span>
      </li>
    `;
  })}`);
}

// ─── Category ring ─────────────────────────────────────────────────

function renderCategoryChart(categoryBreakdown) {
  const ctx = categoryChart.getContext('2d');
  const size = categoryChart.width;
  const entries = Object.entries(categoryBreakdown).filter(([, v]) => v > 0);

  ctx.clearRect(0, 0, size, size);

  const centre = size / 2;
  const outer = centre - 6;
  const inner = outer - 9;

  // Canvas cannot read CSS custom properties, so the theme colours are
  // resolved here and passed in explicitly.
  const trackColour = themeColor('--line', 'rgba(255,255,255,0.07)');

  if (entries.length === 0) {
    ring(ctx, centre, outer, inner, 0, Math.PI * 2, trackColour);
    return;
  }

  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  let angle = -Math.PI / 2;

  // Faint full ring behind the segments so an almost-empty day still reads
  // as a dial rather than a stray arc.
  ring(ctx, centre, outer, inner, 0, Math.PI * 2, trackColour);

  for (const [categoryId, time] of entries) {
    const sweep = (time / total) * Math.PI * 2;
    ring(ctx, centre, outer, inner, angle, angle + sweep, cssColor(categories.get(categoryId).color));
    angle += sweep;
  }
}

function ring(ctx, centre, outer, inner, from, to, colour) {
  ctx.beginPath();
  ctx.arc(centre, centre, outer, from, to);
  ctx.arc(centre, centre, inner, to, from, true);
  ctx.closePath();
  ctx.fillStyle = colour;
  ctx.fill();
}

// ─── Uncategorized queue ───────────────────────────────────────────

async function loadUncategorized() {
  try {
    const uncategorized = await chrome.runtime.sendMessage({ type: MSG.GET_UNCATEGORIZED });
    if (!uncategorized || uncategorized.length === 0) {
      uncatNotice.hidden = true;
      return;
    }

    const first = uncategorized[0];
    uncatDomain.textContent = first.domain;
    uncatNotice.hidden = false;

    render(categoryButtons, html`${categories.assignable().map((c) =>
      html`<button class="cat-btn" data-id="${c.id}">${c.icon} ${c.name}</button>`
    )}`);

    categoryButtons.querySelectorAll('.cat-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await chrome.runtime.sendMessage({
          type: MSG.CATEGORIZE_DOMAIN,
          data: { domain: first.domain, categoryId: btn.dataset.id, title: first.title },
        });
        await loadUncategorized();
        await loadStats();
      });
    });
  } catch (err) {
    log.error('Error loading uncategorized:', err);
  }
}

// ─── Events ────────────────────────────────────────────────────────

trackingToggle.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: MSG.TOGGLE_TRACKING,
    data: { enabled: trackingToggle.checked },
  });

  if (trackingToggle.checked) {
    pulseDot.classList.remove('is-off');
  } else {
    pulseDot.classList.add('is-off');
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
