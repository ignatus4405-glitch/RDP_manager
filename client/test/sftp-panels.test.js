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
  let linkCall;
  const sftp = {
    open(name, flags, cb) { fs.open(remotePath(name), flags).then((handle) => cb(null, handle), cb); },
    close(handle, cb) { handle.close().then(() => cb(), cb); },
    symlink(target, name, cb) { linkCall = { target, name }; cb(); },
    mkdir(name, cb) { fs.mkdir(remotePath(name)).then(() => cb(), cb); },
    lstat(name, cb) { fs.lstat(remotePath(name)).then((stats) => cb(null, stats), (error) => cb({ code: error.code === 'ENOENT' ? 2 : 4 })); },
    fastPut(from, to, options, cb) { fs.copyFile(from, remotePath(to)).then(() => { options.step(10, 10, 10); cb(); }, cb); },
    fastGet(from, to, options, cb) { fs.copyFile(remotePath(from), to).then(() => { options.step(11, 11, 11); cb(); }, cb); },
  };
  class FakeClient extends EventEmitter { connect() { setImmediate(() => this.emit('ready')); } sftp(cb) { cb(null, sftp); } end() {} }
  let accept = false, confirmations = [], ready, clipboard = []; const events = [];
  const readyPromise = new Promise((resolve) => { ready = resolve; });
  const manager = createSshSession({ localStart: local, makeClient: () => new FakeClient(), verifyHost: async () => true, emit: (event) => { events.push(event); if (event.type === 'ready') ready(); }, readClipboardFiles: async () => clipboard, confirmOverwrite: async (target, where) => { confirmations.push({ target, where }); return accept; } });
  const { id } = manager.open({ host: 'example.com', username: 'user', password: 'password', mode: 'sftp' }); await readyPromise;
  t.after(() => manager.close());
  const listing = await manager.localList(id, null); assert.equal(listing.path, await fs.realpath(local)); assert.equal(listing.parent, path.dirname(await fs.realpath(local)));
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
  await manager.createFile(id, 'local', local, 'new-local.txt');
  await manager.createFile(id, 'remote', '/', 'new-remote.txt');
  assert.equal((await fs.stat(path.join(local, 'new-local.txt'))).size, 0);
  assert.equal((await fs.stat(path.join(remote, 'new-remote.txt'))).size, 0);
  await assert.rejects(manager.createFile(id, 'local', local, 'upload.txt'));
  await assert.rejects(manager.createFile(id, 'remote', '/', 'download.txt'));
  assert.equal(await fs.readFile(path.join(local, 'upload.txt'), 'utf8'), 'from local');
  assert.equal(await fs.readFile(path.join(remote, 'download.txt'), 'utf8'), 'updated');
  await assert.rejects(manager.createFile(id, 'remote', '/', '../bad'), /имя файла/i);
  await manager.createLink(id, 'remote', '/', 'link', '../somewhere');
  assert.deepEqual(linkCall, { target: '../somewhere', name: '/link' });
  await assert.rejects(manager.createLink(id, 'local', local, 'link', '/target'), /только на сервере/i);
  await assert.rejects(manager.createLink(id, 'remote', '/', 'link', ''), /недопустимый путь/i);
  await manager.createDirectory(id, 'local', local, 'new-local');
  await manager.createDirectory(id, 'remote', '/', 'new-remote');
  assert.equal((await fs.stat(path.join(local, 'new-local'))).isDirectory(), true);
  assert.equal((await fs.stat(path.join(remote, 'new-remote'))).isDirectory(), true);
  await assert.rejects(manager.createDirectory(id, 'remote', '/', '../bad'), /имя файла/i);
  await assert.rejects(manager.pasteFiles(id, '/'), /нет локальных файлов/i);
  clipboard = [path.join(local, 'folder')];
  await assert.rejects(manager.pasteFiles(id, '/'), /только отдельные обычные файлы/i);
  await fs.writeFile(path.join(local, 'clipboard.txt'), 'clipboard data');
  clipboard = [path.join(local, 'clipboard.txt')];
  assert.deepEqual(await manager.pasteFiles(id, '/'), { ok: true, count: 1 });
  assert.equal(await fs.readFile(path.join(remote, 'clipboard.txt'), 'utf8'), 'clipboard data');
  accept = false;
  assert.deepEqual(await manager.pasteFiles(id, '/'), { cancelled: true, count: 0 });
  assert.ok(events.some((event) => event.type === 'progress'));
  assert.ok(!(await fs.readdir(local)).some((name) => name.endsWith('.sftp-part')));
});
