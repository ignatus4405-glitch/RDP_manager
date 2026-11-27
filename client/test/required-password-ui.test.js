'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor() { this.events = {}; this.value = ''; this.textContent = ''; this.disabled = false; this.classes = new Set(); this.classList = { add: (x) => this.classes.add(x), remove: (x) => this.classes.delete(x), toggle: (x, flag) => flag ? this.classes.add(x) : this.classes.delete(x), contains: (x) => this.classes.has(x) }; }
  addEventListener(type, f) { this.events[type] = f; } focus() {} reset() { for (const id of ['requiredCurrentPassword', 'requiredNewPassword', 'requiredConfirmPassword']) elements[id].value = ''; }
}
let elements;
test('desktop first login forces password change and permits leaving', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const handlers = source.slice(source.indexOf("$('requiredPasswordLogout').addEventListener"), source.indexOf('/* ================= Переход между разделами'));
  const enter = source.slice(source.indexOf('async function enterApp()'), source.indexOf('/* ================= Подключения'));
  const user = { username: 'admin', role: 'admin', must_change_password: true };
  const state = { user, token: 'old', serverUrl: 'http://server' };
  let apiCalls = 0, loadCalls = 0, loggedOut = false; const storage = new Map();
  const ctx = vm.createContext({ $: (id) => elements[id], state, sessionStorage: { setItem: (k, v) => storage.set(k, v) },
    logout: () => { loggedOut = true; state.token = null; }, api: async () => { apiCalls++; return { token: 'new' }; },
    applyRoleVisibility() {}, loadConnections: async () => { loadCalls++; }, isAdmin: () => true, console });
  vm.runInContext(handlers + '\n' + enter, ctx);
  await vm.runInContext('enterApp()', ctx);
  assert.equal(elements.requiredPasswordView.classList.contains('hidden'), false);
  assert.equal(elements.appView.classList.contains('hidden'), true); assert.equal(loadCalls, 0);
  elements.requiredCurrentPassword.value = 'admin123'; elements.requiredNewPassword.value = 'newpassword'; elements.requiredConfirmPassword.value = 'mismatch';
  await elements.requiredPasswordForm.events.submit({ preventDefault() {} });
  assert.equal(apiCalls, 0); assert.equal(elements.requiredPasswordError.textContent, 'Пароли не совпадают');
  elements.requiredConfirmPassword.value = 'newpassword'; await elements.requiredPasswordForm.events.submit({ preventDefault() {} });
  assert.equal(apiCalls, 1); assert.equal(state.token, 'new'); assert.equal(storage.get('rdp_token'), 'new');
  assert.equal(state.user.must_change_password, false); assert.equal(elements.requiredPasswordView.classList.contains('hidden'), true);
  assert.equal(loadCalls, 1); assert.equal(elements.requiredCurrentPassword.value, '');
  elements.requiredPasswordLogout.events.click(); assert.equal(loggedOut, true);
});
