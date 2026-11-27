'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTicketStore } = require('../src/rdp-tickets');

test('tickets expire, are single-use, bind to a peer and have bounded capacity', () => {
  let time = 0; const store = createTicketStore({ now: () => time, ttl: 30000, capacity: 2 });
  const one = store.issue({ ip: 'ip1', userId: 1, connectionId: 12 });
  const two = store.issue({ ip: 'ip2', userId: 2, connectionId: 13 });
  assert.equal(store.issue({ ip: 'ip3' }), null);
  assert.equal(store.consume(one, 'wrong'), null);
  assert.equal(store.consume(one, 'ip1'), null);
  assert.equal(store.consume(two, 'ip2').connectionId, 13);
  assert.equal(store.consume(two, 'ip2'), null);
  const three = store.issue({ ip: 'ip3' }); time = 30000;
  assert.equal(store.consume(three, 'ip3'), null);
  assert.ok(store.issue({ ip: 'ip4' }));
});
