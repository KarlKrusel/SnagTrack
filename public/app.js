/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

// ─── WebSocket connection ────────────────────────────────────────────────────
let ws;
let wsReconnectTimer;
let _session = null;
let _chartPreviewLoading = false;
let _batchPrepLoading = false;

function connect() {
  ws = new WebSocket(`ws://${location.host}`);

  ws.addEventListener('open', () => {
    clearTimeout(wsReconnectTimer);
    setStatus('ready', 'Connected');
    ws.send(JSON.stringify({ type: 'detect_browsers' }));
  });

  ws.addEventListener('close', () => {
    setStatus('error', 'Disconnected');
    wsReconnectTimer = setTimeout(connect, 2000);
  });

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleMessage(msg);
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ─── Message handler ─────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'config':
      applyConfig(msg.config);
      break;

    case 'status':
      setStatus(msg.status, msg.message);
      break;

    case 'log':
      appendLog(msg.entry);
      break;

    case 'log_history':
      for (const e of msg.entries) appendLog(e, false);
      scrollLogToBottom();
      break;

    case 'logs_cleared':
      document.getElementById('log-container').innerHTML = '';
      break;

    case 'browsers':
      renderBrowserBadges(msg.browsers);
      break;

    case 'session_status':
      applySessionStatus(msg.session);
      break;

    case 'session_setup':
      if (msg.message) toast(msg.message, 'info', 6000);
      switchPanel('settings');
      break;

    case 'session_saved':
      applySessionStatus(msg.session);
      toast('Session saved', 'success');
      break;

    case 'session_closed':
      applySessionStatus({ ..._session, browserOpen: false, browserPurpose: null });
      toast('Session browser closed', 'info');
      break;

    case 'batch_start':
      onBatchStart(msg);
      break;

    case 'batch_done':
      onBatchDone(msg);
      break;

    case 'batch_error':
      toast(msg.error, 'error');
      setRunning(false);
      break;

    case 'track_start':
      onTrackStart(msg);
      break;

    case 'track_step':
      onTrackStep(msg);
      break;

    case 'track_done':
      onTrackResult(msg, true);
      break;

    case 'track_fail':
      onTrackResult(msg, false);
      break;

    case 'chart_progress':
      onChartProgress(msg);
      break;

    case 'chart_preview':
      onChartPreview(msg);
      break;

    case 'folder_picked':
      if (msg.path) {
        const id = msg.target === 'profileDir' ? 'cfg-profile-dir' : 'cfg-download-dir';
        const el = document.getElementById(id);
        if (el) el.value = msg.path;
        send({ type: 'save_config', config: collectConfig() });
        toast('Folder set: ' + msg.path, 'success', 4000);
      }
      break;

    case 'error':
      if (_chartPreviewLoading) hideChartProgress();
      if (_batchPrepLoading) {
        _batchPrepLoading = false;
        setRunning(false);
      }
      toast(msg.message, 'error');
      break;
  }
}

// ─── Status management ───────────────────────────────────────────────────────
function setStatus(status, text) {
  const pill = document.getElementById('status-pill');
  const txt  = document.getElementById('status-text');
  pill.className = `status-pill ${status}`;
  txt.textContent = text || status;
}

function formatCompactTarget(value) {
  if (!value) return 'Chart';
  try {
    const url = new URL(String(value));
    return `${url.hostname.replace(/^www\./, '')}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return String(value);
  }
}

function setProgressVisual(fillId, pctId, percent, options = {}) {
  const fill = document.getElementById(fillId);
  const pctEl = document.getElementById(pctId);
  const indeterminate = !!options.indeterminate || percent == null;

  fill.classList.toggle('indeterminate', indeterminate);
  if (indeterminate) {
    fill.style.width = '34%';
    pctEl.textContent = options.pctText || '...';
    return;
  }

  const safePct = Math.max(0, Math.min(100, Math.round(percent)));
  fill.style.width = safePct + '%';
  pctEl.textContent = options.pctText || (safePct + '%');
}

function setChartUiLoading(loading) {
  const loadBtn = document.getElementById('btn-load-chart');
  const queueBtn = document.getElementById('btn-queue-chart');
  const copyBtn = document.getElementById('btn-copy-chart');

  loadBtn.disabled = loading;
  if (queueBtn) queueBtn.disabled = loading || _chartTracks.length === 0;
  if (copyBtn) copyBtn.disabled = loading || _chartTracks.length === 0;
}

function hideChartProgress() {
  document.getElementById('chart-progress-wrap').style.display = 'none';
  document.getElementById('chart-progress-label').textContent = 'Loading chart...';
  document.getElementById('chart-progress-target').textContent = 'Chart';
  document.getElementById('chart-progress-found').textContent = '0 found';
  setProgressVisual('chart-progress-fill', 'chart-progress-pct', null, { indeterminate: true });
  _chartPreviewLoading = false;
  setChartUiLoading(false);
}

function onChartProgress(progress) {
  if (progress.purpose === 'preview') {
    const wrap = document.getElementById('chart-progress-wrap');
    wrap.style.display = '';
    document.getElementById('chart-progress-label').textContent = progress.message || 'Loading chart...';
    document.getElementById('chart-progress-target').textContent = formatCompactTarget(progress.url);
    document.getElementById('chart-progress-found').textContent = `${progress.found || 0} found`;
    setProgressVisual('chart-progress-fill', 'chart-progress-pct', progress.percent, {
      indeterminate: progress.indeterminate,
      pctText: progress.indeterminate ? '...' : undefined,
    });
    _chartPreviewLoading = progress.active !== false;
    setChartUiLoading(true);
    if (progress.active === false && progress.error) {
      setChartUiLoading(false);
    }
    return;
  }

  if (progress.purpose === 'batch') {
    _batchPrepLoading = progress.active !== false;
    setRunning(true);
    setStatus('running', progress.message || 'Preparing chart...');
    document.getElementById('progress-wrap').style.display = '';
    document.getElementById('progress-label').textContent = progress.message || 'Preparing chart...';
    document.getElementById('current-track-id').textContent = formatCompactTarget(progress.url);
    document.getElementById('current-track-step').textContent = progress.message || 'Preparing chart...';
    setProgressVisual('progress-fill', 'progress-pct', progress.percent, {
      indeterminate: progress.indeterminate,
      pctText: progress.indeterminate ? '...' : undefined,
    });

    if (typeof progress.total === 'number' && progress.total > 0) {
      document.getElementById('stat-total').textContent = String(progress.total);
    }
    if (typeof progress.found === 'number' && progress.found >= 0) {
      document.getElementById('stat-done').textContent = String(progress.found);
    }
    document.getElementById('stat-ok').textContent = '0';
    document.getElementById('stat-fail').textContent = '0';
    switchPanel('downloads');
  }
}

// ─── Running state ───────────────────────────────────────────────────────────
function setRunning(running) {
  document.getElementById('btn-start').disabled  = running;
  document.getElementById('btn-cancel').disabled = !running;
  if (!running) {
    setStatus('ready', 'Idle');
    document.getElementById('progress-wrap').style.display = 'none';
    setProgressVisual('progress-fill', 'progress-pct', 0);
    _batchPrepLoading = false;
    document.getElementById('current-track-id').textContent   = '—';
    document.getElementById('current-track-step').textContent = '—';
  }
}

// ─── Batch events ────────────────────────────────────────────────────────────
let _batchTotal = 0;
let _batchDone  = 0;
let _queueItems = {};

function formatTrackLabel(value) {
  if (value && typeof value === 'object') {
    if (value.url) {
      return value.url.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/');
    }
    if (value.chart) return value.chart;
  }
  return String(value);
}

function onBatchStart({ total, ids }) {
  _batchTotal = total;
  _batchDone  = 0;
  _queueItems = {};
  _batchPrepLoading = false;

  setRunning(true);
  setStatus('running', `Downloading 0 / ${total}`);

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-done').textContent  = '0';
  document.getElementById('stat-ok').textContent    = '0';
  document.getElementById('stat-fail').textContent  = '0';
  document.getElementById('progress-wrap').style.display = '';
  updateProgress(0, total);

  // Pre-populate queue list
  const list = document.getElementById('queue-list');
  const empty = list.querySelector('.empty-state');
  if (empty) list.innerHTML = '';
  list.appendChild(createQueueBatchMarker(total));
  for (const rawId of ids) {
    const id = formatTrackLabel(rawId);
    const item = createQueueItem(id, '⏳', '', 'pending');
    list.appendChild(item);
    _queueItems[id] = item;
  }

  switchPanel('queue');
}

function onBatchDone({ total, ok, fail, failed }) {
  setRunning(false);
  updateProgress(total, total);
  setStatus('ready', `Done: ${ok} ok, ${fail} failed`);

  if (fail === 0) toast(`All ${ok} tracks downloaded!`, 'success');
  else           toast(`Done: ${ok} ok, ${fail} failed`, fail > 0 ? 'error' : 'success');

  if (failed.length > 0) {
    // Show failed IDs back in input
    document.getElementById('input-links').value = failed.join('\n');
    switchPanel('downloads');
  }
}

function onTrackStart({ id, index, total }) {
  _batchDone = index;
  updateProgress(index, total);
  setStatus('running', `Track ${index + 1} / ${total}`);
  document.getElementById('current-track-id').textContent = id;
  document.getElementById('current-track-step').textContent = 'Starting...';

  const item = _queueItems[id];
  if (item) {
    item.className = 'queue-item current';
    item.querySelector('.qi-icon').textContent = '🔄';
    item.querySelector('.qi-step').textContent = 'Starting...';
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function onTrackStep({ id, step, message }) {
  document.getElementById('current-track-step').textContent = message || step;

  const item = _queueItems[id];
  if (item) item.querySelector('.qi-step').textContent = message || step;
}

function onTrackResult({ id, index, total, ok: batchOk, fail, file, error }, succeeded) {
  _batchDone = index + 1;
  updateProgress(_batchDone, total);

  document.getElementById('stat-done').textContent = _batchDone;
  document.getElementById('stat-ok').textContent   = batchOk;
  document.getElementById('stat-fail').textContent = fail;

  const item = _queueItems[id];
  if (item) {
    item.className = `queue-item ${succeeded ? 'ok' : 'fail'}`;
    item.querySelector('.qi-icon').textContent = succeeded ? '✅' : '❌';
    item.querySelector('.qi-step').textContent = succeeded ? 'Done' : (error || 'Failed');
    if (file) item.querySelector('.qi-file').textContent = file;
  }
}

function updateProgress(done, total) {
  const pct  = total > 0 ? Math.round((done / total) * 100) : 0;
  const lbl  = document.getElementById('progress-label');
  lbl.textContent  = `${done} / ${total} tracks`;
  setProgressVisual('progress-fill', 'progress-pct', pct);
}

function createQueueItem(id, icon, step, cls) {
  const el = document.createElement('div');
  el.className = `queue-item ${cls || ''}`;
  el.innerHTML = `
    <span class="qi-icon">${icon}</span>
    <span class="qi-id mono">${id}</span>
    <span class="qi-step">${step}</span>
    <span class="qi-file"></span>
  `;
  return el;
}

function createQueueBatchMarker(total) {
  const el = document.createElement('div');
  const now = new Date();
  el.className = 'queue-batch-marker';
  el.innerHTML = `
    <span class="queue-batch-title">Batch ${now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    <span class="queue-batch-total">${total} tracks</span>
  `;
  return el;
}

// ─── Logs ─────────────────────────────────────────────────────────────────────
let _activeLevel  = 'ALL';
let _searchFilter = '';
const MAX_LOG_DOM = 1000;

function appendLog(entry, scroll = true) {
  const container = document.getElementById('log-container');
  const autoscroll = document.getElementById('log-autoscroll').checked;

  // Limit DOM size
  while (container.children.length >= MAX_LOG_DOM) {
    container.removeChild(container.firstChild);
  }

  const div = document.createElement('div');
  div.className = 'log-entry';
  div.dataset.level = entry.level;
  div.dataset.msg   = entry.message.toLowerCase();

  div.innerHTML = `
    <span class="log-time">${entry.date ? entry.date + ' ' : ''}${entry.time}</span>
    <span class="log-level">${entry.level}</span>
    <span class="log-msg">${escapeHtml(entry.message)}</span>
  `;

  applyLogFilter(div);
  container.appendChild(div);

  if (scroll && autoscroll) scrollLogToBottom();
}

function applyLogFilter(el) {
  const level  = el.dataset.level;
  const msgLow = el.dataset.msg;
  const levelOk = _activeLevel === 'ALL' || level === _activeLevel;
  const searchOk = !_searchFilter || msgLow.includes(_searchFilter);
  el.classList.toggle('hidden', !(levelOk && searchOk));
}

function reapplyAllFilters() {
  const container = document.getElementById('log-container');
  for (const child of container.children) applyLogFilter(child);
}

function scrollLogToBottom() {
  const c = document.getElementById('log-container');
  c.scrollTop = c.scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Config ───────────────────────────────────────────────────────────────────
let _cfg = {};

function applyConfig(cfg) {
  _cfg = cfg;

  document.getElementById('cfg-email').value        = cfg.email       || '';
  document.getElementById('cfg-name').value         = cfg.name        || '';
  document.getElementById('cfg-download-dir').value = cfg.downloadDir || '';
  document.getElementById('cfg-profile-dir').value  = cfg.profileDir  || '';
  document.getElementById('cfg-download-mode').value = cfg.downloadMode || 'hybrid';
  document.getElementById('cfg-browser-engine').value = cfg.browserEngine || 'auto';
  document.getElementById('cfg-headless-downloads').value = String(!!cfg.headlessDownloads);
  document.getElementById('cfg-cover-art').value = String(cfg.coverArt !== false);

  const d = cfg.delays || {};
  document.getElementById('delay-pageLoad').value       = d.pageLoad       ?? 1200;
  document.getElementById('delay-afterGateOpen').value  = d.afterGateOpen  ?? 1000;
  document.getElementById('delay-afterEmailStep').value = d.afterEmailStep ?? 900;
  document.getElementById('delay-afterScPopup').value   = d.afterScPopup   ?? 35000;
  document.getElementById('delay-scPopupTimeout').value = d.scPopupTimeout ?? 60000;
  document.getElementById('delay-spPopupTimeout').value = d.spPopupTimeout ?? 45000;
  document.getElementById('delay-betweenTracks').value  = d.betweenTracks  ?? 2000;

  // Update sidebar meta
  document.getElementById('meta-mode').textContent = `${cfg.downloadMode || 'hybrid'} / ${cfg.browserEngine || 'auto'}`;
  const dir = (cfg.downloadDir || '').split(/[\\/]/).pop() || cfg.downloadDir || '—';
  const metaDir = document.getElementById('meta-dir');
  metaDir.textContent = dir.length > 20 ? dir.slice(0, 18) + '…' : dir;
  metaDir.title       = cfg.downloadDir || '';
}

function collectConfig() {
  return {
    email:       document.getElementById('cfg-email').value.trim(),
    name:        document.getElementById('cfg-name').value.trim(),
    downloadDir: document.getElementById('cfg-download-dir').value.trim(),
    profileDir:  document.getElementById('cfg-profile-dir').value.trim(),
    downloadMode: document.getElementById('cfg-download-mode').value,
    browserEngine: document.getElementById('cfg-browser-engine').value,
    headlessDownloads: document.getElementById('cfg-headless-downloads').value === 'true',
    coverArt: document.getElementById('cfg-cover-art').value === 'true',
    delays: {
      pageLoad:       +document.getElementById('delay-pageLoad').value,
      afterGateOpen:  +document.getElementById('delay-afterGateOpen').value,
      afterEmailStep: +document.getElementById('delay-afterEmailStep').value,
      afterScPopup:   +document.getElementById('delay-afterScPopup').value,
      scPopupTimeout: +document.getElementById('delay-scPopupTimeout').value,
      spPopupTimeout: +document.getElementById('delay-spPopupTimeout').value,
      betweenTracks:  +document.getElementById('delay-betweenTracks').value,
    },
  };
}

function applySessionStatus(session) {
  _session = session || {};

  const statusEl = document.getElementById('session-status-text');
  const savedEl = document.getElementById('session-saved-at');
  const openBtn = document.getElementById('btn-open-session-setup');
  const saveBtn = document.getElementById('btn-save-session');
  const closeBtn = document.getElementById('btn-close-session-browser');

  const browserOpen = !!_session.browserOpen;
  const profileExists = !!_session.profileExists;
  const sessionExists = !!_session.sessionExists;

  if (browserOpen) {
    statusEl.textContent = `Browser open (${_session.browserPurpose || 'session'}) — log in, then click Save Session.`;
  } else if (sessionExists || profileExists) {
    statusEl.textContent = 'Saved browser profile found. Social gates can reuse this session.';
  } else {
    statusEl.textContent = 'No saved social-login session yet.';
  }

  savedEl.textContent = _session.sessionSavedAt ? new Date(_session.sessionSavedAt).toLocaleString() : 'Never';

  openBtn.textContent = browserOpen ? 'Browser Open' : 'Open Login Browser';
  openBtn.disabled = browserOpen;
  saveBtn.disabled = !browserOpen;
  closeBtn.disabled = !browserOpen;
}

// ─── Browser detection ────────────────────────────────────────────────────────
function renderBrowserBadges(browsers) {
  const grid = document.getElementById('browser-grid');
  const ICONS = {
    chromium: '⚡', chrome: '🟡', msedge: '🔵',
    firefox:  '🦊', webkit: '🧭',
  };
  grid.innerHTML = '';
  for (const [name, available] of Object.entries(browsers)) {
    const div = document.createElement('div');
    div.className = `browser-badge ${available ? 'available' : 'unavailable'}`;
    div.innerHTML = `
      <span style="font-size:20px">${ICONS[name] || '🌐'}</span>
      <span class="bb-name">${name}</span>
      <span class="bb-state">${available ? '✓ Available' : '✗ Not found'}</span>
    `;
    grid.appendChild(div);
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(() => el.remove(), 350);
  }, duration);
}

// ─── Navigation ───────────────────────────────────────────────────────────────
function switchPanel(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`panel-${id}`)?.classList.add('active');
  document.querySelector(`[data-panel="${id}"]`)?.classList.add('active');
}

// ─── Event listeners ──────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => switchPanel(item.dataset.panel));
});

document.getElementById('btn-start').addEventListener('click', () => {
  const input = document.getElementById('input-links').value.trim();
  if (!input) { toast('No links entered', 'error'); return; }
  if (!_cfg.email) { toast('Configure your email in Settings first', 'error'); switchPanel('settings'); return; }
  send({ type: 'start_downloads', input });
});

document.getElementById('btn-cancel').addEventListener('click', () => {
  send({ type: 'cancel' });
});

document.getElementById('btn-clear-input').addEventListener('click', () => {
  document.getElementById('input-links').value = '';
});

document.getElementById('btn-open-folder').addEventListener('click', () => {
  send({ type: 'open_folder' });
});

document.getElementById('btn-browse-download-dir').addEventListener('click', () => {
  toast('Opening folder picker… (check behind this window if you don\'t see it)', 'info', 3000);
  send({ type: 'pick_folder', target: 'downloadDir' });
});

document.getElementById('btn-clear-queue').addEventListener('click', () => {
  document.getElementById('queue-list').innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📭</div>
      No downloads yet. Start from the Downloads tab.
    </div>`;
  _queueItems = {};
});

document.getElementById('btn-save-settings').addEventListener('click', () => {
  const cfg = collectConfig();
  send({ type: 'save_config', config: cfg });
  toast('Settings saved', 'success');
});

document.getElementById('btn-open-session-setup').addEventListener('click', () => {
  const cfg = collectConfig();
  send({ type: 'save_config', config: cfg });
  send({ type: 'open_session_setup' });
});

document.getElementById('btn-save-session').addEventListener('click', () => {
  send({ type: 'save_session' });
});

document.getElementById('btn-close-session-browser').addEventListener('click', () => {
  send({ type: 'close_session_browser' });
});

document.getElementById('btn-reset-delays').addEventListener('click', () => {
  const defaults = {
    pageLoad: 1200, afterGateOpen: 1000, afterEmailStep: 900,
    afterScPopup: 35000, scPopupTimeout: 60000, spPopupTimeout: 45000, betweenTracks: 2000,
  };
  for (const [k, v] of Object.entries(defaults)) {
    const el = document.getElementById(`delay-${k}`);
    if (el) el.value = v;
  }
  toast('Delays reset to defaults', 'info');
});

document.getElementById('btn-detect-browsers').addEventListener('click', () => {
  document.getElementById('browser-grid').innerHTML = '<div class="text-dim" style="font-size:12px">Detecting...</div>';
  send({ type: 'detect_browsers' });
});

// Log filter buttons
document.querySelectorAll('.log-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _activeLevel = btn.dataset.level;
    reapplyAllFilters();
  });
});

document.getElementById('log-search').addEventListener('input', (e) => {
  _searchFilter = e.target.value.toLowerCase().trim();
  reapplyAllFilters();
});

document.getElementById('btn-clear-logs').addEventListener('click', () => {
  send({ type: 'clear_logs' });
});

document.getElementById('btn-open-logs-folder').addEventListener('click', () => {
  send({ type: 'open_log_folder' });
});

// ─── Charts ───────────────────────────────────────────────────────────────────

const CHART_SHORTCUTS = [
  { label: '🔥 Free Downloads', url: 'https://hypeddit.com/charts/downloads' },
];

let _chartTracks = [];

function initChartShortcuts() {
  const container = document.getElementById('chart-shortcuts');
  container.innerHTML = '';
  for (const { label, url } of CHART_SHORTCUTS) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = label;
    btn.style.justifyContent = 'flex-start';
    btn.addEventListener('click', () => {
      document.getElementById('chart-url-input').value = url;
      loadChart(url);
    });
    container.appendChild(btn);
  }
}

function loadChart(url) {
  if (!url) { toast('Enter a chart URL', 'error'); return; }
  _chartTracks = [];
  _chartPreviewLoading = true;
  document.getElementById('chart-preview').style.display = 'none';
  document.getElementById('chart-progress-wrap').style.display = '';
  document.getElementById('chart-progress-label').textContent = 'Loading chart preview...';
  document.getElementById('chart-progress-target').textContent = formatCompactTarget(url);
  document.getElementById('chart-progress-found').textContent = '0 found';
  setProgressVisual('chart-progress-fill', 'chart-progress-pct', null, { indeterminate: true });
  setChartUiLoading(true);
  setStatus('running', 'Loading chart preview...');
  toast('Loading chart preview...', 'info', 2000);
  send({ type: 'preview_chart', url });
}

function onChartPreview({ url, tracks, error }) {
  const preview = document.getElementById('chart-preview');
  const count = document.getElementById('chart-preview-count');
  const list = document.getElementById('chart-preview-list');

  if (error) {
    hideChartProgress();
    setStatus('ready', 'Idle');
    preview.style.display = 'none';
    toast(`Chart preview failed: ${error}`, 'error', 5000);
    return;
  }

  _chartTracks = Array.isArray(tracks) ? tracks : [];
  count.textContent = String(_chartTracks.length);
  list.textContent = _chartTracks.map((track) => track.value).join('\n');
  hideChartProgress();
  setStatus('ready', 'Idle');
  preview.style.display = '';

  if (_chartTracks.length === 0) {
    toast('No tracks found on that chart page', 'error');
    return;
  }

  toast(`Loaded ${_chartTracks.length} chart tracks`, 'success');
  document.getElementById('chart-url-input').value = url || document.getElementById('chart-url-input').value;
}

document.getElementById('btn-load-chart').addEventListener('click', () => {
  const url = document.getElementById('chart-url-input').value.trim();
  loadChart(url);
});

document.getElementById('btn-queue-chart').addEventListener('click', () => {
  if (_chartTracks.length === 0) return;
  document.getElementById('input-links').value = _chartTracks.map((track) => track.value).join('\n');
  switchPanel('downloads');
  toast(`${_chartTracks.length} tracks loaded`, 'success');
});

document.getElementById('btn-copy-chart').addEventListener('click', () => {
  if (_chartTracks.length === 0) return;
  document.getElementById('input-links').value = _chartTracks.map((track) => track.value).join('\n');
  switchPanel('downloads');
});

// ─── Welcome modal (shown once per app open) ────────────────────────────────────
(function initWelcome() {
  const overlay = document.getElementById('welcome-overlay');
  if (!overlay) return;
  const hide = () => { overlay.style.display = 'none'; };
  document.getElementById('welcome-close')?.addEventListener('click', hide);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // Show once per browser-tab session (so a refresh won't nag, but each fresh open does)
  if (!sessionStorage.getItem('snagtrack_welcomed')) {
    overlay.style.display = 'flex';
    sessionStorage.setItem('snagtrack_welcomed', '1');
  }
})();

// ─── Boot ─────────────────────────────────────────────────────────────────────
applySessionStatus({});
connect();
initChartShortcuts();
setChartUiLoading(false);
