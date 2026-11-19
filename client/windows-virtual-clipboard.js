'use strict';
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const crypto = require('node:crypto');
const { validateParts } = require('./rdp-clipboard-receiver');

function createWindowsVirtualClipboard({ executable, sendRequest, spawnProcess = spawn }) {
  let active = null;
  function clear(token) {
    if (token !== undefined && active?.token !== token) return;
    const previous = active;
    active = null;
    if (previous) previous.child.kill();
  }
  function isActive() { return Boolean(active); }
  async function publish(files) {
    if (!Array.isArray(files) || !files.length) throw new Error('Нет файлов для публикации.');
    const seen = new Set();
    const descriptors = files.map((file) => {
      const parts = validateParts(file);
      const relative = parts.join('\\');
      const key = relative.toLowerCase();
      if (seen.has(key) || relative.length >= 260 || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Некорректные метаданные файла.');
      seen.add(key);
      return { relative, size: file.size, directory: Boolean(file.isDirectory) };
    });
    clear();
    const child = spawnProcess(executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, token: crypto.randomUUID(), ready: false, armed: false, pending: null, descriptors };
    active = state;
    let settle;
    const ready = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    const timer = setTimeout(() => { if (active === state) clear(); settle.reject(new Error('Не удалось запустить Windows OLE-буфер.')); }, 10000);
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-2048); });
    child.on('error', (error) => { clearTimeout(timer); if (active === state) active = null; settle.reject(error); });
    child.on('exit', () => {
      clearTimeout(timer);
      lines.close();
      if (active === state) active = null;
      settle.reject(new Error(`Windows OLE-буфер завершён${stderr ? `: ${stderr}` : '.'}`));
    });
    child.stdin.on('error', () => {});
    lines.on('line', (line) => {
      if (active !== state) return;
      if (line === 'READY' && !state.ready) { state.ready = true; clearTimeout(timer); settle.resolve(state.token); return; }
      const match = /^READ (\d+) (\d+) (\d+)$/.exec(line);
      if (!state.ready || !match || state.pending) { clear(); return; }
      const index = Number(match[1]); const position = Number(match[2]); const size = Number(match[3]);
      const file = descriptors[index];
      if (!Number.isSafeInteger(index) || !Number.isSafeInteger(position) || !file || file.directory || position < 0 || position > file.size || !Number.isSafeInteger(size) || size < 1 || size > 65536 || position + size > file.size) { clear(); return; }
      const requestId = crypto.randomUUID();
      state.pending = { requestId, size, request: { token: state.token, requestId, index, position, size } };
      if (state.armed) {
        try { sendRequest(state.pending.request); }
        catch { clear(); }
      }
    });
    child.stdin.write(`${descriptors.length}\n` + descriptors.map((file) => `${file.size} ${file.directory ? 1 : 0} ${Buffer.from(file.relative, 'utf8').toString('base64')}\n`).join(''));
    return ready;
  }
  function activate(token) {
    const state = active;
    if (!state || !state.ready || state.token !== token) throw new Error('Буфер обмена изменился.');
    state.armed = true;
    if (state.pending) sendRequest(state.pending.request);
  }
  function respond({ token, requestId, bytes, error }) {
    const state = active;
    if (!state || state.token !== token || !state.pending || state.pending.requestId !== requestId) return false;
    const pending = state.pending;
    state.pending = null;
    if (error || !(bytes instanceof Uint8Array) || bytes.byteLength > pending.size || !bytes.byteLength) state.child.stdin.write('-\n');
    else state.child.stdin.write(`+${Buffer.from(bytes).toString('base64')}\n`);
    return true;
  }
  return { publish, clear, isActive, activate, respond };
}
module.exports = { createWindowsVirtualClipboard };
