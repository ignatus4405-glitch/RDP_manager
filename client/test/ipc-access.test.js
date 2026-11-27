'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { requireWindowFrame } = require('../ipc-access');

test('only the expected window, document and top-level frame can access IPC', () => {
  const file = path.join(__dirname, '../renderer/server-manager.html');
  const frame = { url: pathToFileURL(file).href };
  const contents = { mainFrame: frame };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  assert.doesNotThrow(() => requireWindowFrame(event, window, file));
  assert.throws(() => requireWindowFrame({ ...event, sender: {} }, window, file));
  assert.throws(() => requireWindowFrame({ ...event, senderFrame: { url: frame.url } }, window, file));
  frame.url = 'https://example.com/';
  assert.throws(() => requireWindowFrame(event, window, file));
  assert.throws(() => requireWindowFrame(event, null, file));
  assert.throws(() => requireWindowFrame(event, { ...window, isDestroyed: () => true }, file));
});
