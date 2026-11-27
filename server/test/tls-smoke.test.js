'use strict';
// The certificate in fixtures is deliberately a test-only self-signed cert;
// bypassing verification is confined to this test client, never production.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function port() { return new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const n = srv.address().port; srv.close(() => resolve(n)); }); }); }
function request(p, target, method = 'GET', body, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port: p, path: target, method, rejectUnauthorized: false, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text), headers: res.headers }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
}
test('server supports TLS and encrypted connection secrets on the HTTPS endpoint', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdpm-tls-')); const p = await port();
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '../src/index.js')], { env: { ...process.env, RDP_MANAGER_PORT: String(p), RDP_MANAGER_HOST: '127.0.0.1', RDP_MANAGER_DATA: dir, RDP_MANAGER_TLS_CERT: path.join(__dirname, 'fixtures/rdp-test-cert.pem'), RDP_MANAGER_TLS_KEY: path.join(__dirname, 'fixtures/rdp-test-key.pem') }, stdio: 'ignore' });
  t.after(async () => { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]); fs.rmSync(dir, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 60; i++) { try { const response = await request(p, '/api/health'); if (response.status === 200) { ready = true; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.equal(ready, true);
  assert.equal((await request(p, '/api/health')).headers['strict-transport-security'], 'max-age=31536000');
  const login = await request(p, '/api/login', 'POST', { username: 'admin', password: 'admin123' }); let token = login.data.token;
  assert.equal(login.status, 200);
  const changed = await request(p, '/api/change-password', 'POST', { current_password: 'admin123', new_password: 'newpassword' }, token);
  assert.equal(changed.status, 200); token = changed.data.token;
  const created = await request(p, '/api/connections', 'POST', { type: 'rdp', name: 'TLS', address: 'example.test' }, token);
  const url = `/api/connections/${created.data.connection.id}/secret`;
  assert.equal((await request(p, url, 'PUT', { password: 'secret over tls' }, token)).status, 200);
  assert.equal((await request(p, url, 'GET', undefined, token)).data.password, 'secret over tls');
});
