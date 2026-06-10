/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

const http           = require('http');
const https          = require('https');
const fs             = require('fs');
const path           = require('path');
const cheerio        = require('cheerio');
const logger         = require('./logger');
const config         = require('./config');
const browserManager = require('./browser-manager');
const directClient   = require('./direct-client');
const coverart       = require('./coverart');
const scResolver     = require('./sc-resolver');

// ─── State ──────────────────────────────────────────────────────────────────

let _context   = null;
let _cancelled = false;
let _running   = false;
let _contextPurpose = null;
let _sessionSeeded  = false;

// Callbacks for UI updates
let _onProgress = null; // fn(update)

function setProgressCallback(fn) { _onProgress = fn; }

function emit(update) {
  if (_onProgress) _onProgress(update);
}

function emitChartProgress(update) {
  emit({ type: 'chart_progress', ...update });
}

async function releaseWorkerPage(page) {
  if (!page) return;

  const livePages = _context?.pages?.().filter((p) => !p.isClosed()) || [];
  if (livePages.length <= 1) {
    await page.goto('about:blank').catch(() => {});
    return;
  }

  await page.close().catch(() => {});
}

// ─── Browser helpers ─────────────────────────────────────────────────────────

async function ensureBrowser(options = {}) {
  const purpose = options.purpose || 'download';

  if (purpose !== 'session' && browserManager.isManualLoginBrowserOpen()) {
    throw new Error('Close the login browser window before starting downloads');
  }

  if (_context) {
    if (purpose === 'session' && _contextPurpose !== 'session') {
      logger.info('Restarting browser in visible session mode...');
      await closeBrowser();
    } else {
      return _context;
    }
  }

  logger.info(`Starting browser (${purpose})...`);
  emit({ type: 'status', status: 'launching', message: purpose === 'session' ? 'Opening login browser...' : 'Starting browser...' });
  _context = await browserManager.launch({ purpose });
  _contextPurpose = purpose;
  await browserManager.hardenContext(_context);

  if (!_sessionSeeded) {
    await browserManager.loadSession(_context);
    _sessionSeeded = true;
  }

  logger.success('Browser ready');
  emit({ type: 'status', status: 'ready', message: purpose === 'session' ? 'Login browser ready' : 'Browser ready' });
  emit({ type: 'session_status', session: browserManager.getSessionStatus(), browserOpen: true, browserPurpose: _contextPurpose });
  return _context;
}

async function closeBrowser() {
  try { await _context?.close(); } catch {}
  _context = null;
  _contextPurpose = null;
  browserManager.closeManualLoginBrowser();
  emit({ type: 'session_status', session: browserManager.getSessionStatus(), browserOpen: false, browserPurpose: null });
}

// ─── Link / ID resolution ────────────────────────────────────────────────────
// Each entry is either:
//   string  → numeric track ID  (visit hypeddit.com/track/ID)
//   { url }  → full URL to navigate directly (artist/slug, any non-chart hypeddit URL)
//   { chart } → chart page to scrape for multiple track URLs

const CHART_PATTERNS = [
  /hypeddit\.com\/chart/i,
  /hypeddit\.com\/top/i,
  /hypeddit\.com\/genre/i,
  /hypeddit\.com\/feed/i,
  /hypeddit\.com\/music/i,
  /hypeddit\.com\/newreleases/i,
];

const HTTP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const CHART_ENDPOINTS = Object.freeze({
  'charts:downloads': '/top100tracks',
  'charts:streams': '/top100smartlinks',
  'newreleases:downloads': '/newreleasestracks',
  'newreleases:streams': '/newreleasessmartlinks',
});

function resolveIds(raw) {
  const result = [];
  for (const line of raw.split(/[\n,\r]+/).map(s => s.trim()).filter(Boolean)) {
    // Numeric ID only
    if (/^\d+$/.test(line)) {
      result.push(line); continue;
    }

    // Must be a URL from here on — normalise to https://
    let urlStr = line;
    if (!urlStr.startsWith('http')) urlStr = 'https://' + urlStr;

    // SoundCloud link → resolve to its Hypeddit gate during batch expansion
    if (scResolver.isSoundCloudUrl(urlStr)) {
      result.push({ sc: urlStr.split('?')[0] });
      continue;
    }

    if (!urlStr.includes('hypeddit.com')) {
      logger.warn(`Skipping non-Hypeddit URL: ${line}`);
      continue;
    }

    // /track/abc123 → extract current Hypeddit track code
    const trackIdMatch = urlStr.match(/hypeddit\.com\/track\/([a-z0-9]+)/i);
    if (trackIdMatch) { result.push(trackIdMatch[1]); continue; }

    // Chart / playlist page → scrape for multiple track URLs
    if (CHART_PATTERNS.some(p => p.test(urlStr))) {
      result.push({ chart: urlStr }); continue;
    }

    // Everything else (artist/slug, /link/, etc.) — navigate directly
    result.push({ url: urlStr });
  }
  return result;
}

function requestText(targetUrl, options = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ?? null;
    const headers = {
      'User-Agent': HTTP_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      ...(options.headers || {}),
    };

    if (body != null && headers['Content-Length'] == null) {
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const mod = urlObj.protocol === 'http:' ? http : https;
    const req = mod.request({
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || undefined,
      path: `${urlObj.pathname}${urlObj.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error('Too many redirects'));
            return;
          }

          const redirectedUrl = new URL(res.headers.location, urlObj).toString();
          const nextOptions = { ...options };
          if (status === 303 && method !== 'GET') {
            nextOptions.method = 'GET';
            nextOptions.body = null;
            const nextHeaders = { ...headers };
            delete nextHeaders['Content-Length'];
            delete nextHeaders['Content-Type'];
            nextOptions.headers = nextHeaders;
          }
          resolve(requestText(redirectedUrl, nextOptions, redirectCount + 1));
          return;
        }

        resolve({
          status,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          finalUrl: urlObj.toString(),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(options.timeoutMs || 20000, () => req.destroy(new Error('timeout')));
    if (body != null) req.write(body);
    req.end();
  });
}

function normalizeHypedditUrl(value) {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().replace(/&amp;/g, '&');
  if (!trimmed) return null;

  const absolute = trimmed.startsWith('http')
    ? trimmed
    : `https://hypeddit.com${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;

  if (!/^https?:\/\/(?:www\.)?hypeddit\.com\//i.test(absolute)) {
    return null;
  }

  return absolute.split('?')[0];
}

function pickTrackUrl(record) {
  if (!record || typeof record !== 'object') return null;

  const candidates = [
    record.directlink,
    record.buylink,
    record.destination_link,
    record.destinationLink,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeHypedditUrl(candidate);
    if (normalized) return normalized;
  }

  return record.uid ? `https://hypeddit.com/track/${record.uid}` : null;
}

function dedupeUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function chartItemNeedsInstream(item, descriptor) {
  const status = Number(item?.status || 0);
  if (descriptor.subtype === 'streams') {
    return Number(item?.chart_eligible || 0) !== 1 || status !== 0;
  }
  return Number(item?.scarcity_reached || 0) === 1 || status !== 0;
}

function extractChartUrlsFromResponse(data, descriptor) {
  const responseTracks = Array.isArray(data?.response) ? data.response : [];
  const instreamTracks = Array.isArray(data?.instream) ? data.instream : [];
  const urls = [];

  for (let i = 0; i < responseTracks.length; i++) {
    const item = responseTracks[i];
    const groupIndex = Math.floor(i / 10);
    const chosen = chartItemNeedsInstream(item, descriptor)
      ? (instreamTracks[groupIndex] || item)
      : item;
    const url = pickTrackUrl(chosen);
    if (url) urls.push(url);
  }

  return dedupeUrls(urls);
}

async function scrapeChartViaEndpoint(chartUrl, $, progress = {}) {
  const purpose = progress.purpose || 'preview';
  const chartScript = $('#charts');
  if (!chartScript.length) return null;

  const pageType = String(chartScript.attr('data-pagetype') || '').trim();
  const subtype = String(chartScript.attr('data-subtype') || '').trim();
  const endpoint = CHART_ENDPOINTS[`${pageType}:${subtype}`];
  if (!endpoint) return null;

  const genreType = String($('#genre-type').attr('value') || '').trim();
  const payload = new URLSearchParams({
    page: '1',
    type: genreType,
  }).toString();

  const endpointUrl = new URL(endpoint, chartUrl).toString();
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'fetch_endpoint',
    message: 'Loading chart list from Hypeddit...',
    percent: 42,
  });
  const response = await requestText(endpointUrl, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': chartUrl,
    },
    body: payload,
  });

  if (response.status !== 200) {
    throw new Error(`chart endpoint returned HTTP ${response.status}`);
  }

  let data;
  try {
    data = JSON.parse(response.body);
  } catch (e) {
    throw new Error(`chart endpoint returned invalid JSON: ${e.message}`);
  }

  const urls = extractChartUrlsFromResponse(data, { pageType, subtype });
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'endpoint_loaded',
    message: `Loaded ${urls.length} chart tracks`,
    percent: 88,
    found: urls.length,
    total: urls.length,
  });
  return urls;
}

function scrapeChartViaHtml($, progress = {}) {
  const purpose = progress.purpose || 'preview';
  const chartUrl = progress.url || '';
  const urls = [];

  $('#spotlight_list [data-directlink], #spotlight_list [data-buylink]').each((_, el) => {
    const url = pickTrackUrl(el.attribs || {});
    if (url) urls.push(url);
  });

  if (urls.length === 0) {
    $('a[href*="hypeddit.com/track/"], a[href^="/track/"]').each((_, el) => {
      const href = normalizeHypedditUrl(el.attribs?.href || '');
      if (href) urls.push(href);
    });
  }

  const deduped = dedupeUrls(urls);
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'html_parsed',
    message: `Found ${deduped.length} tracks in page markup`,
    percent: 82,
    found: deduped.length,
    total: deduped.length,
  });
  return deduped;
}

async function scrapeChartWithHttp(chartUrl, progress = {}) {
  const purpose = progress.purpose || 'preview';
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'fetch_page',
    message: 'Opening chart page...',
    percent: 14,
  });
  const response = await requestText(chartUrl, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (response.status !== 200) {
    throw new Error(`chart page returned HTTP ${response.status}`);
  }

  const $ = cheerio.load(response.body);
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'parse_page',
    message: 'Reading chart structure...',
    percent: 26,
  });
  const endpointUrls = await scrapeChartViaEndpoint(response.finalUrl || chartUrl, $, progress);
  if (Array.isArray(endpointUrls)) return endpointUrls;
  return scrapeChartViaHtml($, { ...progress, url: response.finalUrl || chartUrl });
}

async function scrapeChartWithBrowser(chartUrl, progress = {}) {
  const purpose = progress.purpose || 'preview';
  await ensureBrowser();
  const page = await _context.newPage();
  try {
    emitChartProgress({
      active: true,
      purpose,
      url: chartUrl,
      phase: 'browser_fallback',
      message: 'Using browser fallback to load more tracks...',
      percent: 18,
      indeterminate: true,
    });
    await page.goto(chartUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(1500);

    // Collect real Hypeddit track pages only (chart pages also have nav/footer/share URLs).
    const collect = () => page.evaluate(() => {
      const links = new Set();
      for (const a of document.querySelectorAll('a[href*="hypeddit.com"], a[href^="/"]')) {
        const href = (a.href || '').split('?')[0];
        if (/^https?:\/\/hypeddit\.com\/track\/[a-z0-9]+$/i.test(href)) links.add(href);
      }
      return [...links];
    });

    // Hypeddit charts lazy-load more tracks as you scroll, but ONLY react to a
    // real wheel event — JS window.scrollBy/scrollTo is ignored by the page. So
    // we dispatch genuine mouse-wheel scrolls (via Playwright) in small, slow
    // steps so each batch has time to load. Keep going until the count is stable.
    let found = await collect();
    emitChartProgress({
      active: true,
      purpose,
      url: chartUrl,
      phase: 'browser_scroll',
      message: `Scrolling chart... ${found.length} tracks found so far`,
      percent: 24,
      indeterminate: true,
      found: found.length,
    });
    let stable = 0;
    const MAX_SCROLLS = 90;
    await page.mouse.move(640, 400).catch(() => {});
    for (let i = 0; i < MAX_SCROLLS && stable < 5; i++) {
      const before = found.length;
      await page.mouse.wheel(0, 650).catch(() => {});       // real wheel event, slow step
      await page.waitForTimeout(850);                        // let the batch load
      found = await collect();
      if (found.length <= before) stable++; else stable = 0;
      if (found.length > before) {
        logger.debug(`Chart scroll ${i + 1}: ${found.length} tracks so far`);
        emitChartProgress({
          active: true,
          purpose,
          url: chartUrl,
          phase: 'browser_scroll',
          message: `Scrolling chart... ${found.length} tracks found so far`,
          percent: Math.min(95, 24 + Math.round(((i + 1) / MAX_SCROLLS) * 66)),
          indeterminate: true,
          found: found.length,
        });
      }
    }

    logger.info(`Chart scraped in browser: ${found.length} tracks found`);
    return found;
  } finally {
    await releaseWorkerPage(page);
  }
}

async function scrapeChart(chartUrl, options = {}) {
  const purpose = options.purpose || 'preview';
  logger.info(`Scraping chart: ${chartUrl}`);
  emit({ type: 'status', status: 'running', message: purpose === 'batch' ? 'Expanding chart links...' : 'Loading chart preview...' });
  emitChartProgress({
    active: true,
    purpose,
    url: chartUrl,
    phase: 'start',
    message: purpose === 'batch' ? 'Expanding chart links...' : 'Loading chart preview...',
    percent: 5,
  });

  try {
    const httpLinks = await scrapeChartWithHttp(chartUrl, { purpose, url: chartUrl });
    if (httpLinks.length > 0) {
      logger.info(`Chart scraped over HTTP: ${httpLinks.length} tracks found`);
      emitChartProgress({
        active: false,
        purpose,
        url: chartUrl,
        phase: 'done',
        message: `Loaded ${httpLinks.length} chart tracks`,
        percent: 100,
        found: httpLinks.length,
        total: httpLinks.length,
      });
      return httpLinks;
    }
    logger.warn(`HTTP chart scrape found no tracks for ${chartUrl} - falling back to browser`);
  } catch (e) {
    logger.warn(`HTTP chart scrape failed for ${chartUrl}: ${e.message} - falling back to browser`);
  }

  try {
    const browserLinks = await scrapeChartWithBrowser(chartUrl, { purpose, url: chartUrl });
    emitChartProgress({
      active: false,
      purpose,
      url: chartUrl,
      phase: 'done',
      message: `Loaded ${browserLinks.length} chart tracks`,
      percent: 100,
      found: browserLinks.length,
      total: browserLinks.length,
    });
    return browserLinks;
  } catch (e) {
    emitChartProgress({
      active: false,
      purpose,
      url: chartUrl,
      phase: 'error',
      message: `Chart load failed: ${e.message}`,
      error: e.message,
    });
    throw e;
  }
}

async function previewChart(chartUrl) {
  const items = await scrapeChart(chartUrl, { purpose: 'preview' });
  return items.map((item) => {
    if (typeof item === 'string' && /^\d+$/.test(item)) {
      return { id: item, type: 'track-id', value: item };
    }
    return {
      id: String(item).replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/'),
      type: 'url',
      value: item,
    };
  });
}

async function openSessionSetup() {
  if (_context) {
    await closeBrowser();
  }

  browserManager.openManualLoginBrowser([
    'https://hypeddit.com/',
    'https://soundcloud.com/signin',
    'https://accounts.spotify.com/en/login',
  ]);

  emit({
    type: 'session_status',
    session: browserManager.getSessionStatus(),
    browserOpen: true,
    browserPurpose: 'session',
  });

  return {
    ok: true,
    message: 'A regular Chrome login window is open. Log into Hypeddit, SoundCloud, and Spotify there, then close that window before starting downloads.',
  };
}

async function saveSessionState() {
  if (_context) {
    await browserManager.saveSession(_context);
  }
  const session = browserManager.getSessionStatus();
  emit({ type: 'session_status', session, browserOpen: !!_context, browserPurpose: _contextPurpose });
  return session;
}

async function waitForGateSignals(page, timeoutMs = 4000) {
  return page.waitForFunction(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };

    const startBtn = document.querySelector('#downloadProcess');
    const dlBtn = document.querySelector('#gateDownloadButton');
    const panels = document.querySelectorAll('.fangate-slider-content');
    return isVisible(startBtn) || isVisible(dlBtn) || panels.length > 0;
  }, { timeout: timeoutMs }).then(() => true).catch(() => false);
}

async function openGateIfNeeded(page, trackId, delayMs) {
  const gateState = await page.evaluate(() => {
    const btn = document.querySelector('#downloadProcess');
    if (!btn) return { found: false };
    const rect = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    return {
      found: true,
      text: (btn.textContent || '').trim(),
      cls: btn.className || '',
      visible: rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
    };
  }).catch(() => ({ found: false }));

  if (!gateState.found || !gateState.visible) return false;

  logger.info(`[${trackId}] Opening gate via #downloadProcess`);
  await page.locator('#downloadProcess').click({ timeout: 5000 }).catch(async (e) => {
    logger.warn(`[${trackId}] #downloadProcess click fallback: ${e.message}`);
    await page.evaluate(() => document.querySelector('#downloadProcess')?.click()).catch(() => {});
  });
  const gateOpened = await waitForGateSignals(page, Math.max(800, Math.min(3000, delayMs + 1200)));
  if (!gateOpened && delayMs > 0) {
    await page.waitForTimeout(Math.min(delayMs, 250));
  }
  return true;
}

async function triggerActivePanelPopup(page, selectors) {
  const popupPromise = page.waitForEvent('popup', { timeout: 6000 }).catch(() => null);

  const clickResult = await page.evaluate(({ selectors }) => {
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };

    const IGNORE = new Set(['fangate-slider-content', 'current-slide', 'move-left', 'zindex', 'upcomming-slide', 'upcoming-slide']);
    const panels = [...document.querySelectorAll('.fangate-slider-content')];
    const getStepType = (panel) => [...panel.classList].find((cls) => !IGNORE.has(cls)) || 'unknown';

    let active = panels.find((panel) => panel.classList.contains('current-slide') && !panel.classList.contains('move-left')) || null;
    let panelSource = 'current-slide';

    if (!active) {
      active = panels.find((panel) => {
        if (panel.classList.contains('move-left')) return false;
        return selectors.some((sel) => [...panel.querySelectorAll(sel)].some(isVisible));
      }) || null;
      if (active) panelSource = 'visible-pending';
    }
    if (!active) return { found: false, panelSource: 'none' };

    let btn = null;
    let matchedSelector = null;
    for (const sel of selectors) {
      btn = [...active.querySelectorAll(sel)].find(isVisible) || null;
      if (btn) {
        matchedSelector = sel;
        break;
      }
    }
    if (!btn) return { found: false, panelSource, stepType: getStepType(active) };

    const raw = btn.getAttribute('data-onclick');
    if (raw && !btn.getAttribute('onclick')) btn.setAttribute('onclick', raw);
    btn.click();
    return {
      found: true,
      panelSource,
      stepType: getStepType(active),
      selector: matchedSelector,
      text: (btn.textContent || '').trim(),
      cls: btn.className || '',
      rawApplied: !!raw,
    };
  }, { selectors }).catch((e) => ({ found: false, error: e.message }));

  const popup = await popupPromise;
  return { popup, clickResult };
}

async function closeExtraPages(keepPages = [], options = {}) {
  const keep = new Set(keepPages.filter(Boolean));
  const waitMs = options.waitMs ?? 0;

  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const pages = _context?.pages?.() || [];
  let closed = 0;
  for (const extraPage of pages) {
    if (keep.has(extraPage) || extraPage.isClosed()) continue;
    await extraPage.close().catch(() => {});
    closed++;
  }
  return closed;
}

async function waitForPopupCloseOrCallback(popup, trackId, provider, closeTimeout, callbackPatterns = []) {
  const callbackTimeout = Math.min(closeTimeout, 8000);

  const outcome = await Promise.race([
    popup.waitForEvent('close', { timeout: closeTimeout }).then(() => 'closed').catch(() => null),
    popup.waitForURL(
      (url) => callbackPatterns.some((pattern) => pattern.test(String(url))),
      { timeout: callbackTimeout },
    ).then(() => 'callback').catch(() => null),
  ]);

  if (outcome === 'callback' && !popup.isClosed()) {
    logger.info(`[${trackId}] [${provider}] Callback reached: ${popup.url()}`);
    await popup.waitForTimeout(250).catch(() => {});
    await popup.close().catch(() => {});
    return 'callback';
  }

  if (outcome === 'closed') {
    return 'closed';
  }

  await popup.waitForEvent('close', { timeout: Math.min(closeTimeout, 1500) }).catch(() => {});
  if (!popup.isClosed()) {
    logger.info(`[${trackId}] [${provider}] Closing popup after timeout at ${popup.url()}`);
    await popup.close().catch(() => {});
    return 'forced-close';
  }

  return 'closed';
}

// ─── Dynamic gate scraper ─────────────────────────────────────────────────────
// Inspects the CURRENT active panel and returns what actions are available.
// This is called fresh before every step so we always act on real DOM state.

async function scrapeActiveStep(page) {
  return page.evaluate(() => {
    const IGNORE = new Set(['fangate-slider-content','current-slide','move-left','zindex','upcomming-slide','upcoming-slide']);
    const isVisible = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const getStepType = (panel) => [...panel.classList].find(c => !IGNORE.has(c)) || 'unknown';
    const pickFirst = (root, selectors, visibleOnly = false) => {
      let fallback = null;
      for (const sel of selectors) {
        const nodes = [...root.querySelectorAll(sel)];
        if (!nodes.length) continue;
        const visible = nodes.find(isVisible);
        if (visible) return visible;
        if (!fallback) fallback = nodes[0];
      }
      return visibleOnly ? null : fallback;
    };
    const collectActions = (panel, visibleOnly = false) => {
      const emailEl = pickFirst(panel, ['#email_address', '#download_email_address', 'input[type="email"]'], visibleOnly);
      const nameEl = pickFirst(panel, ['#name', '#download_name', '#email_name'], visibleOnly);
      const submitBtn = pickFirst(panel, ['#email_to_downloads_next', '[id*="email"][id*="next"]', '[id*="download"][id*="next"]'], visibleOnly);
      const scBtn = pickFirst(panel, ['#login_to_sc', '.button-soundcloud-1', '[id*="sc_btn"]', '[id*="sc_connect"]', '[class*="soundcloud"]:not([class*="comment"])'], visibleOnly);
      const spBtn = pickFirst(panel, ['#login_to_sp', '.button-spotify-1', '[class*="spotify"]'], visibleOnly);
      const igBtns = [...panel.querySelectorAll('.button-instagram-1')].filter((btn) => !visibleOnly || isVisible(btn));
      const skipperIG = pickFirst(panel, ['#skipper_ig_channel', '#skipper_ig_next'], visibleOnly)
        || pickFirst(document, ['#skipper_ig_channel', '#skipper_ig_next'], visibleOnly);
      const jumpEmailLink = [...panel.querySelectorAll('a')].find((a) => {
        const onclick = a.getAttribute('onclick') || '';
        return onclick.includes('jumpGate') && onclick.includes("'email'") && (!visibleOnly || isVisible(a));
      }) || null;
      const scComment = pickFirst(panel, ['#sc_comment_text'], visibleOnly);
      const dlBtnInPanel = pickFirst(panel, ['#gateDownloadButton'], visibleOnly);

      return {
        hasEmail:      !!emailEl,
        emailSel:      emailEl?.id ? `#${emailEl.id}` : emailEl ? 'input[type="email"]' : null,
        emailVisible:  isVisible(emailEl),
        hasName:       !!nameEl,
        nameSel:       nameEl?.id ? `#${nameEl.id}` : nameEl?.name ? `[name="${nameEl.name}"]` : null,
        nameVisible:   isVisible(nameEl),
        hasSubmitBtn:  !!submitBtn,
        submitBtnId:   submitBtn?.id || null,
        submitVisible: isVisible(submitBtn),
        hasSC:         !!scBtn,
        scBtnId:       scBtn?.id || scBtn?.className?.split(' ')[0] || null,
        scVisible:     isVisible(scBtn),
        hasSP:         !!spBtn,
        spBtnId:       spBtn?.id || spBtn?.className?.split(' ')[0] || null,
        spVisible:     isVisible(spBtn),
        hasIG:         igBtns.length > 0,
        igCount:       igBtns.length,
        hasSkipperIG:  !!skipperIG,
        skipperIGId:   skipperIG?.id || null,
        hasJumpEmail:  !!jumpEmailLink,
        jumpEmailVisible: isVisible(jumpEmailLink),
        hasSCComment:  !!scComment,
        hasDLButton:   !!dlBtnInPanel,
        dlBtnClass:    dlBtnInPanel?.className || null,
      };
    };

    const allPanels = [...document.querySelectorAll('.fangate-slider-content')];

    // The active panel is current-slide without move-left
    const active = allPanels.find(p =>
      p.classList.contains('current-slide') && !p.classList.contains('move-left')
    );

    const panelSummary = allPanels.map(p => {
      const done    = p.classList.contains('move-left');
      const current = p.classList.contains('current-slide') && !done;
      const type    = [...p.classList].find(c => !IGNORE.has(c)) || '?';
      return `[${done ? 'DONE' : current ? 'ACTIVE' : 'pending'}:${type}]`;
    }).join(' ');

    if (!active) {
      const pendingPanels = allPanels.filter((panel) => !panel.classList.contains('move-left'));
      let fallbackPanel = null;
      let fallbackActions = null;

      for (const panel of pendingPanels) {
        const actions = collectActions(panel, true);
        if (actions.hasEmail || actions.hasSC || actions.hasSP || actions.hasIG || actions.hasJumpEmail || actions.hasSubmitBtn) {
          fallbackPanel = panel;
          fallbackActions = actions;
          break;
        }
        if (!fallbackPanel && actions.hasDLButton) {
          fallbackPanel = panel;
          fallbackActions = actions;
        }
      }

      if (fallbackPanel && fallbackActions) {
        return {
          done:        false,
          stepType:    getStepType(fallbackPanel),
          panelSource: 'visible-pending',
          panelSummary,
          panelHTML:   fallbackPanel.innerHTML.slice(0, 400).replace(/\s+/g, ' '),
          actions:     fallbackActions,
        };
      }

      const dlBtn = document.querySelector('#gateDownloadButton');
      return {
        done:        true,
        allDone:     allPanels.every(p => p.classList.contains('move-left')),
        panelSummary,
        dlButton:    dlBtn ? { found: true, cls: dlBtn.className, text: dlBtn.textContent.trim().slice(0,60) } : { found: false },
      };
    }

    const stepType = getStepType(active);

    return {
      done:        false,
      stepType,
      panelSource: 'current-slide',
      panelSummary,
      panelHTML:   active.innerHTML.slice(0, 400).replace(/\s+/g, ' '),
      actions:     collectActions(active),
    };
  }).catch(e => ({ error: e.message, done: false }));
}

// ─── Single track download (browser) ─────────────────────────────────────────
// trackRef: string (numeric ID) OR { url: 'https://hypeddit.com/artist/slug' }

async function downloadTrackBrowser(trackRef) {
  const cfg = config.get();
  const d   = cfg.delays;

  // Resolve to a URL and a display label
  let trackUrl, trackId;
  if (trackRef && typeof trackRef === 'object' && trackRef.url) {
    trackUrl = trackRef.url;
    // Label: last two path segments e.g. "wearekras/donna"
    const parts = trackUrl.replace(/\/$/, '').split('/').filter(Boolean);
    trackId = parts.slice(-2).join('/');
  } else {
    trackId  = String(trackRef);
    trackUrl = `https://hypeddit.com/track/${trackId}`;
  }

  let page;
  try {
    page = await _context.newPage();
  } catch (e) {
    // Browser died — relaunch
    logger.warn('Browser context lost — relaunching...');
    await closeBrowser();
    await ensureBrowser();
    page = await _context.newPage();
  }

  try {
    logger.info(`[${trackId}] ── START ── ${trackUrl}`);
    emit({ type: 'track_step', id: trackId, step: 'load', message: 'Loading page...' });

    // Use 'load' so Hypeddit's JS fully builds the gate DOM before we inspect it
    await page.goto(trackUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const gateSignalsReady = await waitForGateSignals(page, Math.max(1500, Math.min(5000, d.pageLoad + 1500)));
    logger.info(`[${trackId}] Page ready — gate signals detected=${gateSignalsReady}`);
    if (!gateSignalsReady && d.pageLoad > 0) {
      logger.info(`[${trackId}] Gate signals not ready yet — fallback wait ${Math.min(d.pageLoad, 400)}ms`);
      await page.waitForTimeout(Math.min(d.pageLoad, 400));
    }
    await openGateIfNeeded(page, trackId, d.afterGateOpen);

    const pageTitle = await page.title().catch(() => '?');
    const finalUrl  = page.url();
    logger.info(`[${trackId}] Page title: "${pageTitle}"`);
    logger.info(`[${trackId}] Final URL:  ${finalUrl}`);

    // Wait for gate panels — Hypeddit renders them via JS so give it up to 25s
    logger.info(`[${trackId}] Waiting for gate panels to render...`);
    const gateFound = await page.waitForSelector('.fangate-slider-content', { timeout: 10000 })
      .then(() => true).catch(() => false);
    logger.info(`[${trackId}] Gate container found: ${gateFound}${!gateFound ? ' (timed out — checking DOM anyway)' : ''}`);

    // Full DOM snapshot — always logged at INFO level
    const domInfo = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('.fangate-slider-content')];
      const panelInfo = panels.map(p => ({
        classes: p.className,
        visible: p.offsetParent !== null,
        movLeft: p.classList.contains('move-left'),
        current: p.classList.contains('current-slide'),
        html:    p.innerHTML.slice(0, 150).replace(/\s+/g, ' '),
      }));
      // Determine the currently active (current-slide, not move-left) step
      const activePanel = panels.find(p =>
        p.classList.contains('current-slide') && !p.classList.contains('move-left')
      );
      const activeStep = activePanel
        ? [...activePanel.classList].find(c =>
            !['fangate-slider-content','current-slide','move-left'].includes(c)
          ) || '(unknown class)'
        : null;
      return {
        panels:     panelInfo,
        panelCount: panels.length,
        activeStep,
        startBtn:   !!document.querySelector('#downloadProcess'),
        startBtnClass: document.querySelector('#downloadProcess')?.className || '(none)',
        dlButton:   !!document.querySelector('#gateDownloadButton'),
        dlBtnClass: document.querySelector('#gateDownloadButton')?.className || '(none)',
        emailInput: !!(document.querySelector('#email_address') || document.querySelector('#download_email_address')),
        scBtn:      !!document.querySelector('#login_to_sc, .button-soundcloud-1'),
        spBtn:      !!document.querySelector('#login_to_sp, .button-spotify-1'),
        igBtn:      !!document.querySelector('.button-instagram-1'),
        nwSteps:    (document.body.innerHTML.match(/nwSteps\s*[:=]\s*["']([^"']+)["']/) || [])[1] || null,
        ogImage:    document.querySelector('meta[property="og:image"]')?.content || null,
        scArtwork:  (() => {
          // TRACK artwork only — must be a SoundCloud "artworks-" image, never an
          // "avatars-" image (that's the artist's profile photo, not the cover).
          const hit = [...document.querySelectorAll('img')]
            .map(i => i.src || '')
            .find(s => /sndcdn\.com\/artworks-/i.test(s) && !/avatars/i.test(s));
          return hit || null;
        })(),
      };
    }).catch(e => ({ error: e.message, panels: [], panelCount: 0 }));

    // Track artwork: prefer Hypeddit's per-track og:image (always THIS track's cover),
    // then a strict SoundCloud "artworks-" image. Never the artist avatar.
    const artworkUrl = domInfo.ogImage || domInfo.scArtwork || null;
    logger.info(`[${trackId}]   Artwork URL        : ${artworkUrl || '(none)'}`);

    logger.info(`[${trackId}] ── DOM SNAPSHOT ──`);
    logger.info(`[${trackId}]   Total gate panels : ${domInfo.panelCount}`);
    logger.info(`[${trackId}]   Active step        : ${domInfo.activeStep || '(none — all done or no gate)'}`);
    logger.info(`[${trackId}]   nwSteps from HTML  : ${domInfo.nwSteps || '(not found)'}`);
    logger.info(`[${trackId}]   Start button       : ${domInfo.startBtn} (class: "${domInfo.startBtnClass}")`);
    logger.info(`[${trackId}]   Download button    : ${domInfo.dlButton} (class: "${domInfo.dlBtnClass}")`);
    logger.info(`[${trackId}]   Email input        : ${domInfo.emailInput}`);
    logger.info(`[${trackId}]   SoundCloud button  : ${domInfo.scBtn}`);
    logger.info(`[${trackId}]   Spotify button     : ${domInfo.spBtn}`);
    logger.info(`[${trackId}]   Instagram button   : ${domInfo.igBtn}`);
    for (const p of domInfo.panels) {
      const status = p.movLeft ? 'DONE' : p.current ? 'ACTIVE' : 'pending';
      logger.info(`[${trackId}]   panel [${status}] classes="${p.classes}"`);
    }

    // ── Dynamic gate loop — scrape each step fresh, act on what's found ──
    const MAX_STEPS = 10;
    let lastStepType = null;
    let sameStepCount = 0;

    for (let stepNum = 0; stepNum < MAX_STEPS; stepNum++) {
      if (_cancelled) return { ok: false, error: 'Cancelled' };

      const state = await scrapeActiveStep(page);

      if (state.error) {
        logger.error(`[${trackId}] scrapeActiveStep error: ${state.error}`);
        break;
      }

      // Guard: if the same step type fails to advance, stop retrying.
      // Only reset the counter when a genuinely different (non-null) step type appears.
      // Previously, a brief done:true state (no stepType) during DOM transitions would hit
      // the else branch and zero the counter, letting the same step loop forever.
      if (state.stepType) {
        if (state.stepType === lastStepType) {
          sameStepCount++;
          if (sameStepCount >= 2) {
            logger.warn(`[${trackId}] Step "${state.stepType}" did not advance after ${sameStepCount} attempts — skipping`);
            break;
          }
        } else {
          sameStepCount = 0;
          lastStepType = state.stepType;
        }
      }
      // If stepType is null/undefined (transient DOM state), leave both counters unchanged

      logger.info(`[${trackId}] [step ${stepNum + 1}] Panels: ${state.panelSummary}`);

      // No active panel — either all done or gate never appeared
      if (state.done) {
        logger.info(`[${trackId}] No active gate panel — allDone=${state.allDone}`);
        if (state.dlButton?.found) logger.info(`[${trackId}] DL button visible: "${state.dlButton.text}" class="${state.dlButton.cls}"`);
        break;
      }

      const { stepType, actions } = state;
      logger.info(`[${trackId}] [step ${stepNum + 1}] Active step type: "${stepType}" (source=${state.panelSource || 'current-slide'})`);
      logger.info(`[${trackId}] [step ${stepNum + 1}] Found in panel: email=${actions.hasEmail}/${actions.emailVisible} SC=${actions.hasSC}/${actions.scVisible} SP=${actions.hasSP}/${actions.spVisible} IG=${actions.hasIG} jumpEmail=${actions.hasJumpEmail}/${actions.jumpEmailVisible} dlBtn=${actions.hasDLButton}`);
      logger.info(`[${trackId}] [step ${stepNum + 1}] Panel HTML: ${state.panelHTML}`);

      emit({ type: 'track_step', id: trackId, step: stepType, message: `Step ${stepNum + 1}: ${stepType}` });

      // If the active panel is the download panel — we're done with the gate
      const gateActionsRemaining = actions.hasEmail || actions.hasSC || actions.hasSP || actions.hasIG || actions.hasJumpEmail;
      if (stepType === 'dw' || (actions.hasDLButton && !gateActionsRemaining)) {
        logger.info(`[${trackId}] Download panel reached`);
        break;
      }

      const _start = Date.now();

      // ── Jump to email if combined gate offers it ──
      if (actions.hasJumpEmail && actions.jumpEmailVisible && (!actions.emailVisible || !actions.submitVisible)) {
        logger.info(`[${trackId}] [${stepType}] Jumping to email option inside combined gate`);
        await page.evaluate(() => {
          [...document.querySelectorAll('a')].find(
            a => {
              const onclick = a.getAttribute('onclick') || '';
              if (!onclick.includes('jumpGate') || !onclick.includes("'email'")) return false;
              const rect = a.getBoundingClientRect();
              const cs = getComputedStyle(a);
              return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
            }
          )?.click();
        }).catch(() => {});
        await page.waitForFunction(() => {
          const active = [...document.querySelectorAll('.fangate-slider-content')]
            .find((panel) => panel.classList.contains('current-slide') && !panel.classList.contains('move-left'));
          const email = active?.querySelector('#email_address, #download_email_address, input[type="email"]');
          const submit = active?.querySelector('#email_to_downloads_next, [id*="email"][id*="next"], [id*="download"][id*="next"]');
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const cs = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden';
          };
          return isVisible(email) && isVisible(submit);
        }, { timeout: 1500 }).catch(() => {});
        // Re-scrape — fall through to email handling on next iteration
        continue;
      }

      // ── Email step ──
      if (actions.hasEmail && actions.emailVisible) {
        logger.info(`[${trackId}] [${stepType}] Filling email: field="${actions.emailSel}" submitBtn="${actions.submitBtnId}"`);

        if (actions.emailSel) {
          await page.fill(actions.emailSel, cfg.email).catch(e => logger.warn(`[${trackId}] fill email failed: ${e.message}`));
        }
        if (actions.hasName && actions.nameSel && cfg.name) {
          await page.fill(actions.nameSel, cfg.name).catch(() => {});
          logger.info(`[${trackId}] [${stepType}] Filled name: "${cfg.name}"`);
        }

        // Deferred click to avoid blocking the XHR
        await page.evaluate(() => {
          const btn = document.querySelector('#email_to_downloads_next') ||
                      document.querySelector('[id*="email"][id*="next"]') ||
                      document.querySelector('[id*="download"][id*="next"]');
          setTimeout(() => btn?.click(), 0);
        }).catch(() => {});
        logger.info(`[${trackId}] [${stepType}] Submit clicked`);

        // Wait for this panel to slide out (move-left)
        const panelClass = stepType;
        const moved = await page.waitForFunction((cls) => {
          const panel = [...document.querySelectorAll('.fangate-slider-content')]
            .find(p => [...p.classList].some(c => c === cls || c.includes('|')));
          return !panel || panel.classList.contains('move-left');
        }, panelClass, { timeout: 30000 }).then(() => true).catch(() => false);
        logger.info(`[${trackId}] [${stepType}] Panel advanced: ${moved} (${Date.now() - _start}ms)`);

      // ── SoundCloud OAuth ──
      } else if (actions.hasSC) {
        logger.info(`[${trackId}] [${stepType}] Opening SoundCloud popup (btn: "${actions.scBtnId}")`);
        if (actions.hasSCComment) {
          await page.fill('#sc_comment_text', 'Amazing track!', { timeout: 500 }).catch(() => {});
        }

        // Use the correct Playwright popup pattern: waitForEvent('popup') + page.click()
        // page.click() dispatches a trusted user-initiated click that bypasses popup blockers,
        // whereas evaluate(btn.click()) is a script click that Chrome may silently block.
        const scSelector = actions.scBtnId
          ? `#${actions.scBtnId}`
          : '#login_to_sc, .button-soundcloud-1';

        let scPopup = null;
        let scClick = null;
        try {
          [scPopup] = await Promise.all([
            page.waitForEvent('popup', { timeout: 6000 }),
            // force:true bypasses Playwright's visibility check — gate buttons are in the DOM
            // but have visibility:hidden / display:none until Hypeddit's JS reveals them.
            // A forced CDP click is still treated as user-initiated by Chrome, so popups are allowed.
            page.click(scSelector, { timeout: 3000, force: true }).catch(() =>
              page.evaluate((sel) => document.querySelector(sel)?.click(), scSelector)
            ),
          ]);
        } catch {
          logger.warn(`[${trackId}] [sc] Popup not captured — trying evaluate click fallback`);
          await page.evaluate((btnId) => {
            const btn = (btnId ? document.querySelector('#' + btnId) : null)
              || document.querySelector('#login_to_sc')
              || document.querySelector('.button-soundcloud-1');
            btn?.click();
          }, actions.scBtnId).catch(() => {});
          scPopup = await page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
        }

        if (!scPopup) {
          ({ popup: scPopup, clickResult: scClick } = await triggerActivePanelPopup(page, [
            'a.loginArea.login-to-soundcloud-common',
            '#login_to_sc',
            '.button-soundcloud-1',
            '[id*="sc_btn"]',
            '[id*="sc_connect"]',
            '[class*="soundcloud"]:not([class*="comment"])',
          ]));
          if (!scPopup) {
            logger.warn(`[${trackId}] [sc] Active-panel popup retry failed â€” clickResult=${JSON.stringify(scClick)}`);
          }
        }

        if (scPopup) {
          try {
            await scPopup.waitForLoadState('domcontentloaded').catch(() => {});
            logger.info(`[${trackId}] [sc] Popup opened: ${scPopup.url()}`);
            await Promise.race([
              scPopup.waitForURL('**soundcloud.com**', { timeout: 4000 }),
              scPopup.waitForEvent('close',             { timeout: 4000 }),
            ]).catch(() => {});
            if (!scPopup.isClosed() && scPopup.url().includes('soundcloud.com')) {
              logger.info(`[${trackId}] [sc] On SC auth page — trying to auto-authorize`);
              await scPopup.waitForSelector([
                'button:has-text("Connect")',
                'button:has-text("Allow")',
                'button:has-text("Authorize")',
                '.sc-button-primary',
                'button[type=submit]',
              ].join(', '), { timeout: 1200 }).catch(() => {});
              await scPopup.click([
                'button:has-text("Connect")', 'button:has-text("Allow")',
                'button:has-text("Authorize")', '.sc-button-primary',
                'button[type=submit]',
              ].join(', ')).catch(() => {});
              if (!scPopup.isClosed()) {
                logger.warn(`[${trackId}] [sc] Waiting for manual SoundCloud login (up to ${Math.round(d.scPopupTimeout/1000)}s)...`);
                emit({ type: 'track_step', id: trackId, step: 'sc', message: 'Waiting for SoundCloud login in popup...' });
              }
            }
            await waitForPopupCloseOrCallback(
              scPopup,
              trackId,
              'sc',
              d.scPopupTimeout,
              [/hypeddit\.com\/auth2\.php/i],
            );
            logger.info(`[${trackId}] [sc] Popup closed`);
          } catch (e) { logger.warn(`[${trackId}] [sc] Popup error: ${e.message}`); }
        } else {
          logger.warn(`[${trackId}] [sc] No popup opened — SC auth blocked or unavailable`);
          emit({ type: 'track_step', id: trackId, step: 'sc', message: 'SC popup blocked — skipping step' });
        }

        // Wait for SC panel to slide out
        const scMoved = await page.waitForFunction(() => {
          const sc = [...document.querySelectorAll('.fangate-slider-content')]
            .find(el => el.classList.contains('sc') || el.classList.contains('sc_email'));
          return !sc || sc.classList.contains('move-left') || !sc.classList.contains('current-slide');
        }, { timeout: 8000 }).then(() => true).catch(() => false);
        logger.info(`[${trackId}] [sc] Panel advanced: ${scMoved} (${Date.now() - _start}ms)`);

      // ── Spotify OAuth ──
      } else if (actions.hasSP) {
        logger.info(`[${trackId}] [${stepType}] Opening Spotify popup (btn: "${actions.spBtnId}")`);

        const spSelector = actions.spBtnId
          ? `#${actions.spBtnId}`
          : '#login_to_sp, .button-spotify-1';

        let spPopup = null;
        let spClick = null;
        try {
          [spPopup] = await Promise.all([
            page.waitForEvent('popup', { timeout: 6000 }),
            page.click(spSelector, { timeout: 3000, force: true }).catch(() =>
              page.evaluate((sel) => document.querySelector(sel)?.click(), spSelector)
            ),
          ]);
        } catch {
          logger.warn(`[${trackId}] [sp] Popup not captured — trying evaluate click`);
          await page.evaluate((btnId) => {
            const btn = (btnId ? document.querySelector('#' + btnId) : null)
              || document.querySelector('#login_to_sp')
              || document.querySelector('.button-spotify-1')
              || document.querySelector('[class*="spotify"]');
            btn?.click();
          }, actions.spBtnId).catch(() => {});
          spPopup = await page.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
        }

        if (!spPopup) {
          ({ popup: spPopup, clickResult: spClick } = await triggerActivePanelPopup(page, [
            'a.loginArea.login-to-spotify-common',
            '#login_to_sp',
            '.button-spotify-1',
            '[class*="spotify"]',
          ]));
          if (!spPopup) {
            logger.warn(`[${trackId}] [sp] Active-panel popup retry failed â€” clickResult=${JSON.stringify(spClick)}`);
          }
        }

        if (spPopup) {
          try {
            await spPopup.waitForLoadState('domcontentloaded').catch(() => {});
            logger.info(`[${trackId}] [sp] Popup opened: ${spPopup.url()}`);
            await Promise.race([
              spPopup.waitForURL('**spotify.com**', { timeout: 4000 }),
              spPopup.waitForEvent('close',          { timeout: 4000 }),
            ]).catch(() => {});
            if (!spPopup.isClosed() && spPopup.url().includes('spotify.com')) {
              logger.info(`[${trackId}] [sp] On Spotify auth page — trying to auto-authorize`);
              await spPopup.waitForSelector([
                'button[data-testid="auth-accept"]',
                'button:has-text("Agree")',
                'button:has-text("Accept")',
                'button:has-text("Connect")',
                'button[type=submit]',
              ].join(', '), { timeout: 1200 }).catch(() => {});
              await spPopup.click([
                'button[data-testid="auth-accept"]', 'button:has-text("Agree")',
                'button:has-text("Accept")', 'button:has-text("Connect")',
                'button[type=submit]',
              ].join(', ')).catch(() => {});
              if (!spPopup.isClosed()) {
                logger.warn(`[${trackId}] [sp] Waiting for manual Spotify login (up to ${Math.round(d.spPopupTimeout/1000)}s)...`);
                emit({ type: 'track_step', id: trackId, step: 'sp', message: 'Waiting for Spotify login in popup...' });
              }
            }
            await waitForPopupCloseOrCallback(
              spPopup,
              trackId,
              'sp',
              d.spPopupTimeout,
              [/hypeddit\.com\/spotify_callback/i],
            );
            logger.info(`[${trackId}] [sp] Popup closed`);
          } catch (e) { logger.warn(`[${trackId}] [sp] Popup error: ${e.message}`); }
        } else {
          logger.warn(`[${trackId}] [sp] No popup opened — Spotify auth blocked or unavailable`);
          emit({ type: 'track_step', id: trackId, step: 'sp', message: 'SP popup blocked — skipping step' });
        }

        const spMoved = await page.waitForFunction(() => {
          const sp = [...document.querySelectorAll('.fangate-slider-content')]
            .find(el => el.classList.contains('sp'));
          return !sp || sp.classList.contains('move-left') || !sp.classList.contains('current-slide');
        }, { timeout: 8000 }).then(() => true).catch(() => false);
        logger.info(`[${trackId}] [sp] Panel advanced: ${spMoved} (${Date.now() - _start}ms)`);

      // ── Instagram follows ──
      } else if (actions.hasIG) {
        logger.info(`[${trackId}] [${stepType}] Instagram: ${actions.igCount} buttons to click`);
        for (let i = 0; i < actions.igCount; i++) {
          await page.evaluate(() => {
            document.querySelector('.button-instagram-1.undone')?.click();
          }).catch(() => {});
          await page.waitForFunction(
            (n) => document.querySelectorAll('.button-instagram-1.undone').length < n,
            actions.igCount - i, { timeout: 1500 }
          ).catch(() => {});
          const closedPages = await closeExtraPages([page], { waitMs: 500 });
          if (closedPages > 0) {
            logger.info(`[${trackId}] [ig] Closed ${closedPages} Instagram popup(s) after button ${i + 1}`);
          }
          logger.info(`[${trackId}] [ig] Button ${i + 1}/${actions.igCount} clicked`);
        }
        await page.evaluate((sid) => {
          const btn = (sid ? document.querySelector('#' + sid) : null)
            || document.querySelector('#skipper_ig_channel, #skipper_ig_next');
          btn?.click();
        }, actions.skipperIGId).catch(() => {});
        const closedAfterSkip = await closeExtraPages([page], { waitMs: 500 });
        if (closedAfterSkip > 0) {
          logger.info(`[${trackId}] [ig] Closed ${closedAfterSkip} Instagram popup(s) after skip`);
        }

        const igMoved = await page.waitForFunction(() => {
          const ig = [...document.querySelectorAll('.fangate-slider-content')]
            .find(el => el.classList.contains('ig'));
          return !ig || ig.classList.contains('move-left') || !ig.classList.contains('current-slide');
        }, { timeout: 5000 }).then(() => true).catch(() => false);
        logger.info(`[${trackId}] [ig] Panel advanced: ${igMoved} (${Date.now() - _start}ms)`);

      } else {
        logger.warn(`[${trackId}] [step ${stepNum + 1}] No known actions found in panel "${stepType}" — skipping`);
        break;
      }

      // Brief pause then loop back to re-scrape the next active panel
      await page.waitForTimeout(150);
    }

    // ── Trigger download ──
    emit({ type: 'track_step', id: trackId, step: 'dw', message: 'Triggering download...' });

    const preDlDom = await page.evaluate(() => {
      const btn = document.querySelector('#gateDownloadButton');
      return {
        btnFound:    !!btn,
        btnClass:    btn?.className || '(none)',
        btnText:     btn?.textContent?.trim()?.slice(0, 60) || '',
        btnDisabled: btn?.classList.contains('disable') || btn?.classList.contains('disabled'),
        pendingPanels: [...document.querySelectorAll('.fangate-slider-content')]
          .filter(p => !p.classList.contains('move-left'))
          .map(p => p.className),
      };
    }).catch(e => ({ error: e.message }));

    logger.info(`[${trackId}] Pre-download state: btnFound=${preDlDom.btnFound} disabled=${preDlDom.btnDisabled} text="${preDlDom.btnText}"`);
    logger.info(`[${trackId}] Pending panels: ${JSON.stringify(preDlDom.pendingPanels)}`);

    if (!preDlDom.btnFound) {
      logger.error(`[${trackId}] #gateDownloadButton not found`);
      return { ok: false, error: 'Download button not found in DOM' };
    }

    logger.info(`[${trackId}] Clicking download button...`);
    await page.evaluate(() => {
      const btn = document.querySelector('#gateDownloadButton');
      if (btn) { btn.classList.remove('disable', 'disabled', 'hy-btn-lightgray'); btn.click(); }
    }).catch(e => logger.warn(`[${trackId}] click error: ${e.message}`));

    logger.info(`[${trackId}] Waiting up to 20s for download...`);
    const dl = await page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    if (!dl) {
      logger.error(`[${trackId}] No download in 20s — final url: ${page.url()}`);
      return { ok: false, error: 'No download triggered — gate may not be fully completed' };
    }

    const fname = dl.suggestedFilename();
    emit({ type: 'track_step', id: trackId, step: 'save', message: `Saving ${fname}` });
    logger.info(`[${trackId}] Saving: ${fname}`);

    fs.mkdirSync(cfg.downloadDir, { recursive: true });
    const outPath = path.join(cfg.downloadDir, fname);
    await dl.saveAs(outPath);

    logger.success(`[${trackId}] Downloaded: ${fname}`);

    // Embed SoundCloud cover art if the file has none (best-effort, never fails the download)
    if (cfg.coverArt !== false) {
      emit({ type: 'track_step', id: trackId, step: 'cover', message: 'Checking cover art...' });
      try { await coverart.ensureCoverArt(outPath, artworkUrl, trackId); }
      catch (e) { logger.warn(`[${trackId}] cover art error: ${e.message}`); }
    }

    return { ok: true, file: fname };

  } catch (e) {
    logger.error(`[${trackId}] Error: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    await releaseWorkerPage(page);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function runBatch(rawInput) {
  if (_running) {
    return { error: 'Already running' };
  }
  _running   = true;
  _cancelled = false;

  try {

  const rawIds = resolveIds(rawInput);

  // Expand chart URLs; pass { url } and numeric IDs through unchanged
  const ids = [];
  for (const item of rawIds) {
    if (item && typeof item === 'object' && item.chart) {
      try {
        const scraped = await scrapeChart(item.chart, { purpose: 'batch' });
        logger.info(`Chart expanded: ${scraped.length} tracks`);
        // Wrap non-numeric scraped URLs as { url } objects so downloadTrackBrowser handles them correctly
        for (const s of scraped) {
          ids.push(/^\d+$/.test(s) ? s : { url: s });
        }
      } catch (e) {
        logger.error(`Chart scrape failed: ${e.message}`);
      }
    } else if (item && typeof item === 'object' && item.sc) {
      try {
        logger.info(`Resolving SoundCloud link: ${item.sc}`);
        emit({ type: 'status', status: 'resolving', message: 'Resolving SoundCloud link...' });
        const r = await scResolver.resolve(item.sc);
        if (!r.ok) {
          logger.error(`SoundCloud resolve failed (${item.sc}): ${r.error}`);
        } else if (r.kind === 'playlist') {
          logger.success(`SoundCloud playlist "${r.title}" → ${r.tracks.length} gated track(s)`);
          for (const t of r.tracks) ids.push({ url: t.hypedditUrl });
        } else if (r.hypedditUrl) {
          logger.success(`SoundCloud → Hypeddit: "${r.title}" → ${r.hypedditUrl}`);
          ids.push({ url: r.hypedditUrl });
        } else if (r.scDownloadable) {
          logger.warn(`"${r.title}" offers a native SoundCloud download but no Hypeddit gate — SC-native download isn't supported yet, skipping`);
        } else {
          logger.error(`No free download found for SoundCloud track "${r.title || item.sc}" (no Hypeddit gate, not downloadable)`);
        }
      } catch (e) {
        logger.error(`SoundCloud resolve error: ${e.message}`);
      }
    } else {
      ids.push(item); // string ID or { url } — both handled by downloadTrackBrowser
    }
  }

  const cfg    = config.get();
  const total  = ids.length;
  const failed = [];
  let ok = 0, fail = 0;
  let consecutiveDirectFallbacks = 0;
  let bypassDirectForBatch = false;

  if (total === 0) {
    return { total: 0, ok: 0, fail: 0, failed: [], error: 'No valid tracks found' };
  }

  logger.info(`Starting batch: ${total} tracks → ${cfg.downloadDir}`);
  emit({ type: 'batch_start', total, ids });

  for (let i = 0; i < ids.length; i++) {
    if (_cancelled) {
      logger.info('Batch cancelled by user');
      break;
    }

    const trackRef = ids[i];
    // Derive display label
    const id = (trackRef && typeof trackRef === 'object' && trackRef.url)
      ? trackRef.url.replace(/\/$/, '').split('/').filter(Boolean).slice(-2).join('/')
      : String(trackRef);

    emit({ type: 'track_start', id, index: i, total });
    logger.info(`[${i + 1}/${total}] Track: ${id}`);

    let result;

    // Try direct HTTP only for numeric IDs (not artist/slug URLs)
    const isTrackCode = typeof trackRef === 'string' && /^[a-z0-9]+$/i.test(trackRef);
    const shouldTryDirect = !bypassDirectForBatch
      && isTrackCode
      && (cfg.downloadMode === 'hybrid' || cfg.downloadMode === 'direct');
    if (shouldTryDirect) {
      logger.debug(`[${id}] Trying direct HTTP...`);
      emit({ type: 'track_step', id, step: 'direct', message: 'Trying direct HTTP...' });
      result = await directClient.downloadDirect(trackRef);

      if (!result.ok && result.needsBrowser && cfg.downloadMode === 'hybrid') {
        consecutiveDirectFallbacks++;
        logger.info(`[${id}] Direct failed (${result.error}) — switching to browser`);
        emit({ type: 'track_step', id, step: 'fallback', message: 'Direct failed, using browser' });
        if (consecutiveDirectFallbacks >= 3) {
          bypassDirectForBatch = true;
          logger.info('Direct HTTP has fallen back to the browser 3 times in a row — skipping direct mode for the rest of this batch');
        }
      } else {
        consecutiveDirectFallbacks = 0;
      }
    }

    // Use browser if direct failed or not in direct-only mode
    if (!result?.ok && cfg.downloadMode !== 'direct') {
      try {
        await ensureBrowser();
        result = await downloadTrackBrowser(trackRef);
      } catch (e) {
        if ((e.message || '').includes('Close the login browser window')) {
          result = { ok: false, error: e.message };
        } else {
          // Browser might have crashed — try one relaunch
          logger.warn(`Browser error: ${e.message} — relaunching`);
          await closeBrowser();
          try {
            await ensureBrowser();
            result = await downloadTrackBrowser(trackRef);
          } catch (e2) {
            result = { ok: false, error: e2.message };
          }
        }
      }
    }

    // URL tracks in direct-only mode can't be handled — give a clear error instead of silent undefined
    if (!result) {
      result = { ok: false, error: 'URL tracks require a browser — switch from "Direct HTTP only" mode in Settings' };
    }

    if (result?.ok) {
      ok++;
      emit({ type: 'track_done', id, index: i, total, ok, fail, file: result.file });
      logger.success(`[${i + 1}/${total}] ✓ ${id} → ${result.file}`);
    } else {
      fail++;
      failed.push(id);
      emit({ type: 'track_fail', id, index: i, total, ok, fail, error: result?.error });
      logger.error(`[${i + 1}/${total}] ✗ ${id} — ${result?.error}`);
    }

    // Delay between tracks
    if (i < ids.length - 1 && !_cancelled) {
      await new Promise(r => setTimeout(r, cfg.delays.betweenTracks));
    }
  }

  // Save session after batch
  if (_context) await saveSessionState();

  const summary = { total, ok, fail, failed };
  logger.info(`Batch complete: ${ok} ok, ${fail} failed`);
  emit({ type: 'batch_done', ...summary });

    return summary;
  } finally {
    _running = false;
  }
}

function cancel() {
  _cancelled = true;
  logger.warn('Cancellation requested — stopping after current track');
  emit({ type: 'status', status: 'cancelling', message: 'Stopping after current track...' });
}

function isRunning() { return _running; }

function getSessionStatus() {
  const session = browserManager.getSessionStatus();
  return {
    ...session,
    browserOpen: !!_context || !!session.manualLoginBrowserOpen,
    browserPurpose: _contextPurpose || (session.manualLoginBrowserOpen ? 'session' : null),
  };
}

async function shutdown() {
  _cancelled = true;
  await closeBrowser();
}

module.exports = {
  runBatch,
  cancel,
  isRunning,
  setProgressCallback,
  shutdown,
  resolveIds,
  previewChart,
  openSessionSetup,
  saveSessionState,
  closeBrowser,
  getSessionStatus,
};
