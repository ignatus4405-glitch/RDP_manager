'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const call = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (err, value) => err ? reject(err) : resolve(value)));
const numeric = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffffff ? value : null;
function snapshot(stat) {
  return { size: Number.isSafeInteger(stat.size) && stat.size >= 0 ? stat.size : null, mode: numeric(stat.mode), uid: numeric(stat.uid), gid: numeric(stat.gid), mtime: numeric(stat.mtime), type: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other' };
}
function createSftpProperties({ getState, isCurrent }) {
  let entry = null, version = 0;
  function reset() { version++; entry = null; }
  function validate(side, dir, name) {
    if (!['local', 'remote'].includes(side) || typeof dir !== 'string' || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir) || (side === 'local' ? !path.isAbsolute(dir) : !dir.startsWith('/'))) throw new Error('Недопустимый путь.');
    if (typeof name !== 'string' || !name || name.length > 255 || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) throw new Error('Недопустимое имя файла.');
    return side === 'local' ? path.join(dir, name) : path.posix.join(dir, name);
  }
  async function stat(state, side, filename) {
    if (side === 'remote') return snapshot(await call(state.sftp, 'lstat', filename));
    const stat = await fs.lstat(filename);
    return snapshot({ ...stat, size: stat.size, mode: stat.mode, uid: stat.uid, gid: stat.gid, mtime: Math.floor(stat.mtimeMs / 1000), isSymbolicLink: () => stat.isSymbolicLink(), isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() });
  }
  async function open(id, side, dir, name) {
    const state = getState(id), filename = validate(side, dir, name);
    if (state.busy) throw new Error('Другая операция ещё выполняется.');
    state.busy = true; reset(); const revision = version;
    try {
      const data = await stat(state, side, filename);
      if (!isCurrent(state) || revision !== version) throw new Error('Окно свойств закрыто.');
      const token = crypto.randomUUID(); entry = { state, side, filename, data, token };
      return { token, ...data };
    } finally { state.busy = false; }
  }
  async function save(id, token, changes) {
    const state = getState(id), active = entry;
    if (!active || active.token !== token || active.state !== state) throw new Error('Окно свойств устарело. Откройте его заново.');
    if (active.side !== 'remote' || !['file', 'directory'].includes(active.data.type)) throw new Error('Изменение доступно только для обычных файлов и каталогов на сервере.');
    if (!changes || typeof changes !== 'object') throw new Error('Недопустимые свойства.');
    const { mode, uid, gid } = changes, original = active.data, attrs = {};
    if (mode !== null && (!Number.isInteger(mode) || mode < 0 || mode > 0o7777 || original.mode === null)) throw new Error('Недопустимые права доступа.');
    if (uid !== null && (numeric(uid) === null || original.uid === null || original.gid === null)) throw new Error('Недопустимый UID.');
    if (gid !== null && (numeric(gid) === null || original.uid === null || original.gid === null)) throw new Error('Недопустимый GID.');
    if (mode !== null && mode !== (original.mode & 0o7777)) attrs.mode = mode;
    if ((uid !== null && uid !== original.uid) || (gid !== null && gid !== original.gid)) { attrs.uid = uid ?? original.uid; attrs.gid = gid ?? original.gid; }
    if (state.busy) throw new Error('Другая операция ещё выполняется.');
    state.busy = true;
    try {
      const latest = await stat(state, 'remote', active.filename);
      if (!isCurrent(state) || entry !== active) throw new Error('Окно свойств закрыто.');
      if (JSON.stringify(latest) !== JSON.stringify(original)) throw new Error('Объект изменился. Обновите свойства и повторите операцию.');
      if (Object.keys(attrs).length) await call(state.sftp, 'setstat', active.filename, attrs);
      if (!isCurrent(state)) throw new Error('SFTP-сеанс закрыт; проверьте свойства на сервере.');
      reset(); return { ok: true };
    } finally { state.busy = false; }
  }
  return { open, save, reset };
}
module.exports = { createSftpProperties };
