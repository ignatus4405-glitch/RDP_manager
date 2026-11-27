'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { HTTP_TIMEOUT_OPTIONS } = require('../src/http-timeouts');

test('HTTP and HTTPS use bounded timeouts without applying a session inactivity timeout', () => {
  assert.equal(HTTP_TIMEOUT_OPTIONS.headersTimeout, 30_000);
  assert.equal(HTTP_TIMEOUT_OPTIONS.requestTimeout, 120_000);
  assert.equal(HTTP_TIMEOUT_OPTIONS.connectionsCheckingInterval, 5_000);
  const source = fs.readFileSync(path.join(__dirname, '../src/index.js'), 'utf8');
  assert.match(source, /https\.createServer\(\{ \.\.\.HTTP_TIMEOUT_OPTIONS,/);
  assert.match(source, /http\.createServer\(HTTP_TIMEOUT_OPTIONS, app\)/);
  assert.doesNotMatch(source, /server\.setTimeout\(/);
});

test('incomplete headers and bodies are rejected while normal HTTP still works', async (t) => {
  // Shorter timeouts exercise the same Node HTTP parser behavior without a long test.
  const server = http.createServer({ ...HTTP_TIMEOUT_OPTIONS, headersTimeout: 150, requestTimeout: 350, connectionsCheckingInterval: 50 }, (req, res) => {
    req.resume(); req.on('end', () => res.end('ok'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  async function incomplete(request) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
      let response = '';
      socket.setEncoding('utf8'); socket.setTimeout(4000, () => socket.destroy(new Error('server did not close timed-out request')));
      socket.on('data', (data) => { response += data; }); socket.on('end', () => resolve(response)); socket.on('error', reject);
    });
  }
  const [headers, body] = await Promise.all([
    incomplete('GET / HTTP/1.1\r\nHost: example'),
    incomplete('POST / HTTP/1.1\r\nHost: example\r\nContent-Length: 10\r\n\r\na'),
  ]);
  assert.match(headers, /^HTTP\/1\.1 408/);
  assert.match(body, /^HTTP\/1\.1 408/);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'ok');
});

test('HTTP receive limits do not disconnect an upgraded idle WebSocket', async (t) => {
  const { WebSocketServer, WebSocket } = require('ws');
  const server = http.createServer({ ...HTTP_TIMEOUT_OPTIONS, headersTimeout: 150, requestTimeout: 350, connectionsCheckingInterval: 50 });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket) => socket.on('message', (message) => socket.send(message)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/`);
  t.after(async () => {
    client.terminate(); for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(client.readyState, WebSocket.OPEN);
  const received = new Promise((resolve, reject) => { client.once('message', (data) => resolve(data.toString())); client.once('error', reject); });
  client.send('still connected');
  assert.equal(await received, 'still connected');
});
