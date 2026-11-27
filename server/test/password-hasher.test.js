'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPasswordHasher, DUMMY } = require('../src/password-hasher');

test('password hashing remains compatible and dummy verification does work', async () => {
  const h = createPasswordHasher();
  const stored = await h.hash('ёж пароль');
  assert.equal(await h.verify('ёж пароль', stored), true);
  assert.equal(await h.verify('wrong', stored), false);
  assert.equal(await h.verify('wrong', DUMMY), false);
});

test('hashing concurrency and pending work are bounded', async () => {
  let active = 0, max = 0;
  const release = [];
  const h = createPasswordHasher({ concurrency: 2, maxQueue: 1, derive: async (_pass, _salt, size) => {
    active++; max = Math.max(max, active);
    await new Promise((resolve) => release.push(resolve));
    active--; return Buffer.alloc(size);
  } });
  const one = h.verify('one', DUMMY), two = h.verify('two', DUMMY), three = h.verify('three', DUMMY);
  await assert.rejects(h.verify('four', DUMMY), { code: 'PASSWORD_BUSY' });
  assert.equal(active, 2);
  release.shift()(); await one;
  assert.equal(active, 2);
  release.shift()(); release.shift()(); await Promise.all([two, three]);
  assert.equal(max, 2); assert.equal(active, 0);
});
