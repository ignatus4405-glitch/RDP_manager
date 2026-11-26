'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const call = (obj, method, ...args) => new Promise((resolve, reject) => obj[method](...args, (err, value) => err ? reject(err) : resolve(value)));

function createSftpOperations({ getState, isCurrent, confirmDelete, stageFile, publishFile, progress }) {
  function validPath(side, value) {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || (side === 'local' ? !path.isAbsolute(value) : !value.startsWith('/'))) throw new Error('Укажите абсолютный путь каталога.');
    return value;
  }
  function validName(value, windows = false) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.length > 255 || /[\\/\x00-\x1f\x7f]/.test(value)) throw new Error('Недопустимое имя объекта.');
    if (windows && (/[<>:"|?*]/.test(value) || /[. ]$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value))) throw new Error('Имя не поддерживается Windows.');
    return value;
  }
  const ensure = (state) => { if (!isCurrent(state)) throw new Error('SFTP-сеанс закрыт.'); };
  async function stat(state, side, item) {
    try { return side === 'local' ? await fs.lstat(item) : await call(state.sftp, 'lstat', item); }
    catch (err) { if (side === 'local' ? err.code === 'ENOENT' : err.code === 2) return null; throw err; }
  }
  // SFTP has no no-follow directory handles; lstat checks reduce, but cannot
  // eliminate, races with a server-side rename or symlink substitution.
  async function copyRemoteFile(state, source, destination, info, local) {
    const sftp = state.sftp; let input, output;
    try {
      input = await call(sftp, 'open', source, 'r');
      const opened = await call(sftp, 'fstat', input);
      if (!opened.isFile() || opened.size !== info.size || opened.mtime !== info.mtime || opened.mode !== info.mode) throw new Error('Исходный файл изменился.');
      ensure(state);
      let writable;
      if (local) writable = require('node:fs').createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      else { output = await call(sftp, 'open', destination, 'wx'); writable = sftp.createWriteStream(destination, { handle: output, autoClose: false }); }
      const readable = sftp.createReadStream(source, { handle: input, autoClose: false }); let done = 0;
      readable.on('data', (chunk) => { done += chunk.length; progress(state, { done, total: info.size, direction: local ? 'download' : 'duplicate' }); if (!isCurrent(state)) readable.destroy(new Error('SFTP-сеанс закрыт.')); });
      await pipeline(readable, writable);
    } finally {
      if (input) await call(sftp, 'close', input).catch(() => {});
      if (output) await call(sftp, 'close', output).catch(() => {});
    }
  }
  async function copyRemoteTree(state, source, destination, initial, local) {
    const stack = [{ source, destination, info: initial, depth: 0 }];
    let count = 0;
    while (stack.length) {
      ensure(state);
      const item = stack.pop();
      if (++count > 100000 || item.depth > 128) throw new Error('Превышен предел количества объектов или глубины папок.');
      const info = await stat(state, 'remote', item.source);
      if (!info || info.mode !== item.info.mode || info.size !== item.info.size || info.mtime !== item.info.mtime) throw new Error(`Объект изменился: ${item.source}`);
      if (info.isSymbolicLink()) throw new Error(`Символические ссылки не копируются: ${item.source}`);
      if (info.isFile()) { await copyRemoteFile(state, item.source, item.destination, info, local); continue; }
      if (!info.isDirectory()) throw new Error(`Неподдерживаемый тип объекта: ${item.source}`);
      if (local) await fs.mkdir(item.destination, { mode: 0o700 });
      else await call(state.sftp, 'mkdir', item.destination);
      ensure(state);
      const entries = await call(state.sftp, 'readdir', item.source);
      for (const entry of entries) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        validName(entry.filename, local && process.platform === 'win32');
        const child = path.posix.join(item.source, entry.filename);
        const childInfo = await stat(state, 'remote', child);
        if (!childInfo) throw new Error(`Объект исчез: ${child}`);
        stack.push({ source: child, destination: (local ? path : path.posix).join(item.destination, entry.filename), info: childInfo, depth: item.depth + 1 });
        if (stack.length + count > 100000) throw new Error('Превышен предел количества объектов.');
      }
    }
  }
  async function perform(id, side, directory, name, action, value) {
    const state = getState(id); if (!['local', 'remote'].includes(side)) throw new Error('Неизвестная панель.');
    const windows = side === 'local' && process.platform === 'win32'; validPath(side, directory); validName(name, windows);
    if (!['rename', 'move', 'duplicate', 'delete', 'clipboard'].includes(action)) throw new Error('Неизвестное действие.');
    if (state.busy) throw new Error('Другая операция ещё выполняется.');
    state.busy = true;
    try {
      const p = side === 'local' ? path : path.posix, source = p.join(directory, name);
      const info = await stat(state, side, source); ensure(state);
      if (!info) throw new Error('Объект больше не существует.');
      if (!info.isFile() && !info.isDirectory() && !info.isSymbolicLink()) throw new Error('Этот тип объекта не поддерживается.');
      if (action === 'delete') {
        if (!await confirmDelete({ side, target: source, directory: info.isDirectory() })) return { cancelled: true };
        ensure(state);
        const latest = await stat(state, side, source);
        if (!latest || latest.mode !== info.mode || latest.size !== info.size || (side === 'local' ? (latest.mtimeMs !== info.mtimeMs || latest.dev !== info.dev || latest.ino !== info.ino) : latest.mtime !== info.mtime) || latest.isSymbolicLink() !== info.isSymbolicLink()) throw new Error('Объект изменился. Обновите список и повторите удаление.');
        if (side === 'local') { if (latest.isDirectory()) await fs.rmdir(source); else await fs.unlink(source); }
        else await call(state.sftp, latest.isDirectory() ? 'rmdir' : 'unlink', source);
        return { ok: true };
      }
      if (action === 'clipboard') {
        if (side === 'local') { ensure(state); await publishFile(source); return { ok: true }; }
        if (!info.isFile() && !info.isDirectory()) throw new Error('Символические ссылки не копируются в буфер.');
        validName(name, process.platform === 'win32');
        const staged = await stageFile(name);
        try {
          ensure(state);
          await copyRemoteTree(state, source, staged.file, info, true);
          ensure(state); await publishFile(staged.file); staged.keep();
        } catch (error) { await staged.discard(); throw error; }
        return { ok: true, staged: true };
      }
      const targetDir = action === 'move' ? validPath(side, value) : directory;
      const targetName = action === 'move' ? name : validName(value, windows);
      const destination = p.join(targetDir, targetName);
      if (destination === source) throw new Error('Исходный и конечный пути совпадают.');
      if (await stat(state, side, destination)) throw new Error('Объект с таким именем уже существует. Перезапись запрещена.');
      ensure(state);
      if (action === 'duplicate') {
        if (side === 'local') {
          if (!info.isFile()) throw new Error('Дублирование локальных папок и ссылок пока не поддерживается.');
          await fs.copyFile(source, destination, require('node:fs').constants.COPYFILE_EXCL);
        } else {
          if (!info.isFile() && !info.isDirectory()) throw new Error('Символические ссылки не копируются.');
          try { await copyRemoteTree(state, source, destination, info, false); }
          catch (error) { throw new Error(`Дублирование прервано; частичная копия может остаться в месте назначения. ${error.message}`); }
        }
      } else {
        // SFTP v3 rename should reject an existing destination; some servers may
        // behave differently if another process creates it after the check.
        if (side === 'local') await fs.rename(source, destination); else await call(state.sftp, 'rename', source, destination);
      }
      ensure(state); return { ok: true };
    } finally { state.busy = false; }
  }
  return { perform };
}
module.exports = { createSftpOperations };
