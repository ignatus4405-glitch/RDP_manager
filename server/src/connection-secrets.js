'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A separate key file limits damage from a database-only leak. Back up this
// file alongside the database; losing it makes stored passwords unrecoverable.
function createConnectionSecrets({ db, dataDir }) {
  const keyPath = path.join(dataDir, 'connection-secrets.key');
  function getKey() {
    let raw;
    try { raw = fs.readFileSync(keyPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (db.prepare('SELECT 1 FROM connection_secrets LIMIT 1').get()) throw new Error('Ключ хранилища подключений отсутствует; восстановите его из резервной копии.');
      const generated = crypto.randomBytes(32);
      try { fs.writeFileSync(keyPath, generated, { mode: 0o600, flag: 'wx' }); raw = generated; }
      catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; raw = fs.readFileSync(keyPath); }
    }
    if (raw.length !== 32) throw new Error('Повреждён ключ хранилища подключений.');
    return raw;
  }
  const aad = (id) => Buffer.from(`rdp-manager:connection-secret:v1:${id}`, 'utf8');
  function save(id, value) {
    if (!Number.isSafeInteger(id) || id <= 0 || typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 8192) throw new Error('Некорректный пароль подключения.');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    cipher.setAAD(aad(id));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    db.prepare(`INSERT INTO connection_secrets (connection_id, iv, ciphertext, tag) VALUES (?, ?, ?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET iv=excluded.iv, ciphertext=excluded.ciphertext, tag=excluded.tag`).run(id, iv, ciphertext, tag);
  }
  function read(id) {
    const row = db.prepare('SELECT iv, ciphertext, tag FROM connection_secrets WHERE connection_id = ?').get(id);
    if (!row) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), row.iv);
    decipher.setAAD(aad(id)); decipher.setAuthTag(row.tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
  }
  function remove(id) { db.prepare('DELETE FROM connection_secrets WHERE connection_id = ?').run(id); }
  return { save, read, remove };
}

// Do not trust forwarded headers or a local reverse proxy automatically: it
// could otherwise turn an internet plaintext request into an apparent loopback.
function secureSecretTransport(req) {
  if (req.socket.encrypted) return true;
  if (Object.keys(req.headers).some((name) => name === 'forwarded' || name.startsWith('x-forwarded-'))) return false;
  const host = String(req.headers.host || '').toLowerCase();
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}
module.exports = { createConnectionSecrets, secureSecretTransport };
