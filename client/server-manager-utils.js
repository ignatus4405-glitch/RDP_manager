'use strict';

const fs = require('fs');

const SERVICE_STATE_NAMES = Object.freeze({
  1: 'stopped',
  2: 'start-pending',
  3: 'stop-pending',
  4: 'running',
  5: 'continue-pending',
  6: 'pause-pending',
  7: 'paused',
});

function parseServiceStatus(output, exitCode = 0) {
  const text = String(output || '');
  // sc.exe uses the Windows OEM code page. Localized field names may be
  // undecodable as UTF-8, but its numeric state and symbolic name are ASCII.
  const stateMatch = Number(exitCode) === 0 && (
    text.match(/(?:STATE|СОСТОЯНИЕ)\s*:\s*(\d+)\b/i) ||
    text.match(/:\s*([1-7])\s+(?:STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/i)
  );
  if (stateMatch) {
    const code = Number(stateMatch[1]);
    return { installed: true, state: SERVICE_STATE_NAMES[code] || 'unknown', stateCode: code };
  }

  if (Number(exitCode) === 1060 || /(?:FAILED\s+1060|error\s+1060|не существует.*служб)/i.test(text)) {
    return { installed: false, state: 'not-installed', stateCode: null };
  }

  return { installed: false, state: 'unknown', stateCode: null, error: text.trim() || `sc.exe завершился с кодом ${exitCode}` };
}

function readLogTail(filePath, { maxBytes = 512 * 1024, maxLines = 1200 } = {}) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const bytesToRead = Math.min(stat.size, Math.max(1, maxBytes));
    const buffer = Buffer.alloc(bytesToRead);
    const start = Math.max(0, stat.size - bytesToRead);
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, start);
    let text = buffer.subarray(0, bytesRead).toString('utf8');
    const truncated = start > 0;
    if (truncated) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : text;
    }
    const lines = text.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    const clipped = lines.length > maxLines;
    if (clipped) text = lines.slice(-maxLines).join('\n');
    return {
      exists: true,
      text: text.trimEnd(),
      truncated: truncated || clipped,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { exists: false, text: '', truncated: false, modifiedAt: null };
    }
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function compareVersions(left, right) {
  const parse = (version) => String(version || '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = (a[index] || 0) - (b[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

module.exports = { SERVICE_STATE_NAMES, compareVersions, parseServiceStatus, readLogTail };
