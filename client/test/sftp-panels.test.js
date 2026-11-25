'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSshSession } = require('../ssh-session');

test('SFTP panels navigate locally and transfer single files in both directions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-panels-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const local = path.join(root, 'local'), remote = path.join(root, 'remote');
  await fs.mkdir(local); await fs.mkdir(remote); await fs.mkdir(path.join(local, 'folder'));
  await fs.writeFile(path.join(local, 'upload.txt'), 'from local');
  await fs.writeFile(path.join(remote, 'download.txt'), 'from remote');
  const remotePath = (value) => path.join(remote, path.posix.basename(value));
  const sftp = {
    lstat(name, cb) { fs.lstat(remotePath(name)).then((stats) => cb(null, stats), (error) => cb({ code: error.code === 'ENOENT' ? 2 : 4 })); },
    fastPut(from, to, options, cb) { fs.copyFile(from, remotePath(to)).then(() => { options.step(10, 10, 10); cb(); }, cb); },
    fastGet(from, to, options, cb) { fs.copyFile(remotePath(from), to).then(() => { options.step(11, 11, 11); cb(); }, cb); },
  };
  class FakeClient extends EventEmitter { connect() { setImmediate(() => this.emit('ready')); } sftp(cb) { cb(null, sftp); } end() {} }
  let accept = false, confirmations = [], ready; const events = [];
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const manager = createSshSession({ localStart: local, makeClient: () => new FakeClient(), verifyHost: async () => true, emit: (event) => { events.push(event); if (event.type === 'ready') ready(); }, confirmOverwrite: async (target, where) => { confirmations.push({ target, where }); return accept; } });
  const { id } = manager.open({ host: 'example.com', username: 'user', password: 'password', mode: 'sftp' }); await readyPromise;
  t.after(() => manager.close());
  const listing = await manager.localList(id, null); assert.equal(listing.path, local); assert.equal(listing.parent, root);
  assert.equal(listing.files.find((e) => e.name === 'folder').directory, true); assert.equal(listing.files.find((e) => e.name === 'upload.txt').file, true);
  assert.deepEqual(await manager.transferBetween(id, local, '/', 'upload.txt', 'upload'), { ok: true });
  assert.equal(await fs.readFile(path.join(remote, 'upload.txt'), 'utf8'), 'from local');
  assert.deepEqual(await manager.transferBetween(id, local, '/', 'download.txt', 'download'), { ok: true });
  assert.equal(await fs.readFile(path.join(local, 'download.txt'), 'utf8'), 'from remote');
  assert.deepEqual(await manager.transferBetween(id, local, '/', 'download.txt', 'download'), { cancelled: true });
  assert.equal(confirmations.at(-1).where, 'local');
  await fs.writeFile(path.join(remote, 'download.txt'), 'updated'); accept = true;
  assert.deepEqual(await manager.transferBetween(id, local, '/', 'download.txt', 'download'), { ok: true });
  assert.equal(await fs.readFile(path.join(local, 'download.txt'), 'utf8'), 'updated');
  await assert.rejects(manager.transferBetween(id, local, '/', '../escape', 'download'), /имя файла/i);
  await assert.rejects(manager.transferBetween(id, local, '/', 'folder', 'upload'), /обычный локальный файл/i);
  assert.ok(events.some((event) => event.type === 'progress'));
  assert.ok(!(await fs.readdir(local)).some((name) => name.endsWith('.sftp-part')));
});
