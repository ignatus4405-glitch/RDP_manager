'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRdpFileTransfer } = require('../renderer/rdp-file-transfer');

class Extension { constructor(name, value) { this.name = name; this.value = value; } }
function harness() {
  const callbacks = {};
  const sent = [];
  const saved = [];
  const session = { invokeExtension: (ext) => sent.push(ext) };
  const transfer = createRdpFileTransfer({ getSession: () => session, Extension, onStatus() {}, openFile: async (name) => {
    const chunks = [];
    return { write: async (chunk) => chunks.push(Buffer.from(chunk)), close: async () => saved.push({ name, bytes: Buffer.concat(chunks) }), abort: async () => {} };
  } });
  transfer.setup({ extension: (ext) => { callbacks[ext.name] = ext.value; } });
  return { transfer, callbacks, sent, saved };
}

test('explicit local file offer serves bounded requested content', async () => {
  const { transfer, callbacks, sent } = harness();
  const file = new Blob(['hello']);
  Object.defineProperty(file, 'name', { value: 'hello.txt' });
  Object.defineProperty(file, 'lastModified', { value: 123 });
  transfer.offer([file]);
  assert.equal(sent[0].name, 'initiate_file_copy');
  await callbacks.file_contents_request_callback({ streamId: 1, index: 0, flags: 2, position: 1, size: 3 });
  assert.equal(Buffer.from(sent[1].value.data).toString(), 'ell');
  await callbacks.file_contents_request_callback({ streamId: 2, index: 9, flags: 2, position: 0, size: 3 });
  assert.equal(sent[2].value.is_error, true);
  assert.doesNotThrow(() => transfer.offer(Array.from({ length: 20 }, (_, i) => ({ name: `${i}.bin`, size: 65 * 1024 * 1024 }))));
});

test('remote file download requests bounded chunks and sanitizes names', async () => {
  const { transfer, callbacks, sent, saved } = harness();
  callbacks.files_available_callback([{ name: '../unsafe.txt', fileSize: 5 }], 7);
  const result = transfer.download();
  const sizeRequest = sent.at(-1).value;
  assert.equal(sizeRequest.flags, 1);
  const size = Buffer.alloc(8); size.writeBigUInt64LE(5n);
  callbacks.file_contents_response_callback({ streamId: sizeRequest.stream_id, data: size });
  await new Promise((resolve) => setImmediate(resolve));
  const contentRequest = sent.at(-1).value;
  assert.equal(contentRequest.flags, 2);
  assert.equal(contentRequest.size, 5);
  callbacks.file_contents_response_callback({ streamId: contentRequest.stream_id, data: Buffer.from('hello') });
  await result;
  assert.equal(saved[0].name, 'unsafe.txt');
  assert.equal(saved[0].bytes.toString(), 'hello');
});

test('disconnect rejects an in-flight remote file request', async () => {
  const { transfer, callbacks } = harness();
  callbacks.files_available_callback([{ name: 'a.txt' }], 1);
  const promise = transfer.download();
  transfer.reset();
  await assert.rejects(promise, /сессия RDP завершена/i);
});

test('remote clipboard streams files and folders into a local clipboard receiver', async () => {
  const callbacks = {};
  const calls = [];
  let done;
  const finished = new Promise((resolve) => { done = resolve; });
  const receiver = {
    begin: async (files) => { calls.push(['begin', files]); return 'transfer'; },
    open: async (_id, index) => { calls.push(['open', index]); },
    write: async (_id, index, data) => { calls.push(['write', index, Buffer.from(data).toString()]); },
    close: async (_id, index) => { calls.push(['close', index]); },
    commit: async () => { calls.push(['commit']); },
    cancel: async () => { calls.push(['cancel']); },
  };
  const session = { invokeExtension(ext) {
    if (ext.name !== 'request_file_contents') return;
    const request = ext.value;
    const data = request.flags === 1 ? Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]) : Buffer.from('abc');
    queueMicrotask(() => callbacks.file_contents_response_callback({ streamId: request.stream_id, data }));
  } };
  const transfer = createRdpFileTransfer({ getSession: () => session, Extension, onStatus() {}, clipboardReceiver: receiver, onClipboardFinished: done });
  transfer.setup({ extension: (ext) => { callbacks[ext.name] = ext.value; } });
  callbacks.files_available_callback([{ name: 'folder', isDirectory: true }, { name: 'x.txt', path: 'folder' }], 4);
  assert.equal(await finished, true);
  assert.deepEqual(calls.slice(1), [['open', 0], ['open', 1], ['write', 1, 'abc'], ['close', 1], ['commit']]);
});

test('virtual clipboard reads remote data only on demand and serializes consumers', async () => {
  const { transfer, callbacks, sent } = harness();
  callbacks.files_available_callback([{ name: 'x.txt', fileSize: 6 }], 11);
  const offer = transfer.virtualOffer();
  assert.equal(sent.length, 0);
  const a = offer.read(0, 0, 3);
  const b = offer.read(0, 3, 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value.position, 0);
  callbacks.file_contents_response_callback({ streamId: sent[0].value.stream_id, data: Buffer.from('abc') });
  assert.equal(Buffer.from(await a).toString(), 'abc');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 2);
  assert.equal(sent[1].value.position, 3);
  callbacks.file_contents_response_callback({ streamId: sent[1].value.stream_id, data: Buffer.from('def') });
  assert.equal(Buffer.from(await b).toString(), 'def');
  callbacks.files_available_callback([{ name: 'other.txt' }], 12);
  await assert.rejects(offer.read(0, 0, 1), /буфер или сессия изменились/i);
  assert.equal(sent.length, 2);
});

test('virtual clipboard rejects stale in-flight and invalid reads', async () => {
  const { transfer, callbacks, sent } = harness();
  callbacks.files_available_callback([{ name: 'a' }, { name: 'folder', isDirectory: true }], 1);
  const offer = transfer.virtualOffer();
  await assert.rejects(offer.read(1, 0, 2), /некорректный запрос/i);
  await assert.rejects(offer.read(0, -1, 2), /некорректный запрос/i);
  const read = offer.read(0, 0, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  callbacks.files_available_callback([{ name: 'b' }], 2);
  await assert.rejects(read, /удалённый буфер изменился/i);
  assert.equal(sent.length, 1);
});
