'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseWebUrl, fillLogin } = require('../web-app-security');

test('web URL must be HTTPS and contain no URL credentials', () => {
  assert.equal(parseWebUrl('https://example.com:8443/login').origin, 'https://example.com:8443');
  for (const url of ['http://example.com/', 'file:///x', 'https://u:p@example.com/', 'https://example.com/\n', 'not a url']) assert.throws(() => parseWebUrl(url));
});
function run({ page = 'https://example.com/login', action = '/login', formCount = 1, passwords = 1, prefilled = false } = {}) {
  class Input { constructor(type) { this.type = type; this.name = type; this.autocomplete = ''; this.value = ''; this.events = []; } getClientRects() { return [1]; } dispatchEvent(event) { this.events.push(event.type); } }
  // Browser input values have a native prototype setter.
  Object.defineProperty(Input.prototype, 'value', { get() { return this._value || ''; }, set(v) { this._value = v; } });
  const user = new Input('text'); const pass = new Input('password'); if (prefilled) user.value = 'already';
  const inputs = [user, pass, ...Array.from({ length: passwords - 1 }, () => new Input('password'))];
  const form = { action, querySelectorAll(selector) { return selector === 'input' ? inputs : inputs.filter((x) => x.type === 'password'); } };
  const location = new URL(page);
  const context = { location, document: { forms: Array.from({ length: formCount }, () => form) }, HTMLInputElement: Input, URL, Event: class { constructor(type) { this.type = type; } } };
  const result = vm.runInNewContext(`(${fillLogin.toString()})('https://example.com','alice','secret')`, context);
  return { result, user, pass };
}
test('fills exactly one empty same-origin login form and fires events without submitting', () => {
  const { result, user, pass } = run(); assert.equal(result, true); assert.equal(user.value, 'alice'); assert.equal(pass.value, 'secret'); assert.deepEqual(pass.events, ['input', 'change']);
});
test('does not fill other origins, unsafe form actions, multiple or already edited forms', () => {
  for (const options of [{ page: 'https://other.com/' }, { action: 'https://other.com/login' }, { action: 'http://example.com/login' }, { formCount: 2 }, { passwords: 2 }, { prefilled: true }]) {
    const { result, pass } = run(options); assert.equal(result, false); assert.equal(pass.value, '');
  }
});
