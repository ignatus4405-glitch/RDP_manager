'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const { TextDecoder } = require('node:util');
const LIMIT = 2 * 1024 * 1024;
const CHUNK = 32768;
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const call = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (err, ...values) => err ? reject(err) : resolve(values)));

// This editor intentionally modifies an existing regular file in place, so its
// ownership, permissions and ACLs are retained. SFTP has no compare-and-swap;
// the conflict check is best-effort and writing is not atomic.
function createSftpEditor({ getState, isCurrent }) {
  let editor = null, epoch = 0;
  function reset() { epoch++; editor = null; }
  function check(state) { if (!isCurrent(state)) throw new Error('SFTP-сеанс закрыт.'); }
  function validate(side, dir, name) {
    if (!['local', 'remote'].includes(side) || typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir) || (side === 'local' ? !path.isAbsolute(dir) : !dir.startsWith('/'))) throw new Error('Недопустимый путь.');
    if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error('Недопустимое имя файла.');
    if (side === 'local' && process.platform === 'win32' && (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name))) throw new Error('Имя файла не поддерживается Windows.');
    return side === 'local' ? path.join(dir, name) : path.posix.join(dir, name);
  }
  function metadata(stat, side) {
    if (!stat?.isFile()) throw new Error('Можно изменять только обычные файлы, не ссылки и не папки.');
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > LIMIT) throw new Error('Размер файла превышает 2 МиБ или неизвестен.');
    return side === 'local' ? [stat.size, stat.mtimeMs, stat.dev, stat.ino, stat.mode] : [stat.size, stat.mtime, stat.mode, stat.uid, stat.gid];
  }
  async function withHandle(state, side, filename, writable, fn) {
    check(state);
    if (side === 'local') {
      const before = await fs.lstat(filename); metadata(before, side);
      // Reject symlinks explicitly and, where available, prevent a symlink swap.
      const flags = (writable ? fsConstants.O_RDWR : fsConstants.O_RDONLY) | (fsConstants.O_NOFOLLOW || 0);
      const handle = await fs.open(filename, flags);
      try {
        const stat = await handle.stat();
        if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('Файл изменился при открытии.');
        return await fn({
          stat: () => handle.stat(),
          read: async (buffer, position) => (await handle.read(buffer, 0, buffer.length, position)).bytesRead,
          write: async (buffer, position) => (await handle.write(buffer, 0, buffer.length, position)).bytesWritten,
          truncate: (size) => handle.truncate(size),
        });
      } finally { await handle.close(); }
    }
    const sftp = state.sftp;
    const [before] = await call(sftp, 'lstat', filename); metadata(before, side); check(state);
    const [handle] = await call(sftp, 'open', filename, writable ? 'r+' : 'r');
    try {
      const [after] = await call(sftp, 'fstat', handle);
      if (JSON.stringify(metadata(before, side)) !== JSON.stringify(metadata(after, side))) throw new Error('Файл изменился при открытии.');
      return await fn({
        stat: async () => (await call(sftp, 'fstat', handle))[0],
        read: async (buffer, position) => (await call(sftp, 'read', handle, buffer, 0, buffer.length, position))[0],
        write: async (buffer, position) => { await call(sftp, 'write', handle, buffer, 0, buffer.length, position); return buffer.length; },
        truncate: async (size) => { await call(sftp, 'fsetstat', handle, { size }); },
      });
    } finally { await call(sftp, 'close', handle).catch(() => {}); }
  }
  async function readAll(io, state) {
    const pieces = []; let length = 0;
    while (true) {
      check(state); const buffer = Buffer.alloc(Math.min(CHUNK, LIMIT + 1 - length));
      const n = await io.read(buffer, length); if (!Number.isInteger(n) || n < 0 || n > buffer.length) throw new Error('Некорректный ответ чтения.');
      if (!n) break; length += n; if (length > LIMIT) throw new Error('Размер файла превышает 2 МиБ.');
      pieces.push(buffer.subarray(0, n));
    }
    return Buffer.concat(pieces, length);
  }
  function decode(bytes) {
    if (bytes.includes(0)) throw new Error('Двоичные файлы редактировать нельзя.');
    let text; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new Error('Поддерживаются только текстовые файлы в UTF-8.'); }
    if (/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('Двоичные файлы редактировать нельзя.');
    const bom = text.startsWith('\ufeff'); if (bom) text = text.slice(1);
    const hasCRLF = text.includes('\r\n');
    if (/\r(?!\n)/.test(text) || (hasCRLF && /(^|[^\r])\n/.test(text))) throw new Error('Смешанные или неподдерживаемые окончания строк.');
    return { text: text.replace(/\r\n/g, '\n'), bom, crlf: hasCRLF };
  }
  async function open(id, side, dir, name) {
    const state = getState(id); const filename = validate(side, dir, name); if (state.busy) throw new Error('Другая операция ещё выполняется.');
    state.busy = true; reset(); const version = epoch;
    try {
      return await withHandle(state, side, filename, false, async (io) => {
        const before = metadata(await io.stat(), side); const bytes = await readAll(io, state); const after = metadata(await io.stat(), side);
        if (JSON.stringify(before) !== JSON.stringify(after) || bytes.length !== after[0]) throw new Error('Файл изменился во время чтения.');
        const data = decode(bytes); check(state); if (epoch !== version) throw new Error('Редактор закрыт.'); const token = crypto.randomUUID(); editor = { token, state, side, filename, meta: after, hash: digest(bytes), bom: data.bom, crlf: data.crlf };
        return { token, text: data.text };
      });
    } finally { state.busy = false; }
  }
  async function save(id, token, text) {
    const state = getState(id); const entry = editor;
    if (!entry || entry.token !== token || entry.state !== state) throw new Error('Редактор устарел. Откройте файл снова.');
    if (state.busy) throw new Error('Другая операция ещё выполняется.');
    if (typeof text !== 'string' || text.includes('\0') || (text.isWellFormed && !text.isWellFormed())) throw new Error('Некорректный текст.');
    const normalized = text.replace(/\r\n?/g, '\n'); const bytes = Buffer.from((entry.bom ? '\ufeff' : '') + (entry.crlf ? normalized.replace(/\n/g, '\r\n') : normalized), 'utf8');
    if (bytes.length > LIMIT) throw new Error('Размер файла превышает 2 МиБ.');
    state.busy = true; let started = false;
    try {
      await withHandle(state, entry.side, entry.filename, true, async (io) => {
        const before = metadata(await io.stat(), entry.side); const currentBytes = await readAll(io, state); const after = metadata(await io.stat(), entry.side);
        if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(after) !== JSON.stringify(entry.meta) || digest(currentBytes) !== entry.hash) throw new Error('Файл был изменён извне. Скопируйте ваши изменения и откройте его заново.');
        if (digest(bytes) === entry.hash) return;
        for (let offset = 0; offset < bytes.length;) {
          check(state); if (editor !== entry) throw new Error('Редактор закрыт.'); started = true; const written = await io.write(bytes.subarray(offset, offset + CHUNK), offset);
          if (!Number.isInteger(written) || written <= 0) throw new Error('Ошибка записи.'); offset += written;
        }
        if (bytes.length !== currentBytes.length) { check(state); if (editor !== entry) throw new Error('Редактор закрыт.'); started = true; await io.truncate(bytes.length); }
        check(state);
      });
      editor = null; return { ok: true };
    } catch (error) {
      if (started) { editor = null; throw new Error(`Запись прервалась; файл мог быть изменён частично. Проверьте его и восстановите при необходимости. ${error.message}`); }
      throw error;
    } finally { state.busy = false; }
  }
  return { open, save, reset };
}
const fsConstants = require('node:fs').constants;
module.exports = { createSftpEditor, LIMIT };
