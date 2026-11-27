'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safeRequestPath } = require('../src/request-log');

test('request logs omit all query parameters and control characters', () => {
  assert.equal(safeRequestPath('/api/connections?token=secret&password=test'), '/api/connections');
  assert.equal(safeRequestPath('/api/documents?search=private'), '/api/documents');
  assert.equal(safeRequestPath('/api/a\nforged?ticket=secret'), '/api/a?forged');
  assert.equal(safeRequestPath('/' + 'a'.repeat(3000)).length, 2048);
});
