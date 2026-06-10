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

const LEVELS = { DEBUG: 0, INFO: 1, SUCCESS: 2, WARN: 3, ERROR: 4 };
const LEVEL_COLORS = {
  DEBUG:   '#6e7681',
  INFO:    '#58a6ff',
  SUCCESS: '#3fb950',
  WARN:    '#d29922',
  ERROR:   '#f85149',
};

const MAX_BUFFER = 2000; // keep last 2000 entries in memory

class Logger {
  constructor() {
    this._entries   = [];
    this._listeners = new Set(); // WebSocket clients
    this._logDir    = null;
    this._logFile   = null;
    this._minLevel  = LEVELS.DEBUG;
  }

  init(logDir) {
    this._logDir = logDir;
    fs.mkdirSync(logDir, { recursive: true });
    // Rotate: one file per day
    const dateStr = new Date().toISOString().slice(0, 10);
    this._logFile = path.join(logDir, `snagtrack-${dateStr}.log`);
    this._write(`\n${'='.repeat(60)}\nSession started: ${new Date().toISOString()}\n${'='.repeat(60)}\n`);
  }

  _write(text) {
    if (!this._logFile) return;
    try { fs.appendFileSync(this._logFile, text); } catch {}
  }

  _emit(entry) {
    this._entries.push(entry);
    if (this._entries.length > MAX_BUFFER) this._entries.shift();

    // Persist to file
    this._write(`[${entry.date} ${entry.time}] [${entry.level}] ${entry.message}\n`);

    // Broadcast to all connected WS clients
    const msg = JSON.stringify({ type: 'log', entry });
    for (const ws of this._listeners) {
      try { if (ws.readyState === 1) ws.send(msg); } catch {}
    }
  }

  log(level, message, meta = {}) {
    if ((LEVELS[level] ?? 99) < this._minLevel) return;
    const entry = {
      id:      Date.now() + Math.random(),
      time:    new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date:    new Date().toLocaleDateString('en-GB'),
      ts:      Date.now(),
      level,
      message: String(message),
      meta,
      color:   LEVEL_COLORS[level] ?? '#f0f6fc',
    };
    this._emit(entry);
    return entry;
  }

  debug(msg, meta)   { return this.log('DEBUG',   msg, meta); }
  info(msg, meta)    { return this.log('INFO',    msg, meta); }
  success(msg, meta) { return this.log('SUCCESS', msg, meta); }
  warn(msg, meta)    { return this.log('WARN',    msg, meta); }
  error(msg, meta)   { return this.log('ERROR',   msg, meta); }

  // Returns history for new clients that connect mid-session
  getHistory(limit = 500) {
    return this._entries.slice(-limit);
  }

  addClient(ws) {
    this._listeners.add(ws);
    // Send history on connect
    const history = this.getHistory();
    try { ws.send(JSON.stringify({ type: 'log_history', entries: history })); } catch {}
  }

  removeClient(ws) {
    this._listeners.delete(ws);
  }

  getLogs() { return [...this._entries]; }
  clearLogs() { this._entries = []; }

  getLogFile() { return this._logFile; }
  getLogDir()  { return this._logDir; }
}

module.exports = new Logger(); // singleton
