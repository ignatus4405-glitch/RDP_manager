'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// Files are encrypted with the current OS user's key. Account/connection scope
// avoids accidental sharing, but is not an authorization boundary against a
// malicious process running as the same OS user.
function createLocalCredentials({ safeStorage, directory, platform = process.platform }) {
  function check() {
    if (platform !== 'win32' || !safeStorage.isEncryptionAvailable()) throw new Error('Защищённое локальное хранилище доступно только в Windows.');
  }
  function filename(scope) {
    if (!scope || !['rdp', 'rustdesk'].includes(scope.type) || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || !Number.isSafeInteger(scope.connectionId) || scope.connectionId < 1 || typeof scope.server !== 'string' || scope.server.length > 1000 || typeof scope.userName !== 'string' || !scope.userName || scope.userName.length > 150 || typeof scope.target !== 'string' || scope.target.length > 2048) throw new Error('Некорректная область сохранённых данных.');
    const data = JSON.stringify([scope.server, scope.userId, scope.userName, scope.connectionId, scope.type, scope.target]);
    return path.join(directory, crypto.createHash('sha256').update(data).digest('hex') + '.dat');
  }
  return {
    async get(scope) {
      check(); const file = filename(scope); let data;
      try { data = await fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      if (data.length > 16384) throw new Error('Некорректные сохранённые данные.');
      try { return JSON.parse(safeStorage.decryptString(data)); } catch { throw new Error('Не удалось расшифровать локальные данные.'); }
    },
    async put(scope, value) {
      check(); const file = filename(scope);
      if (!value || typeof value.password !== 'string' || Buffer.byteLength(value.password) > 8192 || typeof value.username !== 'string' || value.username.length > 256 || typeof value.domain !== 'string' || value.domain.length > 256) throw new Error('Некорректные учётные данные.');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = file + '.' + crypto.randomUUID() + '.tmp';
      try { await fs.writeFile(temp, safeStorage.encryptString(JSON.stringify(value)), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }); }
    },
    async remove(scope) { check(); await fs.rm(filename(scope), { force: true }); },
  };
}
module.exports = { createLocalCredentials };
