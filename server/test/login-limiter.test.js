'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoginLimiter } = require('../src/login-limiter');
test('failed login attempts lock usernames for 15 minutes, including concurrent attempts', () => {
  let time = 0; const limiter = createLoginLimiter({ now: () => time });
  const reservations = Array.from({ length: 5 }, (_, i) => limiter.reserve('ip' + i, 'User'));
  assert.ok(reservations.every(Boolean)); assert.equal(limiter.reserve('ip6', 'USER'), null);
  reservations.forEach((finish) => finish(false));
  time = 899999; assert.equal(limiter.reserve('ip7', 'user'), null);
  time = 900000; const finish = limiter.reserve('ip7', 'user'); assert.ok(finish); finish(true);
  assert.ok(limiter.reserve('ip8', 'user'));
});
test('shared IP failure bucket and storage are bounded', () => {
  const limiter = createLoginLimiter({ maxEntries: 40 });
  for (let i = 0; i < 30; i++) { const done = limiter.reserve('one', 'user' + i); assert.ok(done); done(false); }
  assert.equal(limiter.reserve('one', 'another'), null);
  for (let i = 0; i < 9; i++) { const done = limiter.reserve('other' + i, 'new' + i); if (!done) break; done(false); }
  assert.equal(limiter.reserve('overflow', 'overflow'), null);
});
