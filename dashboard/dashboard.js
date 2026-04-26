import { MSG, DEFAULT_CATEGORIES } from '../shared/constants.js';
import { formatDuration, formatDate, todayKey, parseDate, getDateRange } from '../shared/utils.js';

// ─── State ─────────────────────────────────────────────────────────

let currentRange = 'daily'; // daily | weekly | monthly
let currentDate = new Date(); // anchor date
let chartInstances = {};

const categoryMap = {};
for (const cat of DEFAULT_CATEGORIES) {
  categoryMap[cat.id] = cat;
}

// ─── HTML escaping helper (prevents XSS + fixes rendering of special chars) ──

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupDateControls();
  setupViewTabs();
  setupExport();
  loadData();
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
  document.getElementById('prev-period').addEventListener('click', () => {
    shiftDate(-1);
  });

  document.getElementById('next-period').addEventListener('click', () => {
    shiftDate(1);
  });
}

function shiftDate(direction) {
  switch (currentRange) {
    case 'daily':
      currentDate.setDate(currentDate.getDate() + direction);
      break;
    case 'weekly':
      currentDate.setDate(currentDate.getDate() + direction * 7);
      break;
    case 'monthly':
      currentDate.setMonth(currentDate.getMonth() + direction);
      break;
  }
  loadData();
}

function getDateRangeForView() {
  const anchor = new Date(currentDate);
  let start, end;

  switch (currentRange) {
    case 'daily':
      start = end = formatDate(anchor);
      break;
    case 'weekly': {
      const dayOfWeek = anchor.getDay();
      const weekStart = new Date(anchor);
      weekStart.setDate(anchor.getDate() - dayOfWeek);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekStart.getDate() + 6);
      start = formatDate(weekStart);
      end = formatDate(weekEnd);
      break;
    }
    case 'monthly': {
      const monthStart = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      const monthEnd = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
      start = formatDate(monthStart);
      end = formatDate(monthEnd);
      break;
    }
  }

  return { start, end };
}

function updateDateLabel() {
  const label = document.getElementById('date-label');
  const today = todayKey();
  const { start, end } = getDateRangeForView();

  switch (currentRange) {
    case 'daily':
      label.textContent = start === today ? 'Today' : start;
      break;
    case 'weekly':
      label.textContent = `${start} to ${end}`;
      break;
    case 'monthly': {
      const d = new Date(currentDate);
      label.textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      break;
    }
  }
}

// ─── View Tabs ─────────────────────────────────────────────────────

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
      chrome.runtime.sendMessage({ type: MSG.GET_AGGREGATES, data: { startDate: start, endDate: end } }),
      chrome.runtime.sendMessage({ type: MSG.GET_SESSIONS, data: { startDate: start, endDate: end } }),
    ]);

    renderOverview(aggregates || [], sessions || []);
    renderDomains(sessions || []);
    renderYouTube(aggregates || [], sessions || []);
    renderCategories(aggregates || []);
  } catch (err) {
    console.error('[Track Daily] Error loading data:', err);
  }
}

// ─── Overview Rendering ────────────────────────────────────────────

function renderOverview(aggregates, sessions) {
  // Summary cards
  const totalTime = aggregates.reduce((sum, a) => sum + (a.totalTime || 0), 0);
  const totalSessions = aggregates.reduce((sum, a) => sum + (a.sessionCount || 0), 0);

  document.getElementById('summary-total').textContent = formatDuration(totalTime);
  document.getElementById('summary-sessions').textContent = totalSessions;

  // Top category
  const catTotals = {};
  for (const agg of aggregates) {
    for (const [catId, time] of Object.entries(agg.categoryBreakdown || {})) {
      catTotals[catId] = (catTotals[catId] || 0) + time;
    }
  }
  const topCat = Object.entries(catTotals).sort(([, a], [, b]) => b - a)[0];
  document.getElementById('summary-top-cat').textContent = topCat
    ? (categoryMap[topCat[0]]?.name || topCat[0])
    : '-';

  // Top domain
  const domTotals = {};
  for (const agg of aggregates) {
    for (const [domain, time] of Object.entries(agg.domainBreakdown || {})) {
      domTotals[domain] = (domTotals[domain] || 0) + time;
    }
  }
  const topDom = Object.entries(domTotals).sort(([, a], [, b]) => b - a)[0];
  document.getElementById('summary-top-domain').textContent = topDom ? topDom[0] : '-';

  // Time trend chart
  renderTimeTrendChart(aggregates);

  // Category doughnut
  renderCategoryDoughnut(catTotals);

  // Hourly heatmap
  renderHourlyHeatmap(sessions);
}

// ─── Charts ────────────────────────────────────────────────────────

function renderTimeTrendChart(aggregates) {
  const canvas = document.getElementById('time-trend-chart');
  if (chartInstances.timeTrend) chartInstances.timeTrend.destroy();

  if (typeof Chart === 'undefined') {
    // Chart.js not loaded yet
    canvas.parentElement.innerHTML = '<h3>Time Trend</h3><p class="empty-state">Chart.js not loaded</p>';
    return;
  }

  const { start, end } = getDateRangeForView();
  const dates = getDateRange(start, end);
  const aggMap = {};
  for (const a of aggregates) aggMap[a.date] = a;

  const labels = dates.map((d) => {
    const date = parseDate(d);
    return currentRange === 'daily'
      ? `${date.getHours?.() || 0}:00`
      : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  });

  const data = dates.map((d) => {
    const agg = aggMap[d];
    return agg ? Math.round(agg.totalTime / 60000) : 0; // minutes
  });

  chartInstances.timeTrend = new Chart(canvas, {
    type: currentRange === 'daily' ? 'bar' : 'line',
    data: {
      labels,
      datasets: [{
        label: 'Minutes',
        data,
        backgroundColor: 'rgba(102, 126, 234, 0.6)',
        borderColor: '#667eea',
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
        tooltip: {
          callbacks: {
            label: (ctx) => formatDuration(ctx.raw * 60000),
          },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#666', font: { size: 10 } },
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: {
            color: '#666',
            font: { size: 10 },
            callback: (v) => `${v}m`,
          },
        },
      },
    },
  });
}

function renderCategoryDoughnut(catTotals) {
  const canvas = document.getElementById('category-doughnut');
  if (chartInstances.categoryDoughnut) chartInstances.categoryDoughnut.destroy();

  if (typeof Chart === 'undefined') return;

  const entries = Object.entries(catTotals).filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a);

  if (entries.length === 0) {
    canvas.parentElement.querySelector('h3').insertAdjacentHTML(
      'afterend',
      '<p class="empty-state">No data for this period</p>'
    );
    return;
  }

  chartInstances.categoryDoughnut = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: entries.map(([id]) => categoryMap[id]?.name || id),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map(([id]) => categoryMap[id]?.color || '#9E9E9E'),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#b0b0b0', font: { size: 11 }, padding: 12 },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = ((ctx.raw / total) * 100).toFixed(1);
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
  const hourlyMinutes = new Array(24).fill(0);

  for (const session of sessions) {
    if (!session.startTime || !session.duration) continue;
    const hour = new Date(session.startTime).getHours();
    hourlyMinutes[hour] += session.duration / 60000;
  }

  const maxMinutes = Math.max(...hourlyMinutes, 1);

  container.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const intensity = hourlyMinutes[h] / maxMinutes;
    const cell = document.createElement('div');
    cell.className = 'heatmap-cell';

    const r = Math.round(102 + (intensity * 50));
    const g = Math.round(126 - (intensity * 60));
    const b = Math.round(234 - (intensity * 70));
    const alpha = 0.1 + intensity * 0.8;
    cell.style.background = `rgba(${r}, ${g}, ${b}, ${alpha})`;

    const label = h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`;
    cell.innerHTML = `<span class="tooltip">${label}: ${Math.round(hourlyMinutes[h])}m</span>`;
    container.appendChild(cell);
  }

  // Labels row
  let labelsRow = container.parentElement.querySelector('.heatmap-labels');
  if (!labelsRow) {
    labelsRow = document.createElement('div');
    labelsRow.className = 'heatmap-labels';
    container.after(labelsRow);
  }
  labelsRow.innerHTML = '';
  for (let h = 0; h < 24; h++) {
    const lbl = document.createElement('span');
    lbl.className = 'heatmap-label';
    lbl.textContent = h % 3 === 0 ? (h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`) : '';
    labelsRow.appendChild(lbl);
  }
}

// ─── Domains View ──────────────────────────────────────────────────

function renderDomains(sessions) {
  const tbody = document.getElementById('domains-tbody');
  const domainData = {};

  for (const session of sessions) {
    if (!session.domain || !session.duration) continue;
    if (!domainData[session.domain]) {
      domainData[session.domain] = { time: 0, sessions: 0, categoryId: session.categoryId };
    }
    domainData[session.domain].time += session.duration;
    domainData[session.domain].sessions++;
  }

  const sorted = Object.entries(domainData).sort(([, a], [, b]) => b.time - a.time);

  if (sorted.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No data for this period</td></tr>';
    return;
  }

  tbody.innerHTML = sorted
    .map(([domain, data], i) => {
      const cat = categoryMap[data.categoryId] || categoryMap.uncategorized;
      const safeDomain = escapeHtml(domain);
      const encodedDomain = encodeURIComponent(domain);
      return `
        <tr>
          <td>${i + 1}</td>
          <td>
            <div class="domain-cell">
              <img src="https://www.google.com/s2/favicons?domain=${encodedDomain}&sz=32" alt="" onerror="this.style.display='none'">
              ${safeDomain}
            </div>
          </td>
          <td>${formatDuration(data.time)}</td>
          <td>${data.sessions}</td>
          <td><span class="category-badge" style="background:${cat.color}22; color:${cat.color}">${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</span></td>
          <td><button class="reassign-btn" data-domain="${safeDomain}">Reassign</button></td>
        </tr>
      `;
    })
    .join('');

  // Reassign click handlers
  tbody.querySelectorAll('.reassign-btn').forEach((btn) => {
    btn.addEventListener('click', () => showReassignDialog(btn.dataset.domain));
  });
}

function showReassignDialog(domain) {
  const cats = DEFAULT_CATEGORIES.filter((c) => c.id !== 'uncategorized');
  const choice = prompt(
    `Assign "${domain}" to a category:\n\n` +
    cats.map((c, i) => `${i + 1}. ${c.icon} ${c.name}`).join('\n') +
    '\n\nEnter the number:'
  );

  if (choice) {
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < cats.length) {
      chrome.runtime.sendMessage({
        type: MSG.CATEGORIZE_DOMAIN,
        data: { domain, categoryId: cats[idx].id, title: '' },
      }).then(() => loadData());
    }
  }
}

// ─── YouTube View ──────────────────────────────────────────────────

function renderYouTube(aggregates, sessions) {
  let totalWatchTime = 0;
  let totalVideos = 0;
  const channelTotals = {};
  const ytCatTotals = {};
  const videoList = [];
  const seenVideos = new Set();

  // First pass: group sessions by videoId and pick the BEST meta
  // (highest completeness score — has title, channel, category)
  const videoMap = {};
  for (const session of sessions) {
    if (!session.meta || !session.meta.videoId) continue;

    const vid = session.meta.videoId;
    if (!videoMap[vid]) {
      videoMap[vid] = { meta: session.meta, totalDuration: 0, metaScore: 0 };
    }
    videoMap[vid].totalDuration += session.duration || 0;

    // Score this session's meta completeness
    const score =
      (session.meta.videoTitle ? 2 : 0) +
      (session.meta.channelName ? 2 : 0) +
      (session.meta.videoCategory ? 1 : 0) +
      (session.meta.videoDuration ? 1 : 0);

    if (score > videoMap[vid].metaScore) {
      videoMap[vid].meta = session.meta;
      videoMap[vid].metaScore = score;
    }
  }

  // Second pass: build totals from the best meta for each video
  for (const [vid, info] of Object.entries(videoMap)) {
    const meta = info.meta;
    const duration = info.totalDuration;

    totalWatchTime += duration;
    totalVideos++;
    videoList.push({
      title: meta.videoTitle || 'Unknown',
      channel: meta.channelName || 'Unknown',
      videoDuration: meta.videoDuration || 0,
      watchTime: duration,
      category: meta.videoCategory || 'Unknown',
      videoId: vid,
    });

    const channel = meta.channelName || 'Unknown';
    channelTotals[channel] = (channelTotals[channel] || 0) + duration;

    const ytCat = meta.videoCategory || 'Unknown';
    ytCatTotals[ytCat] = (ytCatTotals[ytCat] || 0) + duration;
  }

  // Fallback: also check aggregates for data (in case sessions were pruned)
  if (totalVideos === 0) {
    for (const agg of aggregates) {
      if (agg.youtubeStats) {
        totalWatchTime += agg.youtubeStats.totalWatchTime || 0;
        totalVideos += agg.youtubeStats.videosWatched || 0;
        for (const ch of agg.youtubeStats.topChannels || []) {
          channelTotals[ch.name] = (channelTotals[ch.name] || 0) + ch.time;
        }
        for (const [cat, time] of Object.entries(agg.youtubeStats.categoryBreakdown || {})) {
          ytCatTotals[cat] = (ytCatTotals[cat] || 0) + time;
        }
      }
    }
  }

  document.getElementById('yt-watch-time').textContent = formatDuration(totalWatchTime);
  document.getElementById('yt-video-count').textContent = totalVideos;

  // Channels chart
  renderYTChannelsChart(channelTotals);

  // Categories chart
  renderYTCategoriesChart(ytCatTotals);

  // Videos table
  const tbody = document.getElementById('yt-videos-tbody');
  if (videoList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No YouTube data</td></tr>';
  } else {
    tbody.innerHTML = videoList
      .sort((a, b) => b.watchTime - a.watchTime)
      .slice(0, 50)
      .map((v) => `
        <tr>
          <td>${escapeHtml(v.title)}</td>
          <td>${escapeHtml(v.channel)}</td>
          <td>${v.videoDuration ? formatDuration(v.videoDuration * 1000) : '-'}</td>
          <td>${formatDuration(v.watchTime)}</td>
          <td>${escapeHtml(v.category)}</td>
        </tr>
      `)
      .join('');
  }
}

function renderYTChannelsChart(channelTotals) {
  const canvas = document.getElementById('yt-channels-chart');
  if (chartInstances.ytChannels) chartInstances.ytChannels.destroy();
  if (typeof Chart === 'undefined') return;

  const entries = Object.entries(channelTotals).sort(([, a], [, b]) => b - a).slice(0, 8);

  if (entries.length === 0) return;

  chartInstances.ytChannels = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: entries.map(([name]) => name.length > 20 ? name.slice(0, 20) + '...' : name),
      datasets: [{
        data: entries.map(([, time]) => Math.round(time / 60000)),
        backgroundColor: 'rgba(255, 0, 0, 0.6)',
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (ctx) => formatDuration(ctx.raw * 60000) },
        },
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#666', callback: (v) => `${v}m` },
        },
        y: {
          grid: { display: false },
          ticks: { color: '#b0b0b0', font: { size: 11 } },
        },
      },
    },
  });
}

function renderYTCategoriesChart(ytCatTotals) {
  const canvas = document.getElementById('yt-categories-chart');
  if (chartInstances.ytCategories) chartInstances.ytCategories.destroy();
  if (typeof Chart === 'undefined') return;

  const entries = Object.entries(ytCatTotals).filter(([, v]) => v > 0);
  if (entries.length === 0) return;

  const colors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#E7E9ED', '#7BC225'];

  chartInstances.ytCategories = new Chart(canvas, {
    type: 'pie',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{
        data: entries.map(([, v]) => v),
        backgroundColor: entries.map((_, i) => colors[i % colors.length]),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: '#b0b0b0', font: { size: 11 } },
        },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${formatDuration(ctx.raw)}`,
          },
        },
      },
    },
  });
}

// ─── Categories View ───────────────────────────────────────────────

function renderCategories(aggregates) {
  const container = document.getElementById('category-breakdown');
  const catTotals = {};

  for (const agg of aggregates) {
    for (const [catId, time] of Object.entries(agg.categoryBreakdown || {})) {
      catTotals[catId] = (catTotals[catId] || 0) + time;
    }
  }

  const totalTime = Object.values(catTotals).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(catTotals).sort(([, a], [, b]) => b - a);

  if (sorted.length === 0) {
    container.innerHTML = '<div class="empty-state"><h3>No data</h3><p>Browse some websites and check back!</p></div>';
    return;
  }

  container.innerHTML = sorted
    .map(([catId, time]) => {
      const cat = categoryMap[catId] || categoryMap.uncategorized;
      const pct = ((time / totalTime) * 100).toFixed(1);
      return `
        <div class="category-row">
          <span class="category-color" style="background: ${cat.color}"></span>
          <span class="category-name">${escapeHtml(cat.icon)} ${escapeHtml(cat.name)}</span>
          <div class="category-bar-container">
            <div class="category-bar-fill" style="width: ${pct}%; background: ${cat.color}">${pct > 8 ? formatDuration(time) : ''}</div>
          </div>
          <span class="category-time">${formatDuration(time)}</span>
          <span class="category-percent">${pct}%</span>
        </div>
      `;
    })
    .join('');
}

// ─── Export ─────────────────────────────────────────────────────────

function setupExport() {
  document.getElementById('btn-export').addEventListener('click', async () => {
    const { start, end } = getDateRangeForView();
    try {
      const sessions = await chrome.runtime.sendMessage({
        type: MSG.GET_SESSIONS,
        data: { startDate: start, endDate: end },
      });

      if (!sessions || sessions.length === 0) {
        alert('No data to export for this period.');
        return;
      }

      // Build CSV
      const headers = ['Date', 'Domain', 'Title', 'Category', 'Start Time', 'End Time', 'Duration (min)', 'URL'];
      const rows = sessions.map((s) => [
        s.date,
        s.domain,
        `"${(s.title || '').replace(/"/g, '""')}"`,
        categoryMap[s.categoryId]?.name || s.categoryId,
        new Date(s.startTime).toISOString(),
        s.endTime ? new Date(s.endTime).toISOString() : '',
        (s.duration / 60000).toFixed(1),
        s.url,
      ]);

      const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `track-daily-${start}-to-${end}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Track Daily] Export error:', err);
      alert('Export failed. Check console for details.');
    }
  });
}
