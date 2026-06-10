/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BASE_DIR = __dirname.replace(/[\\/]src$/, '');

const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

const DEFAULTS = {
  email:       '',
  name:        '',
  downloadDir: path.join(os.homedir(), 'Downloads', 'Hypeddit'),
  cookiesFile: path.join(BASE_DIR, 'cookies.json'),
  sessionFile: path.join(BASE_DIR, 'session.json'),
  profileDir:  path.join(BASE_DIR, 'browser-profile'),

  // 'hybrid' | 'browser' | 'direct'
  downloadMode: 'hybrid',
  // 'auto' | 'chromium' | 'chrome' | 'msedge' | 'firefox' | 'webkit'
  browserEngine: 'auto',
  headlessDownloads: false,

  // Embed SoundCloud cover art into downloads that have none
  coverArt: true,

  delays: {
    pageLoad:       400,
    afterGateOpen:  250,
    afterEmailStep: 900,
    afterScPopup:   35000,
    afterSpPopup:   20000,
    scPopupTimeout: 60000,
    spPopupTimeout: 45000,
    betweenTracks:  1000,
  },
};

function load() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      const migrated = migrateLegacyConfig(saved);
      return {
        ...DEFAULTS,
        ...migrated,
        delays: { ...DEFAULTS.delays, ...(migrated.delays || {}) },
      };
    }
  } catch {}
  return { ...DEFAULTS, delays: { ...DEFAULTS.delays } };
}

function save(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

function get() { return _cfg; }

function update(patch) {
  if (!patch || typeof patch !== 'object') return _cfg;
  // Merge top-level fields
  for (const key of Object.keys(patch)) {
    if (key === 'delays') continue; // handled below
    _cfg[key] = patch[key];
  }
  // Deep-merge delays
  if (patch.delays && typeof patch.delays === 'object') {
    _cfg.delays = { ..._cfg.delays, ...patch.delays };
  }
  save(_cfg);
  return _cfg;
}

function migrateLegacyConfig(saved) {
  const migrated = { ...saved };

  if (!migrated.downloadMode || !migrated.browserEngine) {
    const legacyMode = migrated.browserMode;
    switch (legacyMode) {
      case 'direct':
        migrated.downloadMode = 'direct';
        migrated.browserEngine = 'auto';
        break;
      case 'chrome':
      case 'msedge':
      case 'chromium':
      case 'firefox':
      case 'webkit':
        migrated.downloadMode = 'browser';
        migrated.browserEngine = legacyMode;
        break;
      default:
        migrated.downloadMode = migrated.downloadMode || 'hybrid';
        migrated.browserEngine = migrated.browserEngine || 'auto';
        break;
    }
  }

  if (!migrated.profileDir) {
    migrated.profileDir = DEFAULTS.profileDir;
  }

  if (typeof migrated.headlessDownloads !== 'boolean') {
    migrated.headlessDownloads = DEFAULTS.headlessDownloads;
  }

  delete migrated.browserMode;
  return migrated;
}

let _cfg = load();

module.exports = { get, update, save, load, DEFAULTS, migrateLegacyConfig };
