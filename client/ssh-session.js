'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require('ssh2');

// SSH runs in the Electron main process, never in the remote site's context.
// The user confirms the server key before any password is sent.
function createSshSession({ verifyHost, emit, chooseUpload, chooseDownload, confirmOverwrite, makeClient = () => new Client() }) {
  let current = null;
  function send(state, type, extra = {}) { if (state === current) emit({ id: state.id, type, ...extra }); }
  function close(id) {
    if (!current || (id && current.id !== id)) return;
    const state = current; current = null;
    try { state.channel?.close(); } catch {}
    try { state.client.end(); } catch {}
  }
  function get(id, mode) {
    if (!current || current.id !== id || !current.ready || (mode && current.mode !== mode)) throw new Error('SSH-сеанс не подключён.');
    return current;
  }
  function validPath(value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Недопустимый путь.');
    return value;
  }
  function open(options) {
    const host = String(options?.host || '').trim(); const username = String(options?.username || '').trim();
    const password = options?.password; const port = Number(options?.port || 22); const mode = options?.mode;
    if (!host || host.length > 253 || /[\s/@?#\x00-\x1f]/.test(host) || !username || username.length > 256 || /[\x00-\x1f\x7f]/.test(username) || typeof password !== 'string' || Buffer.byteLength(password) > 8192 || !Number.isInteger(port) || port < 1 || port > 65535 || !['ssh', 'sftp'].includes(mode)) throw new Error('Некорректные параметры SSH.');
    close();
    const state = { id: crypto.randomUUID(), client: makeClient(), mode, ready: false, channel: null, sftp: null, busy: false };
    current = state;
    const fail = (err) => { if (current !== state) return; send(state, 'error', { message: String(err?.message || 'Ошибка SSH').slice(0, 500) }); close(state.id); };
    state.client.on('error', fail);
    state.client.on('close', () => { if (current === state) { send(state, 'close'); current = null; } });
    state.client.on('ready', () => {
      if (current !== state) return;
      if (mode === 'ssh') {
        state.client.shell({ term: 'xterm-256color', cols: 100, rows: 30 }, (err, channel) => {
          if (current !== state) { channel?.close(); return; }
          if (err) return fail(err);
          state.channel = channel; state.ready = true;
          send(state, 'ready');
          channel.on('data', (data) => send(state, 'data', { bytes: new Uint8Array(data) }));
          channel.stderr.on('data', (data) => send(state, 'data', { bytes: new Uint8Array(data) }));
          channel.on('close', () => { if (current === state) { send(state, 'close'); close(state.id); } });
        });
      } else {
        state.client.sftp((err, sftp) => {
          if (current !== state) { sftp?.end(); return; }
          if (err) return fail(err);
          state.sftp = sftp; state.ready = true; send(state, 'ready');
        });
      }
    });
    // Give the renderer time to subscribe and associate the returned id.
    setImmediate(() => {
      if (current !== state) return;
      try {
        state.client.connect({ host, port, username, password, readyTimeout: 20000, hostHash: 'sha256', hostVerifier: (hex, callback) => {
          if (current !== state || !/^[0-9a-f]{64}$/i.test(hex)) { callback(false); return; }
          const fingerprint = `SHA256:${Buffer.from(hex, 'hex').toString('base64').replace(/=+$/, '')}`;
          Promise.resolve().then(() => verifyHost({ host, port, fingerprint })).then((accepted) => callback(current === state && accepted === true), () => callback(false));
        } });
      } catch (error) { fail(error); }
    });
    return { id: state.id };
  }
  function write(id, data) {
    const state = get(id, 'ssh');
    if (typeof data !== 'string' || Buffer.byteLength(data) > 65536) throw new Error('Недопустимый ввод терминала.');
    state.channel.write(data);
  }
  function resize(id, cols, rows) {
    const state = get(id, 'ssh');
    if (!Number.isInteger(cols) || cols < 2 || cols > 1000 || !Number.isInteger(rows) || rows < 2 || rows > 1000) throw new Error('Недопустимый размер терминала.');
    state.channel.setWindow(rows, cols, 0, 0);
  }
  async function list(id, directory) {
    const state = get(id, 'sftp'); validPath(directory);
    const realpath = await new Promise((resolve, reject) => state.sftp.realpath(directory, (err, value) => err ? reject(err) : resolve(value)));
    const files = await new Promise((resolve, reject) => state.sftp.readdir(realpath, (err, value) => err ? reject(err) : resolve(value)));
    if (current !== state) throw new Error('SSH-сеанс закрыт.');
    if (files.length > 10000) throw new Error('Слишком много файлов в каталоге.');
    return { path: realpath, files: files.filter((x) => x.filename !== '.' && x.filename !== '..').map((x) => ({ name: x.filename, directory: x.attrs.isDirectory(), size: x.attrs.size, modified: x.attrs.mtime })) };
  }
  async function transfer(id, remote, direction) {
    const state = get(id, 'sftp'); validPath(remote);
    if (state.busy) throw new Error('Другая передача ещё выполняется.');
    state.busy = true; let tmp = null;
    try {
      if (direction === 'upload') {
        const local = await chooseUpload(); if (!local) return { cancelled: true };
        if (current !== state) throw new Error('SSH-сеанс закрыт.');
        const target = path.posix.join(remote, path.basename(local));
        const existing = await new Promise((resolve, reject) => state.sftp.stat(target, (err, attrs) => {
          if (err && err.code === 2) return resolve(null);
          if (err) return reject(err);
          resolve(attrs);
        }));
        if (existing && (existing.isDirectory() || !await confirmOverwrite(target))) return { cancelled: true };
        if (current !== state) throw new Error('SSH-сеанс закрыт.');
        await new Promise((resolve, reject) => state.sftp.fastPut(local, target, { step: (done, _chunk, total) => send(state, 'progress', { done, total, direction }) }, (err) => err ? reject(err) : resolve()));
      } else if (direction === 'download') {
        const local = await chooseDownload(path.posix.basename(remote)); if (!local) return { cancelled: true };
        if (current !== state) throw new Error('SSH-сеанс закрыт.');
        tmp = path.join(path.dirname(local), `.${path.basename(local)}.${crypto.randomUUID()}.part`);
        await new Promise((resolve, reject) => state.sftp.fastGet(remote, tmp, { step: (done, _chunk, total) => send(state, 'progress', { done, total, direction }) }, (err) => err ? reject(err) : resolve()));
        if (current !== state) throw new Error('SSH-сеанс закрыт.');
        await fs.rename(tmp, local); tmp = null;
      } else throw new Error('Неизвестное направление передачи.');
      return { ok: true };
    } finally { state.busy = false; if (tmp) await fs.rm(tmp, { force: true }).catch(() => {}); }
  }
  return { open, close, write, resize, list, transfer };
}
module.exports = { createSshSession };
