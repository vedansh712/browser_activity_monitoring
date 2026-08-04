import { MSG } from '../shared/constants.js';
import {
  formatDuration,
  formatDate,
  todayKey,
  getDateRange,
  faviconUrl,
} from '../shared/utils.js';
import { bucketSessionsByHour, HOURS_PER_DAY } from '../shared/data-models.js';
import { createCategoryRegistry } from '../shared/category-registry.js';
import { html, render, cssColor } from '../shared/html.js';
import { toCsv } from '../shared/csv.js';
import { createLogger } from '../shared/logger.js';
import * as storage from '../background/storage-manager.js';

const log = createLogger('dashboard');

// ─── Constants ─────────────────────────────────────────────────────

const RANGES = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' });
const TOP_CHANNELS = 8;
const MAX_VIDEO_ROWS = 50;
const CHANNEL_LABEL_MAX = 20;

// Chart.js needs concrete colours; keeping them here rather than inline keeps
// the theme in one place.
const THEME = Object.freeze({
  accent: '#667eea',
  accentFill: 'rgba(102, 126, 234, 0.6)',
  youtube: 'rgba(255, 0, 0, 0.6)',
  grid: 'rgba(255,255,255,0.03)',
  axis: '#666',
  label: '#b0b0b0',
  palette: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#E7E9ED', '#7BC225'],
});

// ─── State ─────────────────────────────────────────────────────────

let currentRange = RANGES.DAILY;
let currentDate = new Date();
let categories = createCategoryRegistry();

const chartInstances = new Map();

/** Latest loaded data, kept so table re-sorts don't re-query storage. */
let loadedSessions = [];

const domainView = { sortKey: 'time', sortDir: 'desc', categoryFilter: 'all' };

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const stored = await storage.getCategories();
    categories = createCategoryRegistry(stored);
  } catch (err) {
    // A category load failure must not blank the whole dashboard; the registry
    // falls back to built-ins and custom categories simply won't be named.
    log.error('Could not load categories:', err);
  }

  setupNavigation();
  setupDateControls();
  setupViewTabs();
  setupDomainControls();
  setupReassignModal();
  setupExport();

  await loadData();
});

// ─── Navigation ────────────────────────────────────────────────────

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
      item.classList.add('active');

      const view = item.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById(`view-${view}`).classList.add('active');
    });
  });

  document.getElementById('btn-settings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

// ─── Date Controls ─────────────────────────────────────────────────

function setupDateControls() {
  document.getElementById('prev-period').addEventListener('click', () => shiftDate(-1));
  document.getElementById('next-period').addEventListener('click', () => shiftDate(1));
}

function shiftDate(direction) {
  const next = new Date(currentDate);
  switch (currentRange) {
    case RANGES.DAILY:
      next.setDate(next.getDate() + direction);
      break;
    case RANGES.WEEKLY:
      next.setDate(next.getDate() + direction * 7);
      break;
    case RANGES.MONTHLY:
      // Anchor to the 1st before shifting: from the 31st, adding a month lands
      // on the 3rd of the month after next.
      next.setDate(1);
      next.setMonth(next.getMonth() + direction);
      break;
  }
  currentDate = next;
  loadData();
}

function getDateRangeForView() {
  const anchor = new Date(currentDate);

  switch (currentRange) {
    case RANGES.WEEKLY: {
      const weekStart = new Date(anchor);
      weekStart.setDate(anchor.getDate() - anchor.getDay());
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      return { start: formatDate(weekStart), end: formatDate(weekEnd) };
    }
    case RANGES.MONTHLY: {
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      return { start: formatDate(monthStart), end: formatDate(monthEnd) };
    }
    default: {
      const day = formatDate(anchor);
      return { start: day, end: day };
    }
  }
}

function updateDateLabel() {
  const label = document.getElementById('date-label');
  const { start, end } = getDateRangeForView();

  switch (currentRange) {
    case RANGES.WEEKLY:
      label.textContent = `${start} to ${end}`;
      break;
    case RANGES.MONTHLY:
      label.textContent = currentDate.toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      });
      break;
    default:
      label.textContent = start === todayKey() ? 'Today' : start;
  }
}

function setupViewTabs() {
  document.querySelectorAll('.view-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentRange = tab.dataset.range;
      loadData();
    });
  });
}

// ─── Load Data ─────────────────────────────────────────────────────

async function loadData() {
  updateDateLabel();
  const { start, end } = getDateRangeForView();

  try {
    const [aggregates, sessions] = await Promise.all([
      sendMessage({ type: MSG.GET_AGGREGATES, data: { startDate: start, endDate: end } }),
      sendMessage({ type: MSG.GET_SESSIONS, data: { startDate: start, endDate: end } }),
    ]);

    loadedSessions = sessions ?? [];

    renderOverview(aggregates ?? [], loadedSessions);
    renderDomains();
    renderYouTube(aggregates ?? [], loadedSessions);
    renderCategories(aggregates ?? []);
  } catch (err) {
    log.error('Error loading data:', err);
    showLoadError(err);
  }
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

function showLoadError(err) {
  render(
    document.getElementById('domains-tbody'),
    html`<tr><td colspan="6" class="empty-state">Could not load data: ${err.message}</td></tr>`
  );
}

// ─── Overview ──────────────────────────────────────────────────────

function renderOverview(aggregates, sessions) {
  const totalTime = sum(aggregates.map((a) => a.totalTime || 0));
  const totalSessions = sum(aggregates.map((a) => a.sessionCount || 0));

  document.getElementById('summary-total').textContent = formatDuration(totalTime);
  document.getElementById('summary-sessions').textContent = totalSessions;

  const catTotals = mergeTotals(aggregates, 'categoryBreakdown');
  const topCat = topEntry(catTotals);
  document.getElementById('summary-top-cat').textContent = topCat
    ? categories.get(topCat[0]).name
    : '-';

  const domTotals = mergeTotals(aggregates, 'domainBreakdown');
  const topDom = topEntry(domTotals);
  document.getElementById('summary-top-domain').textContent = topDom ? topDom[0] : '-';

  renderTimeTrendChart(aggregates, sessions);
  renderCategoryDoughnut(catTotals);
  renderHourlyHeatmap(sessions);
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

function mergeTotals(aggregates, key) {
  const totals = {};
  for (const agg of aggregates) {
    for (const [id, time] of Object.entries(agg?.[key] ?? {})) {
      totals[id] = (totals[id] || 0) + time;
    }
  }
  return totals;
}

const topEntry = (totals) => Object.entries(totals).sort(([, a], [, b]) => b - a)[0];

// ─── Charts ────────────────────────────────────────────────────────

/**
 * Replace a chart, disposing the previous instance.
 * Chart.js leaks its canvas registration if an instance isn't destroyed first.
 */
function replaceChart(canvasId, config) {
  chartInstances.get(canvasId)?.destroy();
  chartInstances.delete(canvasId);

  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;

  chartInstances.set(canvasId, new Chart(canvas, config));
}

/**
 * Toggle a chart's empty-state message.
 *
 * Uses a dedicated element that is shown or hidden, rather than injecting a
 * paragraph on each render — the previous approach appended a new message
 * every time the user changed dates, and they accumulated indefinitely.
 */
function setChartEmpty(canvasId, isEmpty, message) {
  const canvas = document.getElementById(canvasId);
  const placeholder = document.getElementById(`${canvasId}-empty`);
  if (canvas) canvas.hidden = isEmpty;
  if (placeholder) {
    placeholder.hidden = !isEmpty;
    if (message) placeholder.textContent = message;
  }
  if (isEmpty) {
    chartInstances.get(canvasId)?.destroy();
    chartInstances.delete(canvasId);
  }
}

function hourLabel(hour) {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}

/**
 * Time trend.
 *
 * Daily view buckets by hour of the day. It previously mapped each date to
 * `date.getHours()` — always 0 for a date key — so a single day rendered one
 * bar labelled "0:00". Multi-day views plot one point per day.
 */
function renderTimeTrendChart(aggregates, sessions) {
  const isDaily = currentRange === RANGES.DAILY;
  const title = document.getElementById('time-trend-title');
  if (title) title.textContent = isDaily ? 'Time by Hour' : 'Time Trend';

  let labels;
  let minutes;

  if (isDaily) {
    const buckets = bucketSessionsByHour(sessions);
    labels = Array.from({ length: HOURS_PER_DAY }, (_, h) => hourLabel(h));
    minutes = buckets.map((ms) => Math.round(ms / 60000));
  } else {
    const { start, end } = getDateRangeForView();
    const byDate = new Map(aggregates.map((a) => [a.date, a]));
    const dates = getDateRange(start, end);
    labels = dates.map((d) =>
      new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    );
    minutes = dates.map((d) => Math.round((byDate.get(d)?.totalTime ?? 0) / 60000));
  }

  const isEmpty = minutes.every((m) => m === 0);
  setChartEmpty('time-trend-chart', isEmpty);
  if (isEmpty) return;

  replaceChart('time-trend-chart', {
    type: isDaily ? 'bar' : 'line',
    data: {
      labels,
      datasets: [{
        label: 'Minutes',
        data: minutes,
        backgroundColor: THEME.accentFill,
        borderColor: THEME.accent,
        borderWidth: 2,
        borderRadius: 4,
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatDuration(ctx.raw * 60000) } },
      },
      scales: {
        x: { grid: { color: THEME.grid }, ticks: { color: THEME.axis, font: { size: 10 } } },
        y: {
          grid: { color: THEME.grid },
          ticks: { color: THEME.axis, font: { size: 10 }, callback: (v) => `${v}m` },
        },
      },
    },
  });
}

function renderCategoryDoughnut(catTotals) {
  const entries = Object.entries(catTotals)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  setChartEmpty('category-doughnut', entries.length === 0);
  if (entries.length === 0) return;

  replaceChart('category-doughnut', {
    type: 'doughnut',
    data: {
      labels: entries.map(([id]) => categories.get(id).name),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([id]) => cssColor(categories.get(id).color)),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'bottom', labels: { color: THEME.label, font: { size: 11 }, padding: 12 } },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = sum(ctx.dataset.data);
              const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : '0.0';
              return `${ctx.label}: ${formatDuration(ctx.raw)} (${pct}%)`;
            },
          },
        },
      },
    },
  });
}

function renderHourlyHeatmap(sessions) {
  const container = document.getElementById('hourly-heatmap');
  const buckets = bucketSessionsByHour(sessions);
  const minutes = buckets.map((ms) => ms / 60000);
  const maxMinutes = Math.max(...minutes, 1);

  render(container, html`${minutes.map((value, hour) => {
    const intensity = value / maxMinutes;
    const r = Math.round(102 + intensity * 50);
    const g = Math.round(126 - intensity * 60);
    const b = Math.round(234 - intensity * 70);
    const alpha = (0.1 + intensity * 0.8).toFixed(3);
    return html`<div class="heatmap-cell" style="background: rgba(${r}, ${g}, ${b}, ${alpha})"
      ><span class="tooltip">${hourLabel(hour)}: ${Math.round(value)}m</span></div>`;
  })}`);

  let labelsRow = container.parentElement.querySelector('.heatmap-labels');
  if (!labelsRow) {
    labelsRow = document.createElement('div');
    labelsRow.className = 'heatmap-labels';
    container.after(labelsRow);
  }
  render(labelsRow, html`${Array.from({ length: HOURS_PER_DAY }, (_, h) =>
    html`<span class="heatmap-label">${h % 3 === 0 ? hourLabel(h).replace('m', '') : ''}</span>`
  )}`);
}

// ─── Domains View ──────────────────────────────────────────────────

function setupDomainControls() {
  const filter = document.getElementById('domain-category-filter');
  render(filter, html`
    <option value="all">All Categories</option>
    ${categories.all().map((c) => html`<option value="${c.id}">${c.icon} ${c.name}</option>`)}
  `);
  filter.value = domainView.categoryFilter;
  filter.addEventListener('change', () => {
    domainView.categoryFilter = filter.value;
    renderDomains();
  });

  document.querySelectorAll('#domains-table th.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (domainView.sortKey === key) {
        domainView.sortDir = domainView.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        domainView.sortKey = key;
        // Text sorts read naturally ascending; magnitudes read descending.
        domainView.sortDir = key === 'domain' ? 'asc' : 'desc';
      }
      renderDomains();
    });
  });
}

/**
 * Collapse sessions into per-domain rows.
 *
 * A domain's category is the one it spent the most time in, rather than
 * whichever session happened to be encountered first.
 */
function aggregateDomains(sessions) {
  const byDomain = new Map();

  for (const session of sessions) {
    if (!session.domain || !(session.duration > 0)) continue;

    let row = byDomain.get(session.domain);
    if (!row) {
      row = { domain: session.domain, time: 0, sessions: 0, categoryTime: new Map() };
      byDomain.set(session.domain, row);
    }
    row.time += session.duration;
    row.sessions += 1;

    const catId = session.categoryId || 'uncategorized';
    row.categoryTime.set(catId, (row.categoryTime.get(catId) ?? 0) + session.duration);
  }

  for (const row of byDomain.values()) {
    row.categoryId = [...row.categoryTime.entries()].sort(([, a], [, b]) => b - a)[0][0];
  }
  return [...byDomain.values()];
}

function sortDomainRows(rows, key, direction) {
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'domain') return factor * a.domain.localeCompare(b.domain);
    return factor * ((a[key] ?? 0) - (b[key] ?? 0));
  });
}

function renderDomains() {
  const tbody = document.getElementById('domains-tbody');

  let rows = aggregateDomains(loadedSessions);
  if (domainView.categoryFilter !== 'all') {
    rows = rows.filter((r) => r.categoryId === domainView.categoryFilter);
  }
  rows = sortDomainRows(rows, domainView.sortKey, domainView.sortDir);

  updateSortIndicators();

  if (rows.length === 0) {
    render(tbody, html`<tr><td colspan="6" class="empty-state">No data for this period</td></tr>`);
    return;
  }

  render(tbody, html`${rows.map((row, i) => {
    const cat = categories.get(row.categoryId);
    const color = cssColor(cat.color);
    return html`
      <tr>
        <td>${i + 1}</td>
        <td>
          <div class="domain-cell">
            <img src="${faviconUrl(row.domain)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            ${row.domain}
          </div>
        </td>
        <td>${formatDuration(row.time)}</td>
        <td>${row.sessions}</td>
        <td><span class="category-badge" style="background:${color}22; color:${color}">${cat.icon} ${cat.name}</span></td>
        <td><button class="reassign-btn" data-domain="${row.domain}">Reassign</button></td>
      </tr>
    `;
  })}`);

  tbody.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', () => openReassignModal(btn.dataset.domain));
  });
}

function updateSortIndicators() {
  document.querySelectorAll('#domains-table th.sortable').forEach((th) => {
    const isActive = th.dataset.sort === domainView.sortKey;
    th.classList.toggle('active', isActive);
    th.dataset.dir = isActive ? domainView.sortDir : '';
  });
}

// ─── Reassign Modal ────────────────────────────────────────────────

let pendingReassignDomain = null;

function setupReassignModal() {
  document.getElementById('reassign-cancel').addEventListener('click', closeReassignModal);

  const modal = document.getElementById('reassign-modal');
  // Backdrop click and Escape both dismiss, matching normal dialog behaviour.
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeReassignModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeReassignModal();
  });
}

/**
 * Replaces a prompt() that asked the user to type a category number.
 */
function openReassignModal(domain) {
  pendingReassignDomain = domain;
  document.getElementById('reassign-domain').textContent = domain;

  const options = document.getElementById('reassign-options');
  render(options, html`${categories.assignable().map((cat) => html`
    <button class="cat-choice" data-id="${cat.id}" style="border-color:${cssColor(cat.color)}">
      <span class="cat-choice-icon">${cat.icon}</span>
      <span>${cat.name}</span>
    </button>
  `)}`);

  options.querySelectorAll('.cat-choice').forEach((btn) => {
    btn.addEventListener('click', () => applyReassignment(btn.dataset.id));
  });

  document.getElementById('reassign-modal').hidden = false;
}

function closeReassignModal() {
  document.getElementById('reassign-modal').hidden = true;
  pendingReassignDomain = null;
}

async function applyReassignment(categoryId) {
  const domain = pendingReassignDomain;
  closeReassignModal();
  if (!domain) return;

  try {
    await sendMessage({
      type: MSG.CATEGORIZE_DOMAIN,
      data: { domain, categoryId, title: '' },
    });
    await loadData();
  } catch (err) {
    log.error('Reassignment failed:', err);
  }
}

// ─── YouTube View ──────────────────────────────────────────────────

/**
 * Group YouTube sessions by video, keeping the most complete metadata seen.
 *
 * The same video is recorded across several flushed session chunks, and early
 * chunks may have been written before the page finished exposing its metadata.
 */
function collectVideos(sessions) {
  const byVideo = new Map();

  for (const session of sessions) {
    const videoId = session.meta?.videoId;
    if (!videoId) continue;

    let entry = byVideo.get(videoId);
    if (!entry) {
      entry = { videoId, meta: session.meta, metaScore: -1, watchTime: 0 };
      byVideo.set(videoId, entry);
    }
    entry.watchTime += session.duration || 0;

    const score =
      (session.meta.videoTitle ? 2 : 0) +
      (session.meta.channelName ? 2 : 0) +
      (session.meta.videoCategory ? 1 : 0) +
      (session.meta.videoDuration ? 1 : 0);

    if (score > entry.metaScore) {
      entry.meta = session.meta;
      entry.metaScore = score;
    }
  }
  return [...byVideo.values()];
}

function renderYouTube(aggregates, sessions) {
  const videos = collectVideos(sessions);

  let totalWatchTime = sum(videos.map((v) => v.watchTime));
  let totalVideos = videos.length;
  const channelTotals = {};
  const ytCatTotals = {};

  for (const { meta, watchTime } of videos) {
    const channel = meta.channelName || 'Unknown';
    channelTotals[channel] = (channelTotals[channel] || 0) + watchTime;
    const cat = meta.videoCategory || 'Unknown';
    ytCatTotals[cat] = (ytCatTotals[cat] || 0) + watchTime;
  }

  // Fall back to stored aggregates when raw sessions have been pruned.
  if (totalVideos === 0) {
    for (const agg of aggregates) {
      const stats = agg?.youtubeStats;
      if (!stats) continue;
      totalWatchTime += stats.totalWatchTime || 0;
      totalVideos += stats.videosWatched || 0;
      for (const ch of stats.topChannels ?? []) {
        channelTotals[ch.name] = (channelTotals[ch.name] || 0) + ch.time;
      }
      for (const [cat, time] of Object.entries(stats.categoryBreakdown ?? {})) {
        ytCatTotals[cat] = (ytCatTotals[cat] || 0) + time;
      }
    }
  }

  document.getElementById('yt-watch-time').textContent = formatDuration(totalWatchTime);
  document.getElementById('yt-video-count').textContent = totalVideos;

  renderYTChannelsChart(channelTotals);
  renderYTCategoriesChart(ytCatTotals);

  const tbody = document.getElementById('yt-videos-tbody');
  if (videos.length === 0) {
    render(tbody, html`<tr><td colspan="5" class="empty-state">No YouTube data</td></tr>`);
    return;
  }

  const rows = [...videos].sort((a, b) => b.watchTime - a.watchTime).slice(0, MAX_VIDEO_ROWS);
  render(tbody, html`${rows.map(({ meta, watchTime }) => html`
    <tr>
      <td>${meta.videoTitle || 'Unknown'}</td>
      <td>${meta.channelName || 'Unknown'}</td>
      <td>${meta.videoDuration ? formatDuration(meta.videoDuration * 1000) : '-'}</td>
      <td>${formatDuration(watchTime)}</td>
      <td>${meta.videoCategory || 'Unknown'}</td>
    </tr>
  `)}`);
}

function renderYTChannelsChart(channelTotals) {
  const entries = Object.entries(channelTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, TOP_CHANNELS);

  setChartEmpty('yt-channels-chart', entries.length === 0);
  if (entries.length === 0) return;

  replaceChart('yt-channels-chart', {
    type: 'bar',
    data: {
      labels: entries.map(([name]) =>
        name.length > CHANNEL_LABEL_MAX ? `${name.slice(0, CHANNEL_LABEL_MAX)}…` : name
      ),
      datasets: [{
        data: entries.map(([, time]) => Math.round(time / 60000)),
        backgroundColor: THEME.youtube,
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => formatDuration(ctx.raw * 60000) } },
      },
      scales: {
        x: { grid: { color: THEME.grid }, ticks: { color: THEME.axis, callback: (v) => `${v}m` } },
        y: { grid: { display: false }, ticks: { color: THEME.label, font: { size: 11 } } },
      },
    },
  });
}

function renderYTCategoriesChart(ytCatTotals) {
  const entries = Object.entries(ytCatTotals).filter(([, v]) => v > 0);

  setChartEmpty('yt-categories-chart', entries.length === 0);
  if (entries.length === 0) return;

  replaceChart('yt-categories-chart', {
    type: 'pie',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map((_, i) => THEME.palette[i % THEME.palette.length]),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: THEME.label, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => `${ctx.label}: ${formatDuration(ctx.raw)}` } },
      },
    },
  });
}

// ─── Categories View ───────────────────────────────────────────────

function renderCategories(aggregates) {
  const container = document.getElementById('category-breakdown');
  const catTotals = mergeTotals(aggregates, 'categoryBreakdown');
  const sorted = Object.entries(catTotals)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    render(container, html`
      <div class="empty-state"><h3>No data</h3><p>Browse some websites and check back!</p></div>
    `);
    return;
  }

  const totalTime = sum(sorted.map(([, v]) => v));

  render(container, html`${sorted.map(([catId, time]) => {
    const cat = categories.get(catId);
    const color = cssColor(cat.color);
    const pct = ((time / totalTime) * 100).toFixed(1);
    return html`
      <div class="category-row">
        <span class="category-color" style="background: ${color}"></span>
        <span class="category-name">${cat.icon} ${cat.name}</span>
        <div class="category-bar-container">
          <div class="category-bar-fill" style="width: ${pct}%; background: ${color}">
            ${Number(pct) > 8 ? formatDuration(time) : ''}
          </div>
        </div>
        <span class="category-time">${formatDuration(time)}</span>
        <span class="category-percent">${pct}%</span>
      </div>
    `;
  })}`);
}

// ─── Export ─────────────────────────────────────────────────────────

function setupExport() {
  document.getElementById('btn-export').addEventListener('click', exportCsv);
}

async function exportCsv() {
  const { start, end } = getDateRangeForView();

  try {
    const sessions = await sendMessage({
      type: MSG.GET_SESSIONS,
      data: { startDate: start, endDate: end },
    });

    if (!sessions || sessions.length === 0) {
      log.warn('No data to export for this period');
      return;
    }

    const headers = [
      'Date', 'Domain', 'Title', 'Category',
      'Start Time', 'End Time', 'Duration (min)', 'URL',
    ];

    // Values pass through toCsv, which quotes separators and neutralises
    // spreadsheet formulas — page titles are attacker-controlled.
    const rows = sessions.map((s) => [
      s.date,
      s.domain,
      s.title ?? '',
      categories.get(s.categoryId).name,
      s.startTime ? new Date(s.startTime).toISOString() : '',
      s.endTime ? new Date(s.endTime).toISOString() : '',
      ((s.duration ?? 0) / 60000).toFixed(1),
      s.url ?? '',
    ]);

    downloadFile(
      toCsv(headers, rows),
      `track-daily-${start}-to-${end}.csv`,
      'text/csv;charset=utf-8'
    );
  } catch (err) {
    log.error('Export failed:', err);
  }
}

function downloadFile(content, filename, mimeType) {
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel the download before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
