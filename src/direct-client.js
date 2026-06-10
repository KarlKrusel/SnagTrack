/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

/**
 * Direct HTTP client — attempts to complete Hypeddit gate steps
 * without launching a browser. Works for email-only gates.
 * Falls back gracefully when Cloudflare/JS challenges are detected.
 */

const https   = require('https');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const url     = require('url');
const logger  = require('./logger');
const config  = require('./config');

// Simple cookie jar
class CookieJar {
  constructor() { this._cookies = {}; }

  set(domain, name, value, attrs = {}) {
    if (!this._cookies[domain]) this._cookies[domain] = {};
    this._cookies[domain][name] = { value, ...attrs };
  }

  get(domain) {
    // Match root domain and subdomains
    const matches = [];
    for (const d of Object.keys(this._cookies)) {
      if (domain === d || domain.endsWith('.' + d) || d.endsWith('.' + domain)) {
        for (const [k, v] of Object.entries(this._cookies[d])) {
          matches.push(`${k}=${v.value}`);
        }
      }
    }
    return matches.join('; ');
  }

  parseSetCookie(header, domain) {
    if (!header) return;
    const parts = header.split(';').map(s => s.trim());
    const [nameVal] = parts;
    const [name, ...rest] = nameVal.split('=');
    const value = rest.join('=');
    this.set(domain, name.trim(), value.trim());
  }

  load(cookiesFile) {
    if (!fs.existsSync(cookiesFile)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      if (Array.isArray(raw)) {
        for (const c of raw) {
          if (c.name && c.value && c.domain) {
            this.set(c.domain.replace(/^\./, ''), c.name, c.value);
          }
        }
        logger.debug(`[direct] Loaded ${raw.length} cookies from file`);
      }
    } catch {}
  }
}

function request(options, postData) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function fetchPage(pageUrl, jar, extraHeaders = {}) {
  const parsed = new url.URL(pageUrl);
  const opts = {
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path:     parsed.pathname + parsed.search,
    method:   'GET',
    headers: {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie':          jar.get(parsed.hostname),
      ...extraHeaders,
    },
  };

  const res = await request(opts);

  // Store cookies
  const setCookie = res.headers['set-cookie'];
  if (setCookie) {
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookies) jar.parseSetCookie(c, parsed.hostname);
  }

  // Follow redirects (max 5)
  if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
    const redirectUrl = new url.URL(res.headers.location, pageUrl).href;
    return fetchPage(redirectUrl, jar, extraHeaders);
  }

  return res;
}

function parseForm(html, formId) {
  // Very basic form parser — extract hidden inputs and action URL
  const formMatch = formId
    ? html.match(new RegExp(`<form[^>]*id=["']${formId}["'][^>]*>([\s\S]*?)</form>`, 'i'))
    : html.match(/<form[^>]*>([\s\S]*?)<\/form>/i);

  if (!formMatch) return null;

  const formHtml  = formMatch[0];
  const actionMatch = formHtml.match(/action=["']([^"']+)["']/i);
  const methodMatch = formHtml.match(/method=["']([^"']+)["']/i);

  const inputs = {};
  let m;
  const inputRe = /<input[^>]*>/gi;
  while ((m = inputRe.exec(formHtml)) !== null) {
    const tag     = m[0];
    const nameM   = tag.match(/name=["']([^"']+)["']/i);
    const valueM  = tag.match(/value=["']([^"']*?)["']/i);
    if (nameM) inputs[nameM[1]] = valueM ? valueM[1] : '';
  }

  return {
    action: actionMatch ? actionMatch[1] : null,
    method: methodMatch ? methodMatch[1].toUpperCase() : 'POST',
    fields: inputs,
  };
}

function isCloudflareChallenge(html) {
  return html.includes('cf-browser-verification') ||
         html.includes('cf_clearance') ||
         html.includes('Checking your browser') ||
         html.includes('jschl_vc') ||
         html.includes('Just a moment...');
}

function detectGateSteps(html) {
  // Parse nwSteps from HTML — same approach as check_steps.js
  const match = html.match(/nwSteps\s*[:=]\s*["']([^"']+)["']/);
  if (!match) return null;
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Attempt to download a track using direct HTTP (no browser).
 * Returns { ok, file, error, needsBrowser }
 *   needsBrowser = true means caller should retry with a real browser.
 */
async function downloadDirect(trackId) {
  const cfg = config.get();
  const jar = new CookieJar();

  // Load saved cookies
  if (fs.existsSync(cfg.cookiesFile))  jar.load(cfg.cookiesFile);
  if (fs.existsSync(cfg.sessionFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(cfg.sessionFile, 'utf8'));
      if (state.cookies) {
        for (const c of state.cookies) {
          if (c.domain && c.name) jar.set(c.domain.replace(/^\./, ''), c.name, c.value);
        }
      }
    } catch {}
  }

  const trackUrl = `https://hypeddit.com/track/${trackId}`;
  logger.debug(`[direct] Fetching ${trackUrl}`);

  let res;
  try {
    res = await fetchPage(trackUrl, jar);
  } catch (e) {
    return { ok: false, needsBrowser: true, error: `Fetch failed: ${e.message}` };
  }

  if (res.status !== 200) {
    return { ok: false, needsBrowser: true, error: `HTTP ${res.status}` };
  }

  if (isCloudflareChallenge(res.body)) {
    logger.warn(`[direct] Cloudflare challenge detected — browser required`);
    return { ok: false, needsBrowser: true, error: 'Cloudflare challenge' };
  }

  const steps = detectGateSteps(res.body);
  logger.debug(`[direct] Gate steps: ${JSON.stringify(steps)}`);

  // If any step requires OAuth (SC/SP/IG), we need a browser with cookies
  if (!steps) {
    return { ok: false, needsBrowser: true, error: 'Could not detect gate steps' };
  }

  const requiresBrowser = steps.some(s => s === 'sc' || s === 'sp' || s === 'ig');
  if (requiresBrowser) {
    return { ok: false, needsBrowser: true, error: `Gate requires OAuth steps: ${steps.join(', ')}` };
  }

  // Email-only gate — try direct POST
  if (steps.includes('email') || steps.includes('sc_email')) {
    logger.info(`[direct] Attempting email gate for track ${trackId}`);

    // Find the email form
    const form = parseForm(res.body, 'download_email_form') || parseForm(res.body);
    if (!form) {
      return { ok: false, needsBrowser: true, error: 'Could not parse email form' };
    }

    const fields = {
      ...form.fields,
      email_address: cfg.email,
      download_email_address: cfg.email,
      name: cfg.name,
    };

    const body = Object.entries(fields)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
      .join('&');

    const actionUrl = form.action
      ? new url.URL(form.action, trackUrl).href
      : trackUrl;

    logger.debug(`[direct] Posting email form to ${actionUrl}`);

    let formRes;
    try {
      const parsed = new url.URL(actionUrl);
      formRes = await request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port:     parsed.port || 443,
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers: {
          'User-Agent':   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Referer':      trackUrl,
          'Cookie':       jar.get(parsed.hostname),
        },
      }, body);
    } catch (e) {
      return { ok: false, needsBrowser: true, error: `Form POST failed: ${e.message}` };
    }

    if (![200, 302, 303].includes(formRes.status)) {
      return { ok: false, needsBrowser: true, error: `Form response: HTTP ${formRes.status}` };
    }

    // Look for download URL in response
    const dlMatch = formRes.body.match(/"download_url"\s*:\s*"([^"]+)"/i)
                 || formRes.body.match(/href=["']([^"']*\.mp3[^"']*?)["']/i)
                 || formRes.body.match(/href=["']([^"']*\.wav[^"']*?)["']/i)
                 || formRes.body.match(/href=["']([^"']*\.aif[^"']*?)["']/i);

    if (!dlMatch) {
      return { ok: false, needsBrowser: true, error: 'No download URL found in response' };
    }

    const dlUrl = dlMatch[1].replace(/\\/g, '');
    logger.info(`[direct] Found download URL: ${dlUrl.slice(0, 60)}...`);

    return downloadFile(dlUrl, cfg.downloadDir, jar);
  }

  return { ok: false, needsBrowser: true, error: `No supported gate steps: ${steps.join(', ')}` };
}

async function downloadFile(dlUrl, dir, jar) {
  return new Promise((resolve) => {
    fs.mkdirSync(dir, { recursive: true });

    const parsed = new url.URL(dlUrl);
    const reqOpts = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port:     parsed.port || 443,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie':     jar.get(parsed.hostname),
      },
    };

    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.request(reqOpts, (res) => {
      if ([301, 302, 303].includes(res.status) && res.headers.location) {
        downloadFile(new url.URL(res.headers.location, dlUrl).href, dir, jar).then(resolve);
        return;
      }

      const cd       = res.headers['content-disposition'] || '';
      const fnMatch  = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
      const rawName  = fnMatch ? fnMatch[1].replace(/['"]/g, '') : path.basename(parsed.pathname) || `track-${Date.now()}.mp3`;
      const fname    = rawName.replace(/[\\/:*?"<>|]/g, '_');
      const outPath  = path.join(dir, fname);
      const out      = fs.createWriteStream(outPath);
      res.pipe(out);
      out.on('finish', () => {
        logger.success(`[direct] Saved: ${fname}`);
        resolve({ ok: true, file: fname });
      });
      out.on('error', e => resolve({ ok: false, error: e.message }));
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

module.exports = { downloadDirect };
