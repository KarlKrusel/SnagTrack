/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

/**
 * SoundCloud link resolver.
 *
 * Lets the user paste a SoundCloud track URL instead of a Hypeddit link.
 * Artists who gate a free download on Hypeddit put the gate URL in the track's
 * `purchase_url` (the "Free DL / Buy" link) — verified against live tracks, e.g.
 *   soundcloud.com/medusaaaaaaa/pipipi-gamabe-medusa-free-dl
 *     → purchase_url = https://hypeddit.com/gamabemedusa/pipipigamabemedusafreedlextended
 *
 * Strategy: resolve the track via SoundCloud's public api-v2 (with a client_id
 * scraped from the site), then pull the Hypeddit gate from purchase_url, falling
 * back to any hypeddit.com link in the description. Also reports SoundCloud's own
 * native download flag.
 */

const https  = require('https');
const logger = require('./logger');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let _clientId = null;

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA, ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).href, headers));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), finalUrl: url }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

function isSoundCloudUrl(str) {
  return /^(https?:\/\/)?(www\.|m\.|on\.)?soundcloud\.com\//i.test(str.trim());
}

// Scrape a usable client_id from the SoundCloud web app bundles.
async function getClientId(force = false) {
  if (_clientId && !force) return _clientId;
  const home = await get('https://soundcloud.com/');
  const scripts = [...home.body.matchAll(/<script[^>]+src="(https:\/\/[a-z0-9-]+\.sndcdn\.com\/assets\/[^"]+\.js)"/gi)].map(m => m[1]);
  // client_id tends to live in the later bundles — search from the end
  for (const src of scripts.reverse()) {
    try {
      const js = await get(src);
      const m = js.body.match(/client_id\s*[:=]\s*"([A-Za-z0-9]{20,})"/);
      if (m) { _clientId = m[1]; logger.debug(`[sc] client_id acquired (${m[1].slice(0, 6)}…)`); return _clientId; }
    } catch {}
  }
  throw new Error('could not obtain SoundCloud client_id');
}

async function apiResolve(scUrl) {
  let cid = await getClientId();
  const call = (id) => get(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(scUrl)}&client_id=${id}`);
  let res = await call(cid);
  if (res.status === 401 || res.status === 403) {
    cid = await getClientId(true); // stale id — refresh once
    res = await call(cid);
  }
  if (res.status !== 200) throw new Error(`resolve HTTP ${res.status}`);
  return JSON.parse(res.body);
}

function extractHypedditFromTrack(track) {
  const candidates = [];
  if (track.purchase_url && /hypeddit\.com/i.test(track.purchase_url)) candidates.push(track.purchase_url);
  const descHits = (track.description || '').match(/https?:\/\/(?:www\.)?hypeddit\.com\/[^\s"'<>)]+/gi) || [];
  candidates.push(...descHits);
  // Normalise + dedupe
  const seen = new Set();
  for (let url of candidates) {
    url = url.replace(/[).,]+$/, '');
    if (!seen.has(url)) { seen.add(url); return url; } // first good hit wins
  }
  return null;
}

/**
 * Resolve a SoundCloud URL to a downloadable target.
 * Returns one of:
 *   { ok:true,  kind:'track', hypedditUrl, title, permalink, scDownloadable }
 *   { ok:true,  kind:'playlist', tracks:[{title, hypedditUrl, permalink}], ... }
 *   { ok:false, error }
 */
async function resolve(scUrl) {
  let data;
  try { data = await apiResolve(scUrl.trim()); }
  catch (e) { return { ok: false, error: e.message }; }

  if (data.kind === 'track') {
    const hypedditUrl = extractHypedditFromTrack(data);
    return {
      ok: true, kind: 'track',
      title: data.title,
      permalink: data.permalink_url,
      hypedditUrl,
      scDownloadable: !!data.downloadable && data.has_downloads_left !== false,
    };
  }

  if (data.kind === 'playlist' && Array.isArray(data.tracks)) {
    const tracks = data.tracks
      .map(t => ({ title: t.title, permalink: t.permalink_url, hypedditUrl: extractHypedditFromTrack(t) }))
      .filter(t => t.hypedditUrl);
    return { ok: true, kind: 'playlist', title: data.title, tracks };
  }

  return { ok: false, error: `unsupported SoundCloud target (kind=${data.kind})` };
}

module.exports = { isSoundCloudUrl, resolve, getClientId };
