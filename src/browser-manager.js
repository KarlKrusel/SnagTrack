/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

const { spawn } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const logger  = require('./logger');
const config  = require('./config');

// Playwright is loaded lazily so the app starts even if not installed
let pw = null;
let manualLoginProc = null;
function getPlaywright() {
  if (!pw) pw = require('playwright');
  return pw;
}

// Known system browser paths (Windows)
const SYSTEM_PATHS = {
  chrome: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
  ],
  msedge: [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  firefox: [
    'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
    'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
  ],
};

function findSystemBrowser(type) {
  const paths = SYSTEM_PATHS[type] || [];
  return paths.find(p => fs.existsSync(p)) || null;
}

function getProfileDir() {
  const cfg = config.get();
  const dir = cfg.profileDir || path.join(process.cwd(), 'browser-profile');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDesktopBrowserArgs(args = []) {
  return [
    ...args,
    '--mute-audio',
    '--start-minimized',
  ];
}

function getChromiumLaunchTuning(opts = {}) {
  return {
    ...opts,
    ignoreDefaultArgs: [
      '--enable-automation',
    ],
    args: getDesktopBrowserArgs([
      ...(opts.args || []),
      '--disable-blink-features=AutomationControlled',
    ]),
  };
}

function getManualLoginBrowser() {
  const chrome = findSystemBrowser('chrome');
  if (chrome) return { type: 'chrome', executable: chrome };

  const edge = findSystemBrowser('msedge');
  if (edge) return { type: 'msedge', executable: edge };

  return null;
}

// Detect which browsers are available
async function detectBrowsers() {
  const result = { chromium: false, chrome: false, msedge: false, firefox: false, webkit: false };
  const p = getPlaywright();

  // Playwright-bundled binaries
  for (const t of ['chromium', 'firefox', 'webkit']) {
    try {
      const browser = await p[t].launch({ headless: true });
      await browser.close();
      result[t] = true;
    } catch {}
  }

  // System installations
  if (findSystemBrowser('chrome'))  result.chrome  = true;
  if (findSystemBrowser('msedge'))  result.msedge  = true;
  if (findSystemBrowser('firefox')) result.firefox = result.firefox || true;

  return result;
}

// Launch a browser based on the browserMode config
async function launch(options = {}) {
  const cfg = config.get();
  const purpose = options.purpose || 'download';
  const mode = options.engine || cfg.browserEngine || 'auto';
  const p    = getPlaywright();

  logger.info(`Launching browser profile — engine: ${mode}, purpose: ${purpose}`);

  const launchOpts = {
    headless: purpose === 'session' ? false : !!cfg.headlessDownloads,
    slowMo: purpose === 'session' ? 50 : 0,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  };

  if (mode === 'auto') {
    // Prefer system Chrome, then bundled Chromium, then Edge.
    // System Firefox is last — Playwright uses its own juggler protocol which
    // requires the bundled Firefox binary; system Firefox exits immediately.
    const order = ['chrome', 'chromium', 'msedge', 'firefox'];
    for (const m of order) {
      try {
        return await launchByMode(m, p, launchOpts);
      } catch (e) {
        logger.debug(`Auto: ${m} unavailable — ${e.message.split('\n')[0]}`);
      }
    }
    throw new Error('No browser found. Run: npx playwright install chromium');
  }

  return launchByMode(mode, p, launchOpts);
}

async function launchByMode(mode, p, opts) {
  const userDataDir = getProfileDir();

  switch (mode) {
    case 'chrome': {
      const exe = findSystemBrowser('chrome');
      if (!exe) throw new Error('Chrome not found');
      logger.info(`Using system Chrome: ${exe}`);
      return p.chromium.launchPersistentContext(userDataDir, getChromiumLaunchTuning({ ...opts, channel: 'chrome' }));
    }
    case 'msedge': {
      const exe = findSystemBrowser('msedge');
      if (!exe) throw new Error('Edge not found');
      logger.info(`Using system Edge: ${exe}`);
      return p.chromium.launchPersistentContext(userDataDir, getChromiumLaunchTuning({ ...opts, channel: 'msedge' }));
    }
    case 'chromium': {
      logger.info('Using Playwright Chromium');
      return p.chromium.launchPersistentContext(userDataDir, getChromiumLaunchTuning(opts));
    }
    case 'firefox': {
      const exe = findSystemBrowser('firefox');
      logger.info(exe ? `Using system Firefox: ${exe}` : 'Using Playwright Firefox');
      return p.firefox.launchPersistentContext(userDataDir, exe ? { ...opts, executablePath: exe } : opts);
    }
    case 'webkit': {
      logger.info('Using WebKit');
      return p.webkit.launchPersistentContext(userDataDir, opts);
    }
    default:
      throw new Error(`Unknown browser engine: ${mode}`);
  }
}

// Load saved session into a browser context.
// Supports full Playwright storageState format (cookies + localStorage/origins)
// as well as the older cookies-only format.
async function loadSession(context) {
  const cfg = config.get();
  const sessionFile = cfg.sessionFile;

  if (fs.existsSync(sessionFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));

      // Full storageState format: { cookies, origins }
      if (state.cookies?.length) {
        await context.addCookies(state.cookies).catch(e => logger.warn(`addCookies: ${e.message}`));
        logger.debug(`Loaded ${state.cookies.length} session cookies`);
      }
      // Restore localStorage / sessionStorage if present
      if (state.origins?.length) {
        for (const origin of state.origins) {
          if (!origin.localStorage?.length) continue;
          try {
            await context.addInitScript(({ o }) => {
              if (location.origin === o.origin) {
                for (const { name, value } of o.localStorage) {
                  localStorage.setItem(name, value);
                }
              }
            }, { o: origin });
          } catch {}
        }
        logger.debug(`Restored localStorage for ${state.origins.length} origins`);
      }
    } catch (e) {
      logger.warn(`Could not load session: ${e.message}`);
    }
  }

  // Also load manually exported cookies (e.g. from cookie-editor extension)
  const cookiesFile = cfg.cookiesFile;
  if (fs.existsSync(cookiesFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
      if (Array.isArray(raw)) {
        const pwCookies = raw
          .filter(c => c.name && c.value)
          .map(c => ({
            name:     c.name,
            value:    c.value,
            domain:   c.domain || c.host || '',
            path:     c.path  || '/',
            secure:   !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: 'None',
          }));
        await context.addCookies(pwCookies).catch(() => {});
        logger.debug(`Imported ${pwCookies.length} manual cookies from ${cookiesFile}`);
      }
    } catch {}
  }
}

async function hardenContext(context) {
  try {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      } catch {}
      try {
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      } catch {}
      try {
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      } catch {}
      try {
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = {};
      } catch {}
    });
  } catch (e) {
    logger.warn(`Could not harden browser context: ${e.message}`);
  }
}

function openManualLoginBrowser(urls = []) {
  if (manualLoginProc && !manualLoginProc.killed) {
    return {
      ok: true,
      alreadyOpen: true,
      pid: manualLoginProc.pid,
      profileDir: getProfileDir(),
    };
  }

  const browser = getManualLoginBrowser();
  if (!browser) {
    throw new Error('No supported system browser found for manual login');
  }

  const profileDir = getProfileDir();
  const args = getDesktopBrowserArgs([
    `--user-data-dir=${profileDir}`,
    '--new-window',
    '--no-first-run',
    '--no-default-browser-check',
    ...urls,
  ]);

  const proc = spawn(browser.executable, args, {
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  });

  proc.on('exit', () => {
    if (manualLoginProc?.pid === proc.pid) {
      manualLoginProc = null;
    }
  });

  manualLoginProc = proc;
  proc.unref();

  logger.info(`Opened manual login browser (${browser.type}) using profile ${profileDir}`);
  return {
    ok: true,
    alreadyOpen: false,
    pid: proc.pid,
    profileDir,
  };
}

function isManualLoginBrowserOpen() {
  return !!(manualLoginProc && !manualLoginProc.killed);
}

function closeManualLoginBrowser() {
  if (!manualLoginProc || manualLoginProc.killed) return false;

  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(manualLoginProc.pid), '/T', '/F'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else {
      manualLoginProc.kill('SIGTERM');
    }
  } catch {}

  manualLoginProc = null;
  return true;
}

// Save full Playwright storageState (cookies + localStorage origins)
async function saveSession(context) {
  try {
    const state = await context.storageState();
    const cfg = config.get();
    fs.writeFileSync(cfg.sessionFile, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
    logger.debug(`Saved session: ${state.cookies?.length ?? 0} cookies, ${state.origins?.length ?? 0} origins`);
  } catch (e) {
    logger.warn(`Could not save session: ${e.message}`);
  }
}

function getSessionStatus() {
  const cfg = config.get();
  const state = {
    profileDir: cfg.profileDir,
    profileExists: false,
    sessionFile: cfg.sessionFile,
    sessionExists: false,
    sessionSavedAt: null,
    cookieFile: cfg.cookiesFile,
    cookieFileExists: fs.existsSync(cfg.cookiesFile),
    manualLoginBrowserOpen: isManualLoginBrowserOpen(),
  };

  try {
    state.profileExists = fs.existsSync(cfg.profileDir)
      && fs.readdirSync(cfg.profileDir).some(name => name && !name.startsWith('.'));
  } catch {}

  if (fs.existsSync(cfg.sessionFile)) {
    state.sessionExists = true;
    try {
      const raw = JSON.parse(fs.readFileSync(cfg.sessionFile, 'utf8'));
      state.sessionSavedAt = raw.savedAt || null;
    } catch {}
  }

  return state;
}

module.exports = {
  launch,
  loadSession,
  hardenContext,
  openManualLoginBrowser,
  closeManualLoginBrowser,
  isManualLoginBrowserOpen,
  saveSession,
  detectBrowsers,
  findSystemBrowser,
  getProfileDir,
  getSessionStatus,
};
