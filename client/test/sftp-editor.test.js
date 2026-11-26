'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSftpEditor, LIMIT } = require('../sftp-editor');

test('local text editing preserves line endings, detects conflicts and rejects unsafe data', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sftp-editor-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const state = { busy: false }, editor = createSftpEditor({ getState: () => state, isCurrent: () => true });
  await fs.writeFile(path.join(dir, 'notes.txt'), '\ufeffone\r\ntwo\r\n');
  let opened = await editor.open('session', 'local', dir, 'notes.txt'); assert.equal(opened.text, 'one\ntwo\n');
  await editor.save('session', opened.token, 'new\n'); assert.equal(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8'), '\ufeffnew\r\n');
  opened = await editor.open('session', 'local', dir, 'notes.txt'); await fs.writeFile(path.join(dir, 'notes.txt'), 'another writer');
  await assert.rejects(editor.save('session', opened.token, 'my changes'), /изменён извне/i);
  assert.equal(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8'), 'another writer');
  await fs.writeFile(path.join(dir, 'invalid'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(editor.open('session', 'local', dir, 'invalid'), /UTF-8/);
  await fs.writeFile(path.join(dir, 'binary'), Buffer.from([0, 1])); await assert.rejects(editor.open('session', 'local', dir, 'binary'), /двоичные/i);
  await fs.writeFile(path.join(dir, 'mixed'), 'a\r\nb\n'); await assert.rejects(editor.open('session', 'local', dir, 'mixed'), /смешанные/i);
  await fs.writeFile(path.join(dir, 'large'), Buffer.alloc(LIMIT + 1, 65)); await assert.rejects(editor.open('session', 'local', dir, 'large'), /2 МиБ/);
  await assert.rejects(editor.open('session', 'local', dir, '../escape'), /имя файла/i);
  opened = await editor.open('session', 'local', dir, 'notes.txt'); editor.reset(); await assert.rejects(editor.save('session', opened.token, 'new'), /устарел/i);
});
