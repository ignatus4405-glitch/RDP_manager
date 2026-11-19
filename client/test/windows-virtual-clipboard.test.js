'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { createWindowsVirtualClipboard } = require('../windows-virtual-clipboard');

function makeHost() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  return child;
}

test('OLE host publishes metadata, then requests bytes only after activation', async () => {
  const hosts = []; const requests = [];
  const bridge = createWindowsVirtualClipboard({ executable: 'helper.exe', sendRequest: (request) => requests.push(request), spawnProcess: () => { const child = makeHost(); hosts.push(child); return child; } });
  const publishing = bridge.publish([{ name: 'folder', size: 0, isDirectory: true }, { name: 'a.txt', path: 'folder', size: 3 }]);
  const host = hosts[0];
  let input = ''; host.stdin.on('data', (data) => { input += data.toString(); });
  host.stdout.write('READY\n');
  const token = await publishing;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.isActive(), true);
  assert.match(input, /^2\n0 1 /);
  host.stdout.write('READ 1 0 3\n');
  assert.equal(requests.length, 0);
  bridge.activate(token);
  assert.equal(requests.length, 1);
  assert.deepEqual({ index: requests[0].index, position: requests[0].position, size: requests[0].size }, { index: 1, position: 0, size: 3 });
  assert.equal(bridge.respond({ token: 'wrong', requestId: requests[0].requestId, bytes: Buffer.from('abc') }), false);
  assert.equal(bridge.respond({ token, requestId: requests[0].requestId, bytes: Buffer.from('abc') }), true);
  assert.match(input, /\+YWJj\n$/);
  bridge.clear();
  assert.equal(host.killed, true);
  assert.equal(bridge.isActive(), false);
});

test('OLE host validates untrusted paths and rejects invalid reads', async () => {
  const hosts = [];
  const bridge = createWindowsVirtualClipboard({ executable: 'helper.exe', sendRequest: () => assert.fail('must not request invalid data'), spawnProcess: () => { const child = makeHost(); hosts.push(child); return child; } });
  await assert.rejects(bridge.publish([{ path: '../bad', name: 'a', size: 2 }]), /недопустим/i);
  await assert.rejects(bridge.publish([{ name: 'a', size: -1 }]), /метаданные/i);
  const publishing = bridge.publish([{ name: 'a', size: 2 }]);
  hosts[0].stdout.write('READY\n');
  const token = await publishing;
  bridge.activate(token);
  hosts[0].stdout.write('READ 0 0 3\n');
  assert.equal(hosts[0].killed, true);
  assert.equal(bridge.isActive(), false);
});
