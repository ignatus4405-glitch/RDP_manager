'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() { this.style = {}; this.events = {}; this.value = ''; this.textContent = ''; this.innerHTML = ''; this.disabled = false; }
  addEventListener(type, fn) { this.events[type] = fn; }
  reset() { for (const id of ['requiredCurrent', 'requiredNew', 'requiredConfirm']) elements[id].value = ''; }
  focus() {}
}
let elements;
test('server admin panel forces password change before loading dashboard', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
  elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const document = { getElementById: (id) => elements[id] };
  const data = new Map(); const sessionStorage = { getItem: (k) => data.get(k), setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  let change = false, calls = [];
  const fetch = async (url, opts) => {
    calls.push([url, opts]);
    const result = url === '/api/login' ? { token: 'old', user: { id: 1, username: 'admin', role: 'admin', must_change_password: true } }
      : url === '/api/me' ? { user: { id: 1, username: 'admin', role: 'admin', must_change_password: !change } }
      : url === '/api/change-password' ? (change = true, { token: 'new' })
      : url === '/api/users' ? { users: [] } : { connections: 0, users: 0, documents: 0, admins: 0 };
    return { ok: true, status: 200, json: async () => result };
  };
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const ctx = vm.createContext({ document, sessionStorage, fetch, setTimeout() {}, console });
  vm.runInContext(script, ctx);
  elements.lUser.value = 'admin'; elements.lPass.value = 'admin123';
  await vm.runInContext('login()', ctx); await new Promise(setImmediate);
  assert.equal(elements.requiredPasswordView.style.display, 'block');
  assert.equal(elements.appView.style.display, 'none');
  assert.equal(calls.some(([url]) => url === '/api/stats'), false);
  elements.requiredCurrent.value = 'admin123'; elements.requiredNew.value = 'password'; elements.requiredConfirm.value = 'different';
  await elements.requiredPasswordForm.events.submit({ preventDefault() {} });
  assert.equal(elements.requiredError.textContent, 'Пароли не совпадают');
  assert.equal(calls.some(([url]) => url === '/api/change-password'), false);
  elements.requiredConfirm.value = 'password'; await elements.requiredPasswordForm.events.submit({ preventDefault() {} }); await new Promise(setImmediate);
  assert.equal(data.get('rdp_admin_token'), 'new');
  assert.equal(elements.requiredPasswordView.style.display, 'none');
  assert.equal(elements.appView.style.display, 'block');
  assert.equal(elements.requiredCurrent.value, ''); assert.equal(elements.lPass.value, '');
  assert.ok(calls.some(([url]) => url === '/api/stats'));
});
