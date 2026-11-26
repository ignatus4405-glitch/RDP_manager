'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSftpProperties } = require('../sftp-properties');
function attributes({ mode = 0o100644, uid = 0, gid = 0, size = 12884901888, mtime = 100, link = false } = {}) {
  return { mode, uid, gid, size, mtime, isSymbolicLink: () => link, isDirectory: () => false, isFile: () => !link };
}
test('SFTP properties validate changes, preserve large sizes and reject stale or symbolic-link updates', async () => {
  const state = { busy: false }, changes = []; let stat = attributes();
  state.sftp = { lstat(_name, cb) { cb(null, stat); }, setstat(name, attrs, cb) { changes.push({ name, attrs }); cb(); } };
  const props = createSftpProperties({ getState: () => state, isCurrent: () => true });
  let data = await props.open('id', 'remote', '/', 'config'); assert.equal(data.size, 12884901888); assert.equal(data.type, 'file');
  await props.save('id', data.token, { mode: 0o4750, uid: 42, gid: 0 }); assert.deepEqual(changes[0], { name: '/config', attrs: { mode: 0o4750, uid: 42, gid: 0 } });
  data = await props.open('id', 'remote', '/', 'config'); await assert.rejects(props.save('id', data.token, { mode: 0o10000, uid: 0, gid: 0 }), /права/i);
  await assert.rejects(props.save('id', data.token, { mode: 0o644, uid: -1, gid: 0 }), /UID/);
  stat = attributes({ size: 1 }); await assert.rejects(props.save('id', data.token, { mode: 0o600, uid: 0, gid: 0 }), /изменился/i); assert.equal(changes.length, 1);
  stat = attributes({ link: true, mode: 0o120777 }); data = await props.open('id', 'remote', '/', 'link'); assert.equal(data.type, 'link');
  await assert.rejects(props.save('id', data.token, { mode: 0o777, uid: 0, gid: 0 }), /только для обычных/i);
  await assert.rejects(props.open('id', 'remote', '/', '../escape'), /имя файла/i);
  stat = attributes({ uid: undefined, gid: undefined }); stat.uid = undefined; stat.gid = undefined;
  data = await props.open('id', 'remote', '/', 'file'); assert.equal(data.uid, null); await assert.rejects(props.save('id', data.token, { mode: null, uid: 1, gid: null }), /UID/);
  props.reset(); await assert.rejects(props.save('id', data.token, { mode: null, uid: null, gid: null }), /устарело/i);
});
test('local properties are read only', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-prop-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); await fs.writeFile(path.join(dir, 'file.txt'), 'hello');
  const state = { busy: false }, props = createSftpProperties({ getState: () => state, isCurrent: () => true });
  const data = await props.open('id', 'local', dir, 'file.txt'); assert.equal(data.size, 5); assert.equal(data.type, 'file');
  await assert.rejects(props.save('id', data.token, { mode: 0o600, uid: null, gid: null }), /только для обычных/i);
});
