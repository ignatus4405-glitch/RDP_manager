'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRichClipboard } = require('../clipboard-rich');
function item(values) { return { types: Object.keys(values), async getType(type) { return new Blob([values[type]], { type }); } }; }
test('text-only clipboard reading ignores copied files and non-text clipboard contents', async () => {
  let source = [item({ 'text/plain': 'hello' })];
  const rich = createRichClipboard({ clipboard: { read: async () => source }, ClipboardItem: null });
  assert.equal(await rich.readTextOnly(), 'hello');
  source = [item({ 'text/plain': 'file name', 'text/uri-list': 'file:///example' })];
  assert.equal(await rich.readTextOnly(), null);
  source = [item({ 'image/png': 'bytes' })];
  assert.equal(await rich.readTextOnly(), null);
  source = [item({ 'text/plain': 'x'.repeat(4 * 1024 * 1024 + 1) })];
  assert.equal(await rich.readTextOnly(), null);
});
