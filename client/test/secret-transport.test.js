'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canSendConnectionSecret } = require('../renderer/secret-transport');

test('passwords are never sent to a remote plaintext server', () => {
  for (const url of ['https://server.example:8720', 'http://localhost:8720', 'http://127.0.0.1:8720', 'http://[::1]:8720']) assert.equal(canSendConnectionSecret(url), true, url);
  for (const url of ['http://server.example:8720', 'http://192.0.2.10', 'https://user:pass@example.com', 'file:///tmp/x', 'garbage']) assert.equal(canSendConnectionSecret(url), false, url);
});
