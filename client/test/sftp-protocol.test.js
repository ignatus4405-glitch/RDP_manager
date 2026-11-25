'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Server } = require('ssh2');
const { createSshSession } = require('../ssh-session');

test('two-pane transfers use a real SFTP protocol connection', { timeout: 15000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-protocol-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'upload.txt'), 'local data');
  const files = new Map([['/download.txt', Buffer.from('remote data')]]), handles = new Map(); let serial = 0;
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {}); client.on('authentication', (ctx) => ctx.method === 'password' ? ctx.accept() : ctx.reject());
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (accept) => {
      const s = accept(); const attrs = (file) => ({ mode: 0o100644, size: file.length, uid: 0, gid: 0, atime: 1, mtime: 1 });
      const idOf = (handle) => handle.toString();
      s.on('REALPATH', (id) => s.name(id, { filename: '/' }));
      s.on('LSTAT', (id, name) => files.has(name) ? s.attrs(id, attrs(files.get(name))) : s.status(id, 2));
      s.on('STAT', (id, name) => files.has(name) ? s.attrs(id, attrs(files.get(name))) : s.status(id, 2));
      s.on('OPENDIR', (id) => { const key = String(++serial); handles.set(key, { dir: true }); s.handle(id, Buffer.from(key)); });
      s.on('READDIR', (id, handle) => { const h = handles.get(idOf(handle)); if (h.read) return s.status(id, 1); h.read = true; s.name(id, [...files].map(([name, content]) => ({ filename: name.slice(1), longname: name.slice(1), attrs: attrs(content) }))); });
      s.on('OPEN', (id, name, flags) => { const write = Boolean(flags & 2); if (!write && !files.has(name)) return s.status(id, 2); if (write) files.set(name, Buffer.alloc(0)); const key = String(++serial); handles.set(key, { name }); s.handle(id, Buffer.from(key)); });
      s.on('FSTAT', (id, handle) => { const h = handles.get(idOf(handle)); s.attrs(id, attrs(files.get(h.name))); });
      s.on('WRITE', (id, handle, offset, data) => { const h = handles.get(idOf(handle)); const old = files.get(h.name), buf = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(buf); data.copy(buf, offset); files.set(h.name, buf); s.status(id, 0); });
      s.on('READ', (id, handle, offset, length) => { const h = handles.get(idOf(handle)), content = files.get(h.name); if (offset >= content.length) return s.status(id, 1); s.data(id, content.subarray(offset, offset + length)); });
      s.on('CLOSE', (id, handle) => { handles.delete(idOf(handle)); s.status(id, 0); });
    })));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let ready, rejectReady; const readyPromise = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const ssh = createSshSession({ localStart: root, verifyHost: async () => true, confirmOverwrite: async () => true, emit: (event) => { if (event.type === 'ready') ready(); if (event.type === 'error') rejectReady(new Error(event.message)); } });
  t.after(() => { ssh.close(); server.close(); });
  const { id } = ssh.open({ host: '127.0.0.1', port: server.address().port, username: 'user', password: 'pass', mode: 'sftp' }); await readyPromise;
  const listing = await ssh.list(id, '.'); assert.equal(listing.path, '/'); assert.equal(listing.files[0].name, 'download.txt'); assert.equal(listing.files[0].file, true);
  await ssh.transferBetween(id, root, '/', 'upload.txt', 'upload'); assert.equal(files.get('/upload.txt').toString(), 'local data');
  await ssh.transferBetween(id, root, '/', 'download.txt', 'download'); assert.equal(await fs.readFile(path.join(root, 'download.txt'), 'utf8'), 'remote data');
});
