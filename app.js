/*
 * SnagTrack — Made by Karl Krusel
 * @karlkrusel on all platforms
 * Copyright (c) 2026 Karl Krusel. All rights reserved.
 * Proprietary software. Unauthorized copying, redistribution, modification, or resale is prohibited.
 */
'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const path       = require('path');
const fs         = require('fs');
const { exec, execFile, spawn } = require('child_process');
const os         = require('os');

const logger     = require('./src/logger');
const config     = require('./src/config');
const downloader = require('./src/downloader');
const browserMgr = require('./src/browser-manager');

// ─── Native folder picker ─────────────────────────────────────────────────────
// The browser can't return a real filesystem path, so the server opens the OS
// folder dialog and hands the chosen path back to the UI.
function pickFolder(initialPath) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const safeInit = String(initialPath || '').replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null;',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
        "$d.Description = 'Select download folder';",
        '$d.ShowNewFolderButton = $true;',
        safeInit ? `if (Test-Path '${safeInit}') { $d.SelectedPath = '${safeInit}' };` : '',
        // a hidden top-most form forces the dialog to the foreground
        '$t = New-Object System.Windows.Forms.Form; $t.TopMost = $true; $t.ShowInTaskbar = $false; $t.Opacity = 0; $t.Show() | Out-Null;',
        '$r = $d.ShowDialog($t); $t.Dispose();',
        "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      ].join(' ');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
        if (err) { logger.warn('Folder picker error: ' + err.message); return resolve(null); }
        resolve((stdout || '').trim() || null);
      });
    } else if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Select download folder")';
      execFile('osascript', ['-e', script], { timeout: 120000 }, (err, stdout) => {
        resolve(err ? null : (stdout || '').trim() || null);
      });
    } else {
      resolve(null);
    }
  });
}

// ─── Init logging ─────────────────────────────────────────────────────────────
const BASE_DIR = __dirname;
const LOG_DIR  = path.join(BASE_DIR, 'logs');
logger.init(LOG_DIR);

// ─── Attribution lock ─────────────────────────────────────────────────────────
// SnagTrack refuses to run if the author credit has been stripped from the UI.
(function () {
  try {
    const h = fs.readFileSync(path.join(BASE_DIR, 'public', 'index.html'), 'utf8').toLowerCase();
    if (h.indexOf('@karlkrusel') < 0 || h.indexOf('karl krusel') < 0) {
      process.stderr.write('\n  This build of SnagTrack has had its author credit removed.\n  Restore the "Made by Karl Krusel — @karlkrusel" credit to run.\n\n');
      process.exit(1);
    }
  } catch { process.exit(1); }
})();

// ─── Express app ──────────────────────────────────────────────────────────────
const app  = express();
const srv  = http.createServer(app);
const PORT = parseInt(process.env.HP_PORT) || 7766;

app.use(express.json());
app.use(express.static(path.join(BASE_DIR, 'public')));

// ─── WebSocket server ─────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: srv });

// Listen errors (e.g. port already in use) surface on BOTH srv and — because ws
// re-emits them — wss. Handle on both, dedupe so it only fires once.
let _listenErrorHandled = false;
function handleServerError(err) {
  if (_listenErrorHandled) return;
  _listenErrorHandled = true;
  const url = `http://127.0.0.1:${PORT}`;
  if (err && err.code === 'EADDRINUSE') {
    // Another instance already owns the port — open the UI for it and exit cleanly.
    process.stdout.write(`\n  SnagTrack is already running at ${url}\n  Opening it in your browser...\n\n`);
    if (!process.env.HP_NO_OPEN) {
      if (process.platform === 'win32')      exec(`start ${url}`);
      else if (process.platform === 'darwin') exec(`open ${url}`);
      else                                    exec(`xdg-open ${url}`);
    }
    setTimeout(() => process.exit(0), 1000);
  } else {
    process.stderr.write(`\n  Could not start SnagTrack: ${err && err.message}\n\n`);
    try { logger.error('Server start error: ' + (err && err.message)); } catch {}
    setTimeout(() => process.exit(1), 200);
  }
}
srv.on('error', handleServerError);
wss.on('error', handleServerError);

// ─── Auto-quit when the UI tab is closed ──────────────────────────────────────
// The UI holds a WebSocket open for its whole life. When it closes (tab closed)
// and nothing reconnects within a short grace window — so a refresh or in-app
// navigation doesn't kill the server — shut the whole program down.
// (Loopback WS connections don't blip, so an idle disconnect really means "gone".)
const AUTO_QUIT_GRACE_MS = 4000;
let _quitTimer = null;

function liveClientCount() {
  let n = 0;
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) n++;
  return n;
}
function cancelAutoQuit() {
  if (_quitTimer) { clearTimeout(_quitTimer); _quitTimer = null; }
}
function scheduleAutoQuit() {
  cancelAutoQuit();
  _quitTimer = setTimeout(() => {
    if (liveClientCount() === 0) {
      if (downloader.isRunning()) {
        logger.info('UI closed while downloads are still running — keeping SnagTrack alive.');
        scheduleAutoQuit();
        return;
      }
      logger.info('UI closed — no tabs connected, shutting down.');
      shutdown();
    }
  }, AUTO_QUIT_GRACE_MS);
}

wss.on('connection', (ws) => {
  cancelAutoQuit();
  logger.addClient(ws);
  logger.debug('UI connected');

  // Send current config and status on connect
  ws.send(JSON.stringify({ type: 'config', config: config.get() }));
  ws.send(JSON.stringify({ type: 'status', status: downloader.isRunning() ? 'running' : 'idle' }));
  ws.send(JSON.stringify({ type: 'session_status', session: downloader.getSessionStatus() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'start_downloads': {
        if (downloader.isRunning()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Already running' }));
          return;
        }
        const input = (msg.input || '').trim();
        if (!input) {
          ws.send(JSON.stringify({ type: 'error', message: 'No track IDs/URLs provided' }));
          return;
        }
        const cfg = config.get();
        if (!cfg.email) {
          ws.send(JSON.stringify({ type: 'error', message: 'Email not configured — go to Settings first' }));
          return;
        }
        // Run in background, progress pushed via WebSocket
        downloader.runBatch(input).then(summary => {
          if (summary?.error) {
            ws.send(JSON.stringify({ type: 'error', message: summary.error }));
          }
          if (liveClientCount() === 0 && !downloader.isRunning()) {
            scheduleAutoQuit();
          }
        }).catch(e => {
          logger.error('Batch error: ' + e.message);
          broadcast({ type: 'batch_error', error: e.message });
          if (liveClientCount() === 0 && !downloader.isRunning()) {
            scheduleAutoQuit();
          }
        });
        break;
      }

      case 'cancel': {
        downloader.cancel();
        break;
      }

      case 'save_config': {
        if (!msg.config) {
          logger.warn('save_config: received empty payload');
          break;
        }
        logger.debug(`save_config received — email="${msg.config.email}" name="${msg.config.name}" downloadMode="${msg.config.downloadMode}" browserEngine="${msg.config.browserEngine}"`);
        const updated = config.update(msg.config);
        logger.info(`Config saved — email="${updated.email}" dir="${updated.downloadDir}"`);
        broadcast({ type: 'config', config: updated });
        broadcast({ type: 'session_status', session: downloader.getSessionStatus() });
        break;
      }

      case 'open_folder': {
        const dir = msg.dir || config.get().downloadDir;
        fs.mkdirSync(dir, { recursive: true });
        if (process.platform === 'win32') exec(`explorer "${dir}"`);
        else if (process.platform === 'darwin') exec(`open "${dir}"`);
        else exec(`xdg-open "${dir}"`);
        break;
      }

      case 'pick_folder': {
        const target = msg.target === 'profileDir' ? 'profileDir' : 'downloadDir';
        const current = config.get()[target] || '';
        const picked = await pickFolder(current);
        ws.send(JSON.stringify({ type: 'folder_picked', target, path: picked }));
        break;
      }

      case 'open_log_folder': {
        const dir = LOG_DIR;
        if (process.platform === 'win32') exec(`explorer "${dir}"`);
        else if (process.platform === 'darwin') exec(`open "${dir}"`);
        else exec(`xdg-open "${dir}"`);
        break;
      }

      case 'clear_logs': {
        logger.clearLogs();
        broadcast({ type: 'logs_cleared' });
        break;
      }

      case 'detect_browsers': {
        const browsers = await browserMgr.detectBrowsers();
        ws.send(JSON.stringify({ type: 'browsers', browsers }));
        break;
      }

      case 'preview_chart': {
        const url = (msg.url || '').trim();
        if (!url) {
          ws.send(JSON.stringify({ type: 'error', message: 'No chart URL provided' }));
          return;
        }
        try {
          const tracks = await downloader.previewChart(url);
          ws.send(JSON.stringify({ type: 'chart_preview', url, tracks }));
        } catch (e) {
          logger.error('Chart preview failed: ' + e.message);
          ws.send(JSON.stringify({ type: 'chart_preview', url, error: e.message, tracks: [] }));
        }
        break;
      }

      case 'open_session_setup': {
        if (downloader.isRunning()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Stop the current batch before opening session setup' }));
          return;
        }
        try {
          const result = await downloader.openSessionSetup();
          ws.send(JSON.stringify({ type: 'session_setup', ...result }));
          broadcast({ type: 'session_status', session: downloader.getSessionStatus() });
        } catch (e) {
          logger.error('Session setup failed: ' + e.message);
          ws.send(JSON.stringify({ type: 'error', message: `Could not open login browser: ${e.message}` }));
        }
        break;
      }

      case 'save_session': {
        try {
          const session = await downloader.saveSessionState();
          ws.send(JSON.stringify({ type: 'session_saved', session }));
          broadcast({ type: 'session_status', session: downloader.getSessionStatus() });
        } catch (e) {
          logger.error('Session save failed: ' + e.message);
          ws.send(JSON.stringify({ type: 'error', message: `Could not save session: ${e.message}` }));
        }
        break;
      }

      case 'close_session_browser': {
        if (downloader.isRunning()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Stop the current batch before closing the browser' }));
          return;
        }
        await downloader.closeBrowser();
        ws.send(JSON.stringify({ type: 'session_closed' }));
        broadcast({ type: 'session_status', session: downloader.getSessionStatus() });
        break;
      }

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
    }
  });

  ws.on('close', () => {
    logger.removeClient(ws);
    logger.debug('UI disconnected');
    if (liveClientCount() === 0) scheduleAutoQuit();
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch {}
    }
  }
}

// Wire downloader progress → WebSocket broadcast
downloader.setProgressCallback(broadcast);

// ─── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => res.json(config.get()));
app.post('/api/config', (req, res) => res.json(config.update(req.body)));

app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  res.json({ logs: logger.getHistory(limit), file: logger.getLogFile() });
});

app.get('/api/status', (req, res) => {
  res.json({ running: downloader.isRunning(), logFile: logger.getLogFile() });
});

app.get('/api/session', (req, res) => {
  res.json(downloader.getSessionStatus());
});

app.get('/api/browsers', async (req, res) => {
  const browsers = await browserMgr.detectBrowsers();
  res.json(browsers);
});

// Serve the app
app.get('*', (req, res) => {
  res.sendFile(path.join(BASE_DIR, 'public', 'index.html'));
});

// Open the UI in a Chromium app window (Chrome/Edge) when one is available so
// it runs in a consistent engine regardless of the user's default browser and
// feels like a real app window (no tabs/address bar).
function openUI(url) {
  try {
    const exe = browserMgr.findSystemBrowser('chrome') || browserMgr.findSystemBrowser('msedge');
    if (exe) {
      spawn(exe, [`--app=${url}`, '--no-first-run', '--no-default-browser-check'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      }).unref();
      return;
    }
  } catch {}
  // Fallback: default browser
  if (process.platform === 'win32')      exec(`start ${url}`);
  else if (process.platform === 'darwin') exec(`open ${url}`);
  else                                    exec(`xdg-open ${url}`);
}

// ─── Start ────────────────────────────────────────────────────────────────────
srv.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  logger.info(`SnagTrack running at ${url}`);
  console.log(`\n  SnagTrack — http://127.0.0.1:${PORT}\n`);
  console.log(`  Opening in your default browser...`);
  console.log(`  Press Ctrl+C to stop.\n`);

  // Open the UI after a short delay (skip with HP_NO_OPEN=1)
  if (!process.env.HP_NO_OPEN) {
    setTimeout(() => openUI(url), 600);
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Closes everything we can: cancels any batch, closes the Playwright download
// browser, and kills the manual-login Chrome (taskkill /T). Fires on Ctrl+C,
// Ctrl+Break, SIGTERM, and — importantly on Windows — SIGHUP, which Node emits
// when the CMD window is closed. Idempotent, with a hard force-exit backstop so
// it can never hang the close.
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { logger.info(`Shutting down${signal ? ' (' + signal + ')' : ''} — closing browser(s)...`); } catch {}

  const force = setTimeout(() => { try { process.exit(0); } catch {} }, 5000);
  if (force.unref) force.unref();

  try {
    downloader.cancel();
    await downloader.shutdown(); // closes Playwright context + manual-login Chrome
  } catch (e) {
    try { logger.error('Shutdown error: ' + (e && e.message)); } catch {}
  }
  clearTimeout(force);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));   // Ctrl+C
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));    // CMD window closed (Windows)
process.on('SIGBREAK',() => shutdown('SIGBREAK'));  // Ctrl+Break (Windows)
process.on('uncaughtException',  e => logger.error('Uncaught: ' + e.message));
process.on('unhandledRejection', e => logger.error('Unhandled: ' + (e?.message || e)));
