'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRustDeskConfig } = require('../renderer/rustdesk-config');
const valid = { idUrl: 'wss://rd.example.com/ws/id', relayUrl: 'wss://rd.example.com/ws/relay', publicKey: Buffer.alloc(32, 42).toString('base64') };

test('validates and normalizes separate WSS endpoints and the public key', () => {
  assert.deepEqual(validateRustDeskConfig({ ...valid, idUrl: ' WSS://RD.example.com/ws/id ' }), valid);
});

test('rejects unencrypted endpoints, URL credentials and query parameters', () => {
  for (const idUrl of ['ws://rd.example.com/ws/id', 'https://rd.example.com/', 'wss://a:b@rd.example.com/ws/id', 'wss://rd.example.com/ws/id?token=abc', 'wss://rd.example.com/#x', 'garbage']) {
    assert.throws(() => validateRustDeskConfig({ ...valid, idUrl }), /Сервер ID/);
  }
  assert.throws(() => validateRustDeskConfig({ ...valid, relayUrl: 'ws://rd.example.com/' }), /relay/);
});

test('accepts only canonical base64 Ed25519 public keys', () => {
  for (const publicKey of ['', 'secret', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${'A'.repeat(42)}B=`]) {
    assert.throws(() => validateRustDeskConfig({ ...valid, publicKey }), /ключ/i);
  }
});

test('desktop direct connection maps RustDesk TCP ports to WebSocket ports', () => {
  const { directRustDeskConfig, directRelayUrl } = require('../renderer/rustdesk-config');
  assert.deepEqual(directRustDeskConfig({ server: '37.17.55.196', publicKey: valid.publicKey }), { idUrl: 'ws://37.17.55.196:21118/', fallbackRelayUrl: 'ws://37.17.55.196:21119/', publicKey: valid.publicKey });
  assert.equal(directRustDeskConfig({ server: 'server.example:30000', publicKey: valid.publicKey }).idUrl, 'ws://server.example:30002/');
  assert.equal(directRustDeskConfig({ server: 'server.example:30000', publicKey: valid.publicKey }).fallbackRelayUrl, 'ws://server.example:30003/');
  assert.equal(directRelayUrl('relay.example:21117'), 'ws://relay.example:21119/');
  assert.equal(directRelayUrl('[::1]:21117'), 'ws://[::1]:21119/');
  for (const server of ['ws://server', 'user:password@server', 'server/path', 'server:65535', 'server?token=x']) assert.throws(() => directRustDeskConfig({ server, publicKey: valid.publicKey }));
});
