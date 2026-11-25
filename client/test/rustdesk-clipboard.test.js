'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRustDeskClipboardSync } = require('../renderer/rustdesk-clipboard');

function harness() {
  let text = 'local'; let sent = []; let writes = []; let enabled = true;
  const sync = createRustDeskClipboardSync({ read: async () => text, write: async (value) => { text = value; writes.push(value); }, send: (value) => sent.push(value), canSend: () => enabled, setTimer: () => 1, clearTimer() {}, onError: (e) => { throw e; } });
  return { sync, sent, writes, setText: (v) => { text = v; }, enable: (v) => { enabled = v; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
test('text syncs in both directions without echo and skips file/non-text snapshots', async () => {
  const h = harness(); h.sync.start(); await tick();
  assert.deepEqual(h.sent, ['local']);
  h.sync.remote('remote'); await tick();
  assert.deepEqual(h.writes, ['remote']);
  assert.deepEqual(h.sent, ['local']);
  h.setText(null); await h.sync.poll();
  assert.deepEqual(h.sent, ['local']);
  h.setText('another'); await h.sync.poll();
  assert.deepEqual(h.sent, ['local', 'another']);
  h.enable(false); h.setText('private'); await h.sync.poll();
  assert.equal(h.sent.length, 2);
  h.sync.stop(); h.sync.remote('stale'); await tick();
  assert.deepEqual(h.writes, ['remote']);
});

test('an in-flight read from the old session cannot overwrite a remote copy', async () => {
  let resolveRead; const sent = []; const writes = [];
  const sync = createRustDeskClipboardSync({ read: () => new Promise((r) => { resolveRead = r; }), write: async (v) => writes.push(v), send: (v) => sent.push(v), canSend: () => true, setTimer: () => 1, clearTimer() {} });
  sync.start();
  sync.remote('remote');
  resolveRead('stale');
  await tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(writes, ['remote']);
  sync.stop();
});
