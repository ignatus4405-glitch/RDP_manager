'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../renderer/rustdesk-file-protocol');
const { createRustDeskFileClipboard } = require('../renderer/rustdesk-file-clipboard');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('RustDesk clipboard wire fields and Windows file descriptors round trip', () => {
  const files = [ { name: 'Папка', size: 0, isDirectory: true }, { name: 'данные.txt', path: 'Папка', size: 0x100000005, isDirectory: false } ];
  const descriptors = protocol.encodeDescriptors(files);
  assert.equal(descriptors.length, 4 + 2 * 592);
  const view = new DataView(descriptors.buffer, descriptors.byteOffset, descriptors.byteLength);
  for (const offset of [4, 4 + 592]) {
    assert.equal(view.getUint32(offset, true) & 0x4000, 0x4000, 'request the Shell progress UI');
    assert.equal(view.getUint32(offset, true) >>> 31, 1, 'descriptors are Unicode');
  }
  assert.deepEqual(protocol.decodeDescriptors(descriptors), files.map((f) => ({ ...f, path: f.path })));
  const request = { streamId: 77, index: 1, flags: 2, positionLow: -1, positionHigh: 2, size: 5, haveClipDataId: 1, clipDataId: -123 };
  assert.deepEqual(protocol.decode(protocol.encode('fileContentsRequest', request)), { kind: 'fileContentsRequest', value: { ...request, haveClipDataId: true } });
  assert.equal(protocol.fileListId(new TextEncoder().encode('foobar')) >>> 0, 0xbf9cf968);
  assert.throws(() => protocol.decode(Uint8Array.from([0x32, 0x80])));
  assert.throws(() => protocol.decodeDescriptors(descriptors.subarray(0, descriptors.length - 1)));
});

function harness() {
  let files = null, isVirtual = false, readHandler, currentToken = 0;
  const sent = [], responses = [], published = [], errors = [], publishOptions = [];
  const bridge = {
    onVirtualRead(fn) { readHandler = fn; return () => { readHandler = null; }; },
    async virtualActive() { return isVirtual; },
    async clipboardFiles() { const result = files; if (files && !files.unchanged) files = { unchanged: true }; return result; },
    async readClipboardFile(_id, pos, size) { return Uint8Array.from([1, 2, 3, 4].slice(pos, pos + size)); },
    async virtualPublish(entries, fingerprint, asyncMode) { published.push(entries); publishOptions.push({ fingerprint, asyncMode }); isVirtual = true; return String(++currentToken); },
    async clipboardFingerprint() { return 'baseline'; },
    async virtualActivate() {}, async virtualClear() { isVirtual = false; },
    async virtualRespond(response) { responses.push(response); }, async resetClipboardFiles() {},
  };
  const sync = createRustDeskFileClipboard({ protocol, bridge, send: (bytes) => sent.push(protocol.decode(bytes)), canSend: () => true, setTimer: () => 1, clearTimer: () => {}, onError: (e) => errors.push(e) });
  return { sync, sent, published, publishOptions, responses, errors, setFiles: (x) => { files = x; }, remote: (kind, value) => sync.receive(protocol.encode(kind, value)), read: (r) => readHandler(r) };
}

test('local copied files are offered and bytes are served only on request', async () => {
  const h = harness(); h.setFiles({ files: [{ id: 'cap', name: 'a.txt', size: 4, isDirectory: false }] });
  h.sync.start(); await tick();
  assert.deepEqual(h.sent.map((x) => x.kind), ['ready', 'formatList']);
  h.remote('formatDataRequest', { formatId: 49334 });
  const data = h.sent.at(-1).value.data; assert.equal(protocol.decodeDescriptors(data)[0].name, 'a.txt');
  h.remote('fileContentsRequest', { streamId: 4, index: 0, flags: 2, positionLow: 1, positionHigh: 0, size: 2, haveClipDataId: 1, clipDataId: protocol.fileListId(data) });
  await tick(); assert.deepEqual([...h.sent.at(-1).value.data], [2, 3]);
  h.remote('fileContentsRequest', { streamId: 5, index: 0, flags: 2, size: 2, haveClipDataId: 1, clipDataId: 123 });
  await tick(); assert.equal(h.sent.at(-1).value.flags, 2);
  h.sync.stop(); await tick(); assert.equal(h.errors.length, 0);
});

test('remote files are published as OLE metadata and downloaded only on paste read', async () => {
  const h = harness(); h.sync.start(); await tick();
  h.remote('formatList', { formats: [{ id: 35, name: 'FileGroupDescriptorW' }, { id: 36, name: 'FileContents' }] });
  await tick(); assert.equal(h.sent.at(-1).kind, 'formatDataRequest');
  const descriptors = protocol.encodeDescriptors([{ name: 'report.txt', size: 4, isDirectory: false }]);
  h.remote('formatDataResponse', { flags: 1, data: descriptors }); await tick();
  assert.equal(h.published[0][0].name, 'report.txt');
  assert.deepEqual(h.publishOptions[0], { fingerprint: 'baseline', asyncMode: true });
  assert.equal(h.sent.filter((x) => x.kind === 'fileContentsRequest').length, 0);
  const read = h.read({ token: '1', requestId: 'r', index: 0, position: 1, size: 2 });
  const req = h.sent.at(-1); assert.equal(req.kind, 'fileContentsRequest');
  assert.equal(req.value.clipDataId, protocol.fileListId(descriptors));
  h.remote('fileContentsResponse', { streamId: req.value.streamId, flags: 1, data: Uint8Array.from([2, 3]) });
  await read; assert.deepEqual([...h.responses[0].bytes], [2, 3]);
  h.sync.stop(); await tick(); assert.equal(h.errors.length, 0);
});

test('clipboard replacement rejects an outstanding virtual read and ignores its late response', async () => {
  const h = harness(); h.sync.start(); await tick();
  h.remote('formatList', { formats: [{ id: 10, name: 'FileGroupDescriptorW' }, { id: 11, name: 'FileContents' }] });
  await tick(); h.remote('formatDataResponse', { flags: 1, data: protocol.encodeDescriptors([{ name: 'a', size: 4, isDirectory: false }]) }); await tick();
  const read = h.read({ token: '1', requestId: 'old', index: 0, position: 0, size: 2 });
  const req = h.sent.at(-1);
  h.remote('tryEmpty'); await read;
  assert.equal(h.responses[0].error, true);
  h.remote('fileContentsResponse', { streamId: req.value.streamId, flags: 1, data: Uint8Array.from([1, 2]) });
  assert.equal(h.responses.length, 1);
  h.sync.stop(); await tick();
});

test('stale descriptor response cannot publish after a newer remote offer', async () => {
  const h = harness(); h.sync.start(); await tick();
  const offer = (id) => h.remote('formatList', { formats: [{ id, name: 'FileGroupDescriptorW' }, { id: id + 1, name: 'FileContents' }] });
  offer(20); await tick(); offer(30); await tick();
  h.remote('formatDataResponse', { flags: 1, data: protocol.encodeDescriptors([{ name: 'old', size: 1, isDirectory: false }]) });
  assert.equal(h.sent.at(-1).value.formatId, 30);
  h.remote('formatDataResponse', { flags: 1, data: protocol.encodeDescriptors([{ name: 'new', size: 2, isDirectory: false }]) });
  await tick(); assert.deepEqual(h.published.map((items) => items[0].name), ['new']);
  h.sync.stop(); await tick();
});
