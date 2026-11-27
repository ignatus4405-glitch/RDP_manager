'use strict';

const fs = require('fs');
const net = require('node:net');
const { DOMParser } = require('@xmldom/xmldom');

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

// WinSW configuration is trusted local configuration, but it must not be
// interpreted as an arbitrary URL. Never open a guessed HTTP address when the
// XML is malformed or a TLS setting is ambiguous.
function serverPanelUrl(xml, inherited = {}) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 1024 * 1024 || /<!DOCTYPE/i.test(xml)) throw new Error('Некорректная конфигурация службы.');
  const errors = [];
  const doc = new DOMParser({ errorHandler: { warning: (e) => errors.push(e), error: (e) => errors.push(e), fatalError: (e) => errors.push(e) } }).parseFromString(xml, 'application/xml');
  if (errors.length || doc.documentElement?.tagName !== 'service') throw new Error('Не удалось прочитать конфигурацию службы.');
  const vars = {};
  for (const [key, value] of Object.entries(inherited)) if (typeof value === 'string') vars[key.toUpperCase()] = value;
  const configured = new Set();
  for (let node = doc.documentElement.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1 || node.tagName !== 'env') continue;
    const name = node.getAttribute('name').toUpperCase();
    if (!['RDP_MANAGER_HOST', 'RDP_MANAGER_PORT', 'RDP_MANAGER_TLS_CERT', 'RDP_MANAGER_TLS_KEY'].includes(name)) continue;
    if (configured.has(name) || !node.hasAttribute('value')) throw new Error('Неоднозначные настройки службы.');
    configured.add(name);
    const raw = node.getAttribute('value');
    vars[name] = raw.replace(/%([^%]+)%/g, (_match, variable) => {
      const value = vars[variable.toUpperCase()];
      if (value === undefined) throw new Error(`Не удалось определить переменную ${variable} в настройках службы.`);
      return value;
    });
    if (/%[^%]+%/.test(vars[name])) throw new Error('Переменная в настройках службы не разрешена.');
  }
  let host = vars.RDP_MANAGER_HOST || '0.0.0.0';
  const portText = vars.RDP_MANAGER_PORT || '8720';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Некорректный порт в настройках службы.');
  const cert = vars.RDP_MANAGER_TLS_CERT || '', key = vars.RDP_MANAGER_TLS_KEY || '';
  if (Boolean(cert) !== Boolean(key)) throw new Error('Для HTTPS в настройках службы нужны сертификат и ключ.');
  if (host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]') host = '::1';
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const ipVersion = net.isIP(host);
  if (!ipVersion && !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(?:\.(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*\.?$/.test(host)) throw new Error('Некорректный адрес в настройках службы.');
  const authority = ipVersion === 6 ? `[${host}]` : host;
  return `${cert ? 'https' : 'http'}://${authority}:${Number(portText)}/`;
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

module.exports = { SERVICE_STATE_NAMES, compareVersions, parseServiceStatus, readLogTail, serverPanelUrl };
