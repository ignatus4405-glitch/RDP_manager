'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rdpCredentials } = require('../renderer/rdp-credentials');

test('RDP domain is separated for embedded authentication and qualified for external clients', () => {
  assert.deepEqual(rdpCredentials(' alice ', ' ACME '), { username: 'alice', domain: 'ACME', qualifiedUsername: 'ACME\\alice' });
  assert.deepEqual(rdpCredentials('alice', ''), { username: 'alice', domain: '', qualifiedUsername: 'alice' });
  assert.deepEqual(rdpCredentials('OTHER\\alice', 'ACME'), { username: 'OTHER\\alice', domain: '', qualifiedUsername: 'OTHER\\alice' });
  assert.deepEqual(rdpCredentials('alice@example.test', 'ACME'), { username: 'alice@example.test', domain: '', qualifiedUsername: 'alice@example.test' });
  assert.throws(() => rdpCredentials('alice', 'domain\\bad'));
  assert.throws(() => rdpCredentials('alice\nwrong', 'domain'));
});
