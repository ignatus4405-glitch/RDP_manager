'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { Server } = require('ssh2');
const { createSshSession } = require('../ssh-session');

test('SSH verifies the host key before sending a password and supports a shell', { timeout: 15000 }, async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let passwords = 0;
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => { if (ctx.method === 'password') { passwords++; return ctx.username === 'user' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(); } ctx.reject(); });
    client.on('ready', () => client.on('session', (accept) => {
      const session = accept(); session.on('pty', (accept) => accept()); session.on('window-change', (accept) => accept?.());
      session.on('shell', (accept) => { const stream = accept(); stream.write('hello'); stream.on('data', (data) => stream.write(data)); });
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; let acceptKey = false; let fingerprint;
  const events = []; let notify;
  const ssh = createSshSession({ verifyHost: async (key) => { fingerprint = key.fingerprint; return acceptKey; }, emit: (event) => { events.push(event); notify?.(); }, chooseUpload: async () => null, chooseDownload: async () => null, confirmOverwrite: async () => false });
  async function wait(type) { while (!events.some((event) => event.type === type)) await new Promise((resolve) => { notify = resolve; }); return events.find((event) => event.type === type); }
  try {
    ssh.open({ host: '127.0.0.1', port, username: 'user', password: 'secret', mode: 'ssh' });
    await wait('error'); assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/); assert.equal(passwords, 0);
    events.length = 0; acceptKey = true;
    const { id } = ssh.open({ host: '127.0.0.1', port, username: 'user', password: 'secret', mode: 'ssh' });
    await wait('ready'); assert.equal(passwords, 1); ssh.write(id, 'world');
    while (!events.filter((e) => e.type === 'data').some((e) => Buffer.from(e.bytes).toString().includes('world'))) await new Promise((resolve) => { notify = resolve; });
    ssh.resize(id, 80, 24);
  } finally { ssh.close(); server.close(); }
});
