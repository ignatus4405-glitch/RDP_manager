'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const { createClipboardReceiver, validateParts } = require('../rdp-clipboard-receiver');

class Item {
  constructor(values) { this.values = values; this.types = Object.keys(values); }
  async getType(type) { return new Blob([this.values[type]]); }
}

test('remote files and folders are staged and committed to the system clipboard', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-clipboard-receiver-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let items = [new Item({ 'text/plain': 'previous' })];
  const clipboard = { read: async () => items, write: async (next) => { items = next; } };
  const receiver = createClipboardReceiver({ clipboard, ClipboardItem: Item, tempDirectory: dir });
  const id = await receiver.begin([{ name: 'folder', isDirectory: true }, { name: 'a.txt', path: 'folder' }]);
  await receiver.open(id, 0);
  await receiver.open(id, 1);
  await receiver.write(id, 1, Uint8Array.from([65, 66]));
  await receiver.close(id, 1);
  await receiver.commit(id);
  assert.deepEqual(items[0].types, ['text/uri-list']);
  const uri = (await (await items[0].getType('text/uri-list')).text()).trim();
  assert.equal(await fs.readFile(path.join(fileURLToPath(uri), 'a.txt'), 'utf8'), 'AB');
});

test('clipboard changes and incomplete transfers cannot replace local clipboard', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rdp-clipboard-receiver-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  let items = [new Item({ 'text/plain': 'before' })];
  const clipboard = { read: async () => items, write: async (next) => { items = next; } };
  const receiver = createClipboardReceiver({ clipboard, ClipboardItem: Item, tempDirectory: dir });
  const id = await receiver.begin([{ name: 'a.txt' }]);
  await assert.rejects(receiver.commit(id), /не завершена/);
  await receiver.open(id, 0); await receiver.close(id, 0);
  items = [new Item({ 'text/plain': 'new local copy' })];
  await assert.rejects(receiver.commit(id), /изменился/);
  await receiver.cancel(id);
  assert.equal(await (await items[0].getType('text/plain')).text(), 'new local copy');
  assert.deepEqual(await fs.readdir(dir), []);
});

test('remote names reject traversal, device names and alternate streams', () => {
  for (const entry of [{ name: '..' }, { name: '../x' }, { path: '../x', name: 'a' }, { path: 'C:\\temp', name: 'x' }, { name: 'NUL.txt' }, { name: 'x:stream' }]) {
    assert.throws(() => validateParts(entry));
  }
  assert.deepEqual(validateParts({ path: 'folder\\nested', name: 'a.txt' }), ['folder', 'nested', 'a.txt']);
});
