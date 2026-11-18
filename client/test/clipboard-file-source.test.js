'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createClipboardFileSource } = require('../clipboard-file-source');

test('clipboard file capabilities cover only copied files and preserve directories', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-clip-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'folder');
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'a.txt'), 'abc');
  let raw = pathToFileURL(folder).href;
  const clipboard = { read: async () => [{ types: ['text/uri-list'], getType: async () => new Blob([raw]) }] };
  const source = createClipboardFileSource({ clipboard });
  const result = await source.inspect();
  assert.deepEqual(result.files.map((x) => [x.name, x.path, x.isDirectory]), [['folder', undefined, true], ['a.txt', 'folder', false]]);
  assert.equal((await source.read(result.files[1].id, 1, 2)).toString(), 'bc');
  await assert.rejects(source.read('not-a-capability', 0, 3));
  assert.equal((await source.inspect()).unchanged, true);
  await fs.writeFile(path.join(folder, 'a.txt'), 'changed');
  await assert.rejects(source.read(result.files[1].id, 0, 1), /изменился/);
  raw = '';
  await source.inspect();
  await assert.rejects(source.read(result.files[1].id, 0, 1));
});
