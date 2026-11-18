'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRdpFileWriter } = require('../rdp-file-writer');

test('streamed save commits complete files and removes incomplete temporary files', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-write-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'result.txt');
  const writer = createRdpFileWriter({ choosePath: async () => destination });
  await fs.writeFile(destination, 'old');
  const id = await writer.begin('result.txt');
  await writer.write(id, Uint8Array.from([65, 66]));
  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
  await writer.write(id, Uint8Array.from([67]));
  await writer.finish(id);
  assert.equal(await fs.readFile(destination, 'utf8'), 'ABC');
  const cancelled = await writer.begin('result.txt');
  await writer.write(cancelled, Uint8Array.from([88]));
  await writer.cancel(cancelled);
  assert.deepEqual(await fs.readdir(dir), ['result.txt']);
  assert.equal(await fs.readFile(destination, 'utf8'), 'ABC');
});
