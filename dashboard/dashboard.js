import { MSG } from '../shared/constants.js';
import {
  formatDuration,
  formatDate,
  todayKey,
  getDateRange,
  faviconUrl,
} from '../shared/utils.js';
import { bucketSessionsByHour, HOURS_PER_DAY } from '../shared/data-models.js';
import {
  computeFocusScore,
  countContextSwitches,
  computeDelta,
  previousPeriod,
  buildBlocks,
} from '../shared/metrics.js';
import { createCategoryRegistry } from '../shared/category-registry.js';
import { html, render, cssColor } from '../shared/html.js';
import { initTheme, refreshAccent, themeColor } from '../shared/theme.js';
import { toCsv } from '../shared/csv.js';
import { createLogger } from '../shared/logger.js';
import * as storage from '../background/storage-manager.js';

const log = createLogger('dashboard');

// ─── Constants ─────────────────────────────────────────────────────

const RANGES = Object.freeze({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly' });
const TOP_CHANNELS = 8;
const MAX_VIDEO_ROWS = 50;
const CHANNEL_LABEL_MAX = 20;
const SPARK_DAYS = 7;

/** How often the dynamic accent re-checks elapsed time while the tab is open. */
const ACCENT_REFRESH_MS = 60_000;

/** Circumference of the focus gauge arc (r=56), for stroke-dashoffset. */
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 56;

// ─── State ─────────────────────────────────────────────────────────

let currentRange = RANGES.DAILY;
let currentDate = new Date();
let categories = createCategoryRegistry();

const chartInstances = new Map();
let loadedSessions = [];

const domainView = { sortKey: 'time', sortDir: 'desc', categoryFilter: 'all' };

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await initTheme();

  try {
    categories = createCategoryRegistry(await storage.getCategories());
  } catch (err) {
    log.error('Could not load categories:', err);
  }

  setupNavigation();
  setupDateControls();
  setupViewTabs();
  setupDomainControls();
  setupReassignModal();
  setupExport();

  // Charts read their colours from CSS custom properties, so a live accent
  // change has to redraw them — the canvas cannot inherit a variable.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) loadData();
  });

  // The dashboard is left open for long stretches; in dynamic mode the accent
  // should drift as the day accumulates rather than freezing at page load.
  setInterval(() => {
    refreshAccent().catch(() => {});
  }, ACCENT_REFRESH_MS);

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

// ─── Date controls ─────────────────────────────────────────────────

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
      // Anchor to the 1st first: from the 31st, adding a month lands on the
      // 3rd of the month after next.
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
      label.textContent = `${start} → ${end}`;
      break;
    case RANGES.MONTHLY:
      label.textContent = currentDate
        .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
        .toUpperCase();
      break;
    default:
      label.textContent = start === todayKey() ? 'TODAY' : start;
  }
}

function setupViewTabs() {
  document.querySelectorAll('.view-tabs button').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.view-tabs button').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      currentRange = tab.dataset.range;
      loadData();
    });
  });
}

// ─── Load ──────────────────────────────────────────────────────────

async function loadData() {
  updateDateLabel();
  const { start, end } = getDateRangeForView();
  const prev = previousPeriod(start, end);
  const sparkStart = shiftKey(end, -(SPARK_DAYS - 1));

  try {
    const [aggregates, sessions, prevAggregates, prevSessions, sparkAggregates] = await Promise.all([
      sendMessage({ type: MSG.GET_AGGREGATES, data: { startDate: start, endDate: end } }),
      sendMessage({ type: MSG.GET_SESSIONS, data: { startDate: start, endDate: end } }),
      sendMessage({ type: MSG.GET_AGGREGATES, data: { startDate: prev.start, endDate: prev.end } }),
      sendMessage({ type: MSG.GET_SESSIONS, data: { startDate: prev.start, endDate: prev.end } }),
      sendMessage({ type: MSG.GET_AGGREGATES, data: { startDate: sparkStart, endDate: end } }),
    ]);

    loadedSessions = sessions ?? [];

    renderOverview({
      aggregates: aggregates ?? [],
      sessions: loadedSessions,
      prevAggregates: prevAggregates ?? [],
      prevSessions: prevSessions ?? [],
      sparkAggregates: sparkAggregates ?? [],
    });
    renderDomains();
    renderYouTube(aggregates ?? [], loadedSessions);
    renderCategories(aggregates ?? []);
  } catch (err) {
    log.error('Error loading data:', err);
    render(
      document.getElementById('domains-tbody'),
      html`<tr><td colspan="6" class="hud-empty">COULD NOT LOAD DATA — ${err.message}</td></tr>`
    );
  }
}

function shiftKey(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00`);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (response?.error) throw new Error(response.error);
  return response;
}

// ─── Overview ──────────────────────────────────────────────────────

function renderOverview({ aggregates, sessions, prevAggregates, prevSessions, sparkAggregates }) {
  const totalTime = sum(aggregates.map((a) => a.totalTime || 0));
  const totalSessions = sum(aggregates.map((a) => a.sessionCount || 0));
  const switches = countContextSwitches(sessions);

  const prevTotalTime = sum(prevAggregates.map((a) => a.totalTime || 0));
  const prevTotalSessions = sum(prevAggregates.map((a) => a.sessionCount || 0));
  const prevSwitches = countContextSwitches(prevSessions);

  setText('summary-total', formatDuration(totalTime));
  setText('summary-sessions', String(totalSessions));
  setText('summary-switches', String(switches));

  renderDelta('summary-total-delta', computeDelta(totalTime, prevTotalTime), 'time');
  renderDelta('summary-sessions-delta', computeDelta(totalSessions, prevTotalSessions), 'count');
  // More switching is worse, so its "good" direction is inverted.
  renderDelta('summary-switches-delta', computeDelta(switches, prevSwitches), 'count', true);

  const domTotals = mergeTotals(aggregates, 'domainBreakdown');
  const topDom = topEntry(domTotals);
  setText('summary-top-domain', topDom ? topDom[0] : '-');
  setText(
    'summary-top-domain-detail',
    topDom ? `${formatDuration(topDom[1])} · ${pct(topDom[1], totalTime)}% of total` : ''
  );

  renderSparks(sparkAggregates);
  renderFocus(sessions);

  const catTotals = mergeTotals(aggregates, 'categoryBreakdown');
  renderTimeTrendChart(aggregates, sessions);
  renderCategoryDoughnut(catTotals);
  renderHourlyHeatmap(sessions);
}

const sum = (values) => values.reduce((total, v) => total + v, 0);
const pct = (part, whole) => (whole > 0 ? ((part / whole) * 100).toFixed(0) : '0');

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

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

/**
 * Render a period-over-period delta.
 *
 * @param {boolean} lowerIsBetter - inverts which direction is coloured as good
 */
function renderDelta(id, delta, kind, lowerIsBetter = false) {
  const el = document.getElementById(id);
  if (!el) return;

  el.classList.remove('is-up', 'is-down');

  if (delta.direction === 'flat' || (delta.absolute === 0 && delta.ratio === null)) {
    el.textContent = 'no change vs previous';
    return;
  }

  const rising = delta.direction === 'up';
  const good = lowerIsBetter ? !rising : rising;
  el.classList.add(good ? 'is-up' : 'is-down');

  const arrow = rising ? '▲' : '▼';
  const magnitude =
    delta.ratio === null
      ? kind === 'time'
        ? formatDuration(Math.abs(delta.absolute))
        : String(Math.abs(delta.absolute))
      : `${Math.abs(delta.ratio * 100).toFixed(0)}%`;

  el.textContent = `${arrow} ${magnitude} vs previous`;
}

/** Trailing-day bars beneath each stat, peak highlighted. */
function renderSparks(sparkAggregates) {
  const byDate = new Map(sparkAggregates.map((a) => [a.date, a]));
  const { end } = getDateRangeForView();
  const days = Array.from({ length: SPARK_DAYS }, (_, i) =>
    shiftKey(end, -(SPARK_DAYS - 1 - i))
  );

  const series = {
    'summary-total-spark': days.map((d) => byDate.get(d)?.totalTime ?? 0),
    'summary-sessions-spark': days.map((d) => byDate.get(d)?.sessionCount ?? 0),
    'summary-switches-spark': days.map((d) => Object.keys(byDate.get(d)?.domainBreakdown ?? {}).length),
    'summary-top-domain-spark': days.map((d) => byDate.get(d)?.totalTime ?? 0),
  };

  for (const [id, values] of Object.entries(series)) {
    const container = document.getElementById(id);
    if (!container) continue;

    const max = Math.max(...values, 1);
    render(container, html`${values.map((value, i) => {
      const height = Math.max(2, Math.round((value / max) * 100));
      const peak = value === max && value > 0;
      return html`<i class="${peak ? 'is-peak' : ''}"
        style="height:${height}%"
        title="${days[i]}"></i>`;
    })}`);
  }
}

/**
 * Focus gauge.
 *
 * A null score means too little data to judge, and is rendered as "--" rather
 * than as zero — claiming someone was maximally unfocused because they browsed
 * for four minutes would be worse than saying nothing.
 */
function renderFocus(sessions) {
  const focus = computeFocusScore(sessions);
  const arc = document.getElementById('focus-arc');
  const scoreEl = document.getElementById('focus-score');

  const score = focus.score;
  scoreEl.textContent = score === null ? '--' : String(score);

  const fraction = score === null ? 0 : score / 100;
  arc.setAttribute('stroke-dashoffset', String(GAUGE_CIRCUMFERENCE * (1 - fraction)));

  const rows = [
    { k: 'Deep work', v: `${(focus.deepWorkRatio * 100).toFixed(0)}%`, w: focus.deepWorkRatio },
    {
      k: 'Longest block',
      v: focus.longestBlockMs > 0 ? formatDuration(focus.longestBlockMs) : '—',
      // Shown against a one-hour reference so the bar has a stable meaning.
      w: Math.min(1, focus.longestBlockMs / (60 * 60 * 1000)),
    },
    {
      k: 'Switches / hr',
      v: focus.totalMs > 0 ? focus.switchesPerHour.toFixed(1) : '—',
      w: Math.min(1, focus.switchesPerHour / 30),
    },
  ];

  render(document.getElementById('focus-legend'), html`${rows.map((row) => html`
    <div>
      <div class="focus-row"><span class="k">${row.k}</span><span class="v">${row.v}</span></div>
      <div class="focus-bar"><i style="width:${(row.w * 100).toFixed(1)}%"></i></div>
    </div>
  `)}`);
}

// ─── Charts ────────────────────────────────────────────────────────

/** Chart colours are read from the theme so they follow the user's accent. */
function chartTheme() {
  return {
    accent: themeColor('--accent', '#ff2b4a'),
    grid: 'rgba(255,255,255,0.04)',
    axis: themeColor('--ink-3', '#58607a'),
    label: themeColor('--ink-2', '#99a2b8'),
    font: 'ui-monospace, Consolas, monospace',
  };
}

function replaceChart(canvasId, config) {
  chartInstances.get(canvasId)?.destroy();
  chartInstances.delete(canvasId);

  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === 'undefined') return;

  chartInstances.set(canvasId, new Chart(canvas, config));
}

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
 * Top panel: a timeline of the day, or a per-day trend for longer ranges.
 *
 * Daily view previously drew an hourly histogram here, which was the same
 * numbers as the "Activity by Hour" panel below it rendered a second way. The
 * timeline answers what that histogram cannot: what was actually visited, in
 * what order, and where the unbroken stretches were.
 */
function renderTimeTrendChart(aggregates, sessions) {
  const isDaily = currentRange === RANGES.DAILY;
  const t = chartTheme();

  setText('time-trend-title', isDaily ? 'Day Timeline' : 'Time Trend');
  setText('time-trend-sub', isDaily ? 'LOCAL TIME' : 'PER DAY');

  document.getElementById('trend-chart-wrap').hidden = isDaily;
  document.getElementById('day-timeline').hidden = !isDaily;

  if (isDaily) {
    // Release the chart: its canvas is hidden and Chart.js keeps the
    // registration alive until the instance is destroyed.
    chartInstances.get('time-trend-chart')?.destroy();
    chartInstances.delete('time-trend-chart');
    renderDayTimeline(sessions);
    return;
  }

  const { start, end } = getDateRangeForView();
  const byDate = new Map(aggregates.map((a) => [a.date, a]));
  const dates = getDateRange(start, end);
  const labels = dates.map((d) =>
    new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  );
  const minutes = dates.map((d) => Math.round((byDate.get(d)?.totalTime ?? 0) / 60000));

  const isEmpty = minutes.every((m) => m === 0);
  setChartEmpty('time-trend-chart', isEmpty);
  if (isEmpty) return;

  replaceChart('time-trend-chart', {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Minutes',
        data: minutes,
        backgroundColor: `color-mix(in srgb, ${t.accent} 55%, transparent)`,
        borderColor: t.accent,
        borderWidth: 2,
        pointBackgroundColor: t.accent,
        pointRadius: 2,
        fill: true,
        tension: 0.35,
      }],
    },
    options: baseChartOptions(t, (ctx) => formatDuration(ctx.raw * 60000), '%sm'),
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** HH:MM in local time. */
function clockLabel(timestamp) {
  const d = new Date(timestamp);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A ribbon of the day: one block per stretch of attention, positioned by when
 * it happened and sized by how long it lasted.
 *
 * Built from metrics blocks rather than raw sessions, because the flush alarm
 * splits a single visit into a row every few minutes — drawing those directly
 * would render one continuous hour of reading as a dotted line of fragments.
 */
function renderDayTimeline(sessions) {
  const container = document.getElementById('day-timeline');
  const blocks = buildBlocks(sessions);

  if (blocks.length === 0) {
    render(container, html`<p class="hud-empty">NO DATA FOR THIS PERIOD</p>`);
    return;
  }

  const { start } = getDateRangeForView();
  const dayStart = new Date(`${start}T00:00:00`).getTime();

  const longest = blocks.reduce((max, b) => Math.max(max, b.duration), 0);

  // Categories actually present, so the legend explains only what is on screen.
  const present = [...new Set(blocks.map((b) => b.categoryId))];

  render(container, html`
    <div class="timeline-track">
      ${blocks.map((block) => {
        const offset = Math.min(100, Math.max(0, ((block.startTime - dayStart) / DAY_MS) * 100));
        // A minimum width keeps brief visits visible; at this scale a single
        // minute is well under a pixel.
        const width = Math.max(0.3, Math.min(100 - offset, (block.duration / DAY_MS) * 100));
        const colour = cssColor(categories.get(block.categoryId).color);
        return html`<div class="timeline-block"
             style="left:${offset.toFixed(3)}%;width:${width.toFixed(3)}%;--block:${colour}">
          <span class="tooltip">${block.domain} · ${formatDuration(block.duration)} · ${clockLabel(block.startTime)}</span>
        </div>`;
      })}
    </div>

    <div class="timeline-scale">
      ${Array.from({ length: 9 }, (_, i) => html`<span class="hud-label">${String(i * 3).padStart(2, '0')}</span>`)}
    </div>

    <div class="timeline-footer">
      <div class="timeline-legend">
        ${present.map((id) => {
          const cat = categories.get(id);
          return html`<span class="legend-item">
            <i style="background:${cssColor(cat.color)}"></i>${cat.name}
          </span>`;
        })}
      </div>
      <span class="hud-label">${blocks.length} BLOCKS · LONGEST ${formatDuration(longest)}</span>
    </div>
  `);
}

function baseChartOptions(t, tooltipLabel, tickSuffix) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#10141e',
        borderColor: 'rgba(255,255,255,0.16)',
        borderWidth: 1,
        titleFont: { family: t.font, size: 10 },
        bodyFont: { family: t.font, size: 11 },
        callbacks: { label: tooltipLabel },
      },
    },
    scales: {
      x: {
        grid: { color: t.grid, drawTicks: false },
        ticks: { color: t.axis, font: { family: t.font, size: 9 }, maxRotation: 0, autoSkipPadding: 12 },
      },
      y: {
        grid: { color: t.grid, drawTicks: false },
        ticks: {
          color: t.axis,
          font: { family: t.font, size: 9 },
          callback: (v) => tickSuffix.replace('%s', v),
        },
      },
    },
  };
}

function renderCategoryDoughnut(catTotals) {
  const t = chartTheme();
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
        borderColor: '#0a0d14',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: t.label, font: { family: t.font, size: 10 }, padding: 10, boxWidth: 9, boxHeight: 9 },
        },
        tooltip: {
          backgroundColor: '#10141e',
          borderColor: 'rgba(255,255,255,0.16)',
          borderWidth: 1,
          bodyFont: { family: t.font, size: 11 },
          callbacks: {
            label: (ctx) => {
              const total = sum(ctx.dataset.data);
              return `${ctx.label}: ${formatDuration(ctx.raw)} (${pct(ctx.raw, total)}%)`;
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
    const height = value > 0 ? Math.max(4, Math.round((value / maxMinutes) * 100)) : 1;
    return html`<div class="heatmap-cell" style="height:${height}%"
      ><span class="tooltip">${hourLabel(hour)} · ${Math.round(value)}m</span></div>`;
  })}`);

  let labelsRow = container.parentElement.querySelector('.heatmap-labels');
  if (!labelsRow) {
    labelsRow = document.createElement('div');
    labelsRow.className = 'heatmap-labels';
    container.after(labelsRow);
  }
  render(labelsRow, html`${Array.from({ length: HOURS_PER_DAY }, (_, h) =>
    html`<span class="heatmap-label">${h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>`
  )}`);
}

// ─── Domains ───────────────────────────────────────────────────────

function setupDomainControls() {
  const filter = document.getElementById('domain-category-filter');
  render(filter, html`
    <option value="all">ALL CATEGORIES</option>
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
        domainView.sortDir = key === 'domain' ? 'asc' : 'desc';
      }
      renderDomains();
    });
  });
}

/** A domain's category is the one it spent the most time in. */
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

  document.querySelectorAll('#domains-table th.sortable').forEach((th) => {
    const isActive = th.dataset.sort === domainView.sortKey;
    th.classList.toggle('active', isActive);
    th.dataset.dir = isActive ? domainView.sortDir : '';
  });

  if (rows.length === 0) {
    render(tbody, html`<tr><td colspan="6" class="hud-empty">NO DATA FOR THIS PERIOD</td></tr>`);
    return;
  }

  render(tbody, html`${rows.map((row, i) => {
    const cat = categories.get(row.categoryId);
    const color = cssColor(cat.color);
    return html`
      <tr>
        <td class="rank">${String(i + 1).padStart(2, '0')}</td>
        <td>
          <div class="domain-cell">
            <img src="${faviconUrl(row.domain)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
            ${row.domain}
          </div>
        </td>
        <td class="hud-num">${formatDuration(row.time)}</td>
        <td class="hud-num">${row.sessions}</td>
        <td><span class="hud-chip" style="color:${color};border-color:color-mix(in srgb, ${color} 40%, transparent);background:color-mix(in srgb, ${color} 9%, transparent)">${cat.name}</span></td>
        <td><button class="reassign-btn" data-domain="${row.domain}">Reassign</button></td>
      </tr>
    `;
  })}`);

  tbody.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', () => openReassignModal(btn.dataset.domain));
  });
}

// ─── Reassign modal ────────────────────────────────────────────────

let pendingReassignDomain = null;

function setupReassignModal() {
  document.getElementById('reassign-cancel').addEventListener('click', closeReassignModal);

  const modal = document.getElementById('reassign-modal');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeReassignModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) closeReassignModal();
  });
}

function openReassignModal(domain) {
  pendingReassignDomain = domain;
  setText('reassign-domain', domain);

  const options = document.getElementById('reassign-options');
  render(options, html`${categories.assignable().map((cat) => html`
    <button class="cat-choice" data-id="${cat.id}" style="border-left-color:${cssColor(cat.color)}">
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

// ─── YouTube ───────────────────────────────────────────────────────

/** Group sessions by video, keeping the most complete metadata seen. */
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

  setText('yt-watch-time', formatDuration(totalWatchTime));
  setText('yt-video-count', String(totalVideos));

  renderYTChannelsChart(channelTotals);
  renderYTCategoriesChart(ytCatTotals);

  const tbody = document.getElementById('yt-videos-tbody');
  if (videos.length === 0) {
    render(tbody, html`<tr><td colspan="5" class="hud-empty">NO YOUTUBE DATA</td></tr>`);
    return;
  }

  const rows = [...videos].sort((a, b) => b.watchTime - a.watchTime).slice(0, MAX_VIDEO_ROWS);
  render(tbody, html`${rows.map(({ meta, watchTime }) => html`
    <tr>
      <td>${meta.videoTitle || 'Unknown'}</td>
      <td>${meta.channelName || 'Unknown'}</td>
      <td class="hud-num">${meta.videoDuration ? formatDuration(meta.videoDuration * 1000) : '—'}</td>
      <td class="hud-num">${formatDuration(watchTime)}</td>
      <td><span class="hud-chip">${meta.videoCategory || 'Unknown'}</span></td>
    </tr>
  `)}`);
}

function renderYTChannelsChart(channelTotals) {
  const t = chartTheme();
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
        backgroundColor: `color-mix(in srgb, ${t.accent} 55%, transparent)`,
        borderColor: t.accent,
        borderWidth: 1,
      }],
    },
    options: {
      indexAxis: 'y',
      ...baseChartOptions(t, (ctx) => formatDuration(ctx.raw * 60000), '%sm'),
    },
  });
}

function renderYTCategoriesChart(ytCatTotals) {
  const t = chartTheme();
  const entries = Object.entries(ytCatTotals).filter(([, v]) => v > 0);

  setChartEmpty('yt-categories-chart', entries.length === 0);
  if (entries.length === 0) return;

  // Fan out around the accent's hue so the pie stays on-theme whatever the
  // user picked, instead of a fixed rainbow that clashes with it.
  const slice = (i) => `color-mix(in srgb, ${t.accent} ${90 - i * 9}%, #1b2030)`;

  replaceChart('yt-categories-chart', {
    type: 'doughnut',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map((_, i) => slice(i)),
        borderColor: '#0a0d14',
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '55%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: t.label, font: { family: t.font, size: 10 }, padding: 8, boxWidth: 9, boxHeight: 9 },
        },
        tooltip: {
          backgroundColor: '#10141e',
          borderColor: 'rgba(255,255,255,0.16)',
          borderWidth: 1,
          bodyFont: { family: t.font, size: 11 },
          callbacks: { label: (ctx) => `${ctx.label}: ${formatDuration(ctx.raw)}` },
        },
      },
    },
  });
}

// ─── Categories ────────────────────────────────────────────────────

function renderCategories(aggregates) {
  const container = document.getElementById('category-breakdown');
  const catTotals = mergeTotals(aggregates, 'categoryBreakdown');
  const sorted = Object.entries(catTotals)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    render(container, html`<p class="hud-empty">NO DATA — BROWSE SOME SITES AND CHECK BACK</p>`);
    return;
  }

  const totalTime = sum(sorted.map(([, v]) => v));

  render(container, html`${sorted.map(([catId, time]) => {
    const cat = categories.get(catId);
    const color = cssColor(cat.color);
    const share = ((time / totalTime) * 100).toFixed(1);
    return html`
      <div class="category-row">
        <span class="category-color" style="background:${color}"></span>
        <span class="category-name">${cat.icon} ${cat.name}</span>
        <div class="category-bar-container">
          <div class="category-bar-fill"
               style="width:${share}%;background:linear-gradient(90deg, color-mix(in srgb, ${color} 25%, transparent), ${color})"></div>
        </div>
        <span class="category-time">${formatDuration(time)}</span>
        <span class="category-percent">${share}%</span>
      </div>
    `;
  })}`);
}

// ─── Export ────────────────────────────────────────────────────────

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

    // toCsv quotes separators and neutralises spreadsheet formulas — page
    // titles are attacker-controlled.
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
