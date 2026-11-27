'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const DUMMY = `scrypt$16384$${'00'.repeat(16)}$${'00'.repeat(64)}`;

// Bound both running work and the queue, so a flood cannot retain passwords
// indefinitely or allocate unlimited scrypt memory.
function createPasswordHasher({ concurrency = 4, maxQueue = 64, derive = scrypt } = {}) {
  let running = 0;
  const queue = [];
  async function run(task) {
    if (running >= concurrency) {
      if (queue.length >= maxQueue) { const error = new Error('Очередь проверки паролей заполнена.'); error.code = 'PASSWORD_BUSY'; throw error; }
      await new Promise((resolve) => queue.push(resolve));
    } else running++;
    try { return await task(); }
    finally { const next = queue.shift(); if (next) next(); else running--; }
  }
  async function hash(password) {
    const salt = crypto.randomBytes(16);
    const result = await run(() => derive(String(password), salt, 64, { N: 16384, r: 8, p: 1 }));
    return `scrypt$16384$${salt.toString('hex')}$${result.toString('hex')}`;
  }
  async function verify(password, stored) {
    const [scheme, nStr, saltHex, hashHex] = String(stored || '').split('$');
    // The application only creates hashes with these parameters; reject
    // malformed records before running attacker-controlled work factors.
    if (scheme !== 'scrypt' || nStr !== '16384' || !/^[a-f0-9]{32}$/i.test(saltHex || '') || !/^[a-f0-9]{128}$/i.test(hashHex || '')) return false;
    const salt = Buffer.from(saltHex, 'hex'), expected = Buffer.from(hashHex, 'hex');
    const result = await run(() => derive(String(password), salt, expected.length, { N: 16384, r: 8, p: 1 }));
    return crypto.timingSafeEqual(result, expected);
  }
  return { hash, verify };
}
module.exports = { createPasswordHasher, DUMMY };
