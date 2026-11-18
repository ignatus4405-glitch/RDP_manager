'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

function createFileLogger(logDirectory, { filename = 'server.log', maxBytes = 5 * 1024 * 1024, keepFiles = 5 } = {}) {
  if (!logDirectory) return null;
  fs.mkdirSync(logDirectory, { recursive: true });
  const filePath = path.join(logDirectory, filename);

  function rotate(incomingBytes) {
    let currentSize = 0;
    try { currentSize = fs.statSync(filePath).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (currentSize === 0 || currentSize + incomingBytes <= maxBytes) return;

    try { fs.unlinkSync(`${filePath}.${keepFiles}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let index = keepFiles - 1; index >= 1; index -= 1) {
      try { fs.renameSync(`${filePath}.${index}`, `${filePath}.${index + 1}`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try { fs.renameSync(filePath, `${filePath}.1`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  return {
    filePath,
    write(level, message) {
      const entry = `${new Date().toISOString()} [${level}] ${String(message)}\r\n`;
      rotate(Buffer.byteLength(entry));
      fs.appendFileSync(filePath, entry, { encoding: 'utf8' });
    },
  };
}

function installConsoleFileLogger({ logDirectory = process.env.RDP_MANAGER_LOG_DIR, ...options } = {}) {
  const logger = createFileLogger(logDirectory, options);
  if (!logger) return null;

  const original = {};
  const levels = { log: 'INFO', info: 'INFO', warn: 'WARN', error: 'ERROR' };
  for (const [method, level] of Object.entries(levels)) {
    original[method] = console[method];
    console[method] = (...args) => {
      original[method].apply(console, args);
      try { logger.write(level, util.format(...args)); } catch { /* Logging must never take the server down. */ }
    };
  }

  return {
    filePath: logger.filePath,
    restore() {
      for (const method of Object.keys(original)) console[method] = original[method];
    },
  };
}

module.exports = { createFileLogger, installConsoleFileLogger };
