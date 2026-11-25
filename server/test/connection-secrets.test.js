'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { createConnectionSecrets, secureSecretTransport } = require('../src/connection-secrets');

test('connection passwords are encrypted, authenticated, isolated and fail closed when the key is lost', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdpm-secrets-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE connection_secrets (connection_id INTEGER PRIMARY KEY, iv BLOB NOT NULL, ciphertext BLOB NOT NULL, tag BLOB NOT NULL)');
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const vault = createConnectionSecrets({ db, dataDir: dir });
  const password = 'пароль и пробелы !'; vault.save(1, password);
  const row = db.prepare('SELECT * FROM connection_secrets WHERE connection_id = 1').get();
  assert.equal(Buffer.from(row.ciphertext).includes(Buffer.from(password)), false);
  assert.equal(vault.read(1), password);
  vault.save(1, password);
  assert.notDeepEqual(Buffer.from(db.prepare('SELECT iv FROM connection_secrets WHERE connection_id=1').get().iv), Buffer.from(row.iv));
  db.prepare('INSERT INTO connection_secrets VALUES (2, ?, ?, ?)').run(row.iv, row.ciphertext, row.tag);
  assert.throws(() => vault.read(2)); // AAD prevents moving ciphertext to another connection
  db.prepare('UPDATE connection_secrets SET ciphertext = ? WHERE connection_id = 1').run(Buffer.from('tampered'));
  assert.throws(() => vault.read(1));
  fs.unlinkSync(path.join(dir, 'connection-secrets.key'));
  assert.throws(() => vault.save(3, 'other'), /резервной копии/);
  assert.equal(fs.existsSync(path.join(dir, 'connection-secrets.key')), false);
  vault.remove(1); vault.remove(2); assert.equal(vault.read(1), null);
});

test('credential endpoints accept TLS or direct loopback only, not forwarded HTTP', () => {
  const req = (ip, host, headers = {}, encrypted = false) => ({ socket: { remoteAddress: ip, encrypted }, headers: { host, ...headers } });
  assert.equal(secureSecretTransport(req('192.0.2.2', 'server:8720', {}, true)), true);
  assert.equal(secureSecretTransport(req('127.0.0.1', '127.0.0.1:8720')), true);
  assert.equal(secureSecretTransport(req('::1', '[::1]:8720')), true);
  assert.equal(secureSecretTransport(req('192.0.2.2', 'server:8720')), false);
  assert.equal(secureSecretTransport(req('127.0.0.1', 'server:8720')), false);
  assert.equal(secureSecretTransport(req('127.0.0.1', 'localhost:8720', { 'x-forwarded-proto': 'https' })), false);
});
