'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ snapshot, readRich }) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const section = source.slice(source.indexOf('const RDP_CLIPBOARD_POLL_MS'), source.indexOf('/** Клавиатура/мышь/колесо'));
  const callbacks = [];
  const sent = [];
  const session = { onClipboardPaste: async (data) => { sent.push(data); } };
  const bridge = {
    onVirtualRead() {}, virtualActive: async () => false,
    clipboardFiles: async () => snapshot(),
    resetClipboardFiles: async () => {}, readRich,
  };
  class ClipboardData { constructor() { this.entries = []; } addText(type, value) { this.entries.push({ type, value }); } }
  const context = { window: { rdpManager: { fileTransfer: bridge }, IronRDP: { ClipboardData } }, rdpSession: { session }, console, setInterval: (fn) => { callbacks.push(fn); return 1; }, clearInterval() {}, navigator: {} };
  vm.createContext(context);
  vm.runInContext(section + '\nthis.startSync = startRdpClipboardSync; this.sync = syncRdpClipboard; this.stopSync = stopRdpClipboardSync; this.setTransfer = (value) => { rdpFileTransfer = value; }; this.setupClipboard = setupRdpClipboard; this.clipboardState = rdpClipboardState;', context);
  return { context, callbacks, sent };
}

test('initial clipboard synchronization runs immediately without waiting for the polling timer', async () => {
  const h = setup({ snapshot: () => null, readRich: async () => ({ signature: 'a', entries: [{ type: 'text/plain', value: 'hello' }] }) });
  h.context.setTransfer({});
  h.context.startSync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].entries[0].value, 'hello');
  h.context.stopSync();
});

test('forced format refresh re-advertises unchanged copied files instead of sending text', async () => {
  const h = setup({ snapshot: () => ({ unchanged: true }), readRich: async () => { throw new Error('must not read text'); } });
  let offers = 0;
  h.context.setTransfer({ reoffer: () => { offers++; } });
  await h.context.sync(true);
  assert.equal(offers, 1);
  assert.equal(h.sent.length, 0);
});

test('a forced refresh arriving during an in-flight poll is performed after it finishes', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const h = setup({ snapshot: () => null, readRich: async () => { reads++; if (reads === 1) await gate; return { signature: 'a', entries: [] }; } });
  h.context.setTransfer({});
  const poll = h.context.sync();
  await new Promise((resolve) => setImmediate(resolve));
  await h.context.sync(true);
  release(); await poll;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(h.sent.length, 2);
});

test('callbacks from an old connection do not alter the next session clipboard state', async () => {
  const h = setup({ snapshot: () => null, readRich: async () => ({ signature: '', entries: [] }) });
  let current = true;
  let remoteCallback, forceCallback;
  const builder = { remoteClipboardChangedCallback: (fn) => { remoteCallback = fn; }, forceClipboardUpdateCallback: (fn) => { forceCallback = fn; } };
  h.context.setupClipboard(builder, () => current);
  current = false;
  await remoteCallback({ isEmpty: () => false, items: () => [{ mimeType: () => 'text/plain', value: () => 'old' }] });
  forceCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent.length, 0);
  assert.equal(h.context.clipboardState.writingRemote, false);
});
