/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

/**
 * Cover art — fetch the track's artwork (SoundCloud / Hypeddit og:image) and
 * embed it into the downloaded file, but ONLY when the file has no art already.
 *
 * Formats:
 *   .mp3 → standard ID3v2 APIC (node-id3 writes this correctly)
 *   .wav → ID3v2 tag injected as a proper RIFF 'id3 ' chunk (node-id3's own
 *          WAV writer corrupts the RIFF header, so we build the tag with
 *          NodeID3.create() and splice the chunk in ourselves — verified valid
 *          by ffprobe: audio stream stays intact, art reads back as mjpeg).
 *
 * Artwork is normalised to JPEG/PNG first (webp → jpeg via ffmpeg) because most
 * DJ software and players won't render embedded webp.
 */

const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const { execFileSync, spawnSync } = require('child_process');
const NodeID3 = require('node-id3');
const logger  = require('./logger');

const TAGGABLE = new Set(['.mp3', '.wav']);

let _ffmpegPath = null;
let _ffmpegChecked = false;

function findFfmpeg() {
  if (_ffmpegChecked) return _ffmpegPath;
  _ffmpegChecked = true;
  const candidates = ['ffmpeg', process.env.FFMPEG_PATH].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
      if (r.status === 0) { _ffmpegPath = c; return c; }
    } catch {}
  }
  _ffmpegPath = null;
  return null;
}

// ─── Artwork URL helpers ──────────────────────────────────────────────────

// Bump common SoundCloud thumbnail sizes up to 500x500.
function upgradeArtworkUrl(url) {
  if (!url) return url;
  if (/sndcdn\.com/i.test(url)) {
    return url.replace(/-(large|t\d+x\d+|small|badge|tiny|crop|original)\.(jpg|jpeg|png)/i, '-t500x500.$2');
  }
  return url;
}

function fetchBytes(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects < 0) return reject(new Error('too many redirects'));
    const mod = url.startsWith('http:') ? http : https;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(fetchBytes(new URL(res.headers.location, url).href, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

// Normalise arbitrary image bytes to JPEG/PNG that players actually render.
function toEmbeddable(buffer) {
  const isJpeg = buffer.length > 3 && buffer[0] === 0xFF && buffer[1] === 0xD8;
  const isPng  = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
  const isWebp = buffer.length > 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

  if (isJpeg) return { buffer, mime: 'image/jpeg' };
  if (isPng)  return { buffer, mime: 'image/png' };

  // webp or unknown → convert to jpeg via ffmpeg
  const ff = findFfmpeg();
  if (!ff) {
    logger.warn('[cover] ffmpeg not found — cannot convert webp artwork; embedding raw bytes');
    return { buffer, mime: isWebp ? 'image/webp' : 'image/jpeg' };
  }
  const tmpIn  = path.join(os.tmpdir(), `hp_cover_${process.pid}_${Date.now()}.in`);
  const tmpOut = path.join(os.tmpdir(), `hp_cover_${process.pid}_${Date.now()}.jpg`);
  try {
    fs.writeFileSync(tmpIn, buffer);
    execFileSync(ff, ['-y', '-loglevel', 'error', '-i', tmpIn, '-frames:v', '1', '-q:v', '2', tmpOut], { stdio: 'ignore' });
    const out = fs.readFileSync(tmpOut);
    return { buffer: out, mime: 'image/jpeg' };
  } catch (e) {
    logger.warn(`[cover] webp→jpeg conversion failed: ${e.message}`);
    return { buffer, mime: 'image/jpeg' };
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

// ─── WAV RIFF helpers ─────────────────────────────────────────────────────

// Return the ID3 tag buffer stored in a WAV's 'id3 '/'ID3 ' chunk, or null.
function readWavId3(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id.toLowerCase() === 'id3 ') return buf.slice(off + 8, Math.min(off + 8 + size, buf.length));
    off += 8 + size + (size % 2);
  }
  return null;
}

// Return a copy of the WAV buffer with any existing 'id3 ' chunks removed.
function stripWavId3(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  const keep = [buf.slice(0, 12)];
  let off = 12;
  let removed = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const total = 8 + size + (size % 2);
    if (id.toLowerCase() === 'id3 ') { removed = true; }
    else { keep.push(buf.slice(off, Math.min(off + total, buf.length))); }
    off += total;
  }
  if (!removed) return buf;
  const out = Buffer.concat(keep);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

function injectWavCover(filePath, image) {
  const id3 = NodeID3.create({
    image: { mime: image.mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: image.buffer },
  });
  let buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file');
  }
  buf = stripWavId3(buf);
  const cid = Buffer.from('id3 ', 'ascii');
  const sz = Buffer.alloc(4); sz.writeUInt32LE(id3.length, 0);
  let chunk = Buffer.concat([cid, sz, id3]);
  if (id3.length % 2 === 1) chunk = Buffer.concat([chunk, Buffer.from([0])]); // word-align
  const out = Buffer.concat([buf, chunk]);
  out.writeUInt32LE(out.length - 8, 4); // fix RIFF size
  fs.writeFileSync(filePath, out);
}

// ─── Public ───────────────────────────────────────────────────────────────

function hasExistingArt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.mp3') {
      const t = NodeID3.read(filePath);
      return !!(t && t.image && (t.image.imageBuffer ? t.image.imageBuffer.length : t.image));
    }
    if (ext === '.wav') {
      const id3 = readWavId3(fs.readFileSync(filePath));
      if (!id3) return false;
      const t = NodeID3.read(id3);
      return !!(t && t.image && (t.image.imageBuffer ? t.image.imageBuffer.length : t.image));
    }
  } catch {}
  return false;
}

/**
 * Ensure the file has cover art, fetching from artworkUrl only if it has none.
 * Never throws — cover art is best-effort and must not fail a download.
 * Returns { embedded, reason }.
 */
async function ensureCoverArt(filePath, artworkUrl, label = '') {
  const tag = label ? `[${label}] ` : '';
  const ext = path.extname(filePath).toLowerCase();

  if (!TAGGABLE.has(ext)) {
    logger.info(`[cover] ${tag}skip — ${ext || 'no ext'} not taggable for art`);
    return { embedded: false, reason: 'format' };
  }
  if (!artworkUrl) {
    logger.info(`[cover] ${tag}skip — no artwork URL found`);
    return { embedded: false, reason: 'no-url' };
  }
  if (/sndcdn\.com\/avatars/i.test(artworkUrl)) {
    // Safety net: an avatars- URL is the artist's profile photo, not cover art.
    logger.warn(`[cover] ${tag}skip — refusing to embed an artist avatar as cover art`);
    return { embedded: false, reason: 'avatar' };
  }
  if (hasExistingArt(filePath)) {
    logger.info(`[cover] ${tag}skip — file already has cover art`);
    return { embedded: false, reason: 'has-art' };
  }

  let image;
  try {
    const raw = await fetchBytes(upgradeArtworkUrl(artworkUrl));
    image = toEmbeddable(raw);
  } catch (e) {
    logger.warn(`[cover] ${tag}artwork fetch failed: ${e.message}`);
    return { embedded: false, reason: 'fetch-failed' };
  }

  try {
    if (ext === '.mp3') {
      NodeID3.update({ image: { mime: image.mime, type: { id: 3, name: 'front cover' }, description: 'Cover', imageBuffer: image.buffer } }, filePath);
    } else {
      injectWavCover(filePath, image);
    }
    logger.success(`[cover] ${tag}embedded cover art (${(image.buffer.length / 1024).toFixed(0)} KB ${image.mime})`);
    return { embedded: true, reason: 'ok' };
  } catch (e) {
    logger.warn(`[cover] ${tag}embed failed: ${e.message}`);
    return { embedded: false, reason: 'embed-failed' };
  }
}

module.exports = { ensureCoverArt, hasExistingArt, upgradeArtworkUrl };
