'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { createSftpOperations } = require('../sftp-operations');

test('local operations reject overwrites, confirm deletes and publish real clipboard paths', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-ops-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dest = path.join(dir, 'dest'); await fs.mkdir(dest); await fs.writeFile(path.join(dir, 'file.txt'), 'content');
  let confirm = false, copied; const state = { busy: false };
  const ops = createSftpOperations({ getState: () => state, isCurrent: () => true, confirmDelete: async () => confirm, publishFile: async (file) => { copied = file; } });
  await ops.perform('id', 'local', dir, 'file.txt', 'duplicate', 'copy.txt'); assert.equal(await fs.readFile(path.join(dir, 'copy.txt'), 'utf8'), 'content');
  await assert.rejects(ops.perform('id', 'local', dir, 'file.txt', 'duplicate', 'copy.txt'), /существует/i);
  await assert.rejects(ops.perform('id', 'local', dir, 'file.txt', 'rename', '../escape'), /имя/i);
  await ops.perform('id', 'local', dir, 'copy.txt', 'rename', 'renamed.txt');
  await ops.perform('id', 'local', dir, 'renamed.txt', 'move', dest); assert.equal(await fs.readFile(path.join(dest, 'renamed.txt'), 'utf8'), 'content');
  await ops.perform('id', 'local', dir, 'file.txt', 'clipboard'); assert.equal(copied, path.join(dir, 'file.txt'));
  assert.deepEqual(await ops.perform('id', 'local', dir, 'file.txt', 'delete'), { cancelled: true });
  confirm = true; await assert.rejects(ops.perform('id', 'local', dir, 'dest', 'delete')); assert.equal(await fs.readFile(path.join(dest, 'renamed.txt'), 'utf8'), 'content');
  await ops.perform('id', 'local', dir, 'file.txt', 'delete'); await assert.rejects(fs.stat(path.join(dir, 'file.txt')), { code: 'ENOENT' });
});

test('remote operations clean failed clipboard staging and never overwrite targets', async () => {
  const state = { busy: false }, files = new Map([['/src', { mode: 0o100644, size: 1, mtime: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }], ['/exists', { mode: 0o100644, size: 1, mtime: 1, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }]]);
  state.sftp = { lstat(file, cb) { const item = files.get(file); if (!item) cb({ code: 2 }); else cb(null, item); }, open(_src, _flags, cb) { cb(new Error('connection lost')); }, rename() { throw new Error('rename should not be called'); } };
  let discarded = false, published = false;
  const ops = createSftpOperations({ getState: () => state, isCurrent: () => true, confirmDelete: async () => true, stageFile: async () => ({ file: '/tmp/test', keep() {}, discard: async () => { discarded = true; } }), publishFile: async () => { published = true; }, progress() {} });
  await assert.rejects(ops.perform('id', 'remote', '/', 'src', 'rename', 'exists'), /существует/i);
  await assert.rejects(ops.perform('id', 'remote', '/', 'src', 'clipboard'), /connection lost/);
  assert.equal(discarded, true); assert.equal(published, false); assert.equal(state.busy, false);
  await assert.rejects(ops.perform('id', 'remote', '/', '../escape', 'delete'), /имя/i);
});
