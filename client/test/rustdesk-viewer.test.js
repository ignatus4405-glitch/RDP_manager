'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { directRustDeskConfig, directRelayUrl } = require('../renderer/rustdesk-config');

function setup(protocol = 'file:') {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const handlers = {}; const hidden = new Set();
      elements.set(id, { value: '', textContent: '', disabled: false, dataset: {}, handlers,
        classList: { add: (x) => hidden.add(x), remove: (x) => hidden.delete(x), contains: (x) => hidden.has(x) },
        addEventListener: (name, fn) => { handlers[name] = fn; }, focus() {}, contains: () => false, querySelector: () => ({ focus() {} }) });
    }
    return elements.get(id);
  }
  const store = new Map(); const sessions = [];
  class Session {
    constructor(options) { this.options = options; this.handlers = {}; sessions.push(this); }
    on(name, fn) { this.handlers[name] = fn; }
    connect() { return new Promise(() => {}); }
    close() { this.closed = true; }
    async login(password) { this.password = password; }
    submitTwoFactor(code) { this.code = code; }
  }
  class Viewer { constructor() { this.handlers = {}; } on(n, f) { this.handlers[n] = f; } destroy() { this.destroyed = true; } }
  const window = { location: { protocol }, RustDeskWeb: { Session, Viewer }, RustDeskConfig: { directRustDeskConfig, directRelayUrl }, rdpManager: { writeClipboard: async () => {} } };
  const context = { window, document: { getElementById: element }, localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) }, VideoDecoder: function () {}, EncodedVideoChunk: function () {}, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/rustdesk.js'), 'utf8'), context);
  window.openEmbeddedRustDesk({ address: '123 456', name: 'test' });
  element('rustdeskServer').value = '37.17.55.196';
  element('rustdeskKey').value = Buffer.alloc(32, 42).toString('base64');
  return { element, sessions, store, window };
}

test('desktop launches a verified direct RustDesk attempt without saving the password', async () => {
  const h = setup();
  h.element('rustdeskPassword').value = 'secret';
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  const session = h.sessions[0];
  assert.equal(session.options.peerId, '123456');
  assert.equal(session.options.server.rendezvousUrl, 'ws://37.17.55.196:21118/');
  assert.equal(session.options.server.relayUrl('37.17.55.196:21117'), 'ws://37.17.55.196:21119/');
  assert.equal(session.options.server.relayUrl(''), 'ws://37.17.55.196:21119/');
  assert.equal(h.element('rustdeskPassword').value, '');
  assert.equal([...h.store.values()].includes('secret'), false);
  session.handlers.password({ wrong: false });
  await Promise.resolve();
  assert.equal(session.password, 'secret');
  session.handlers.connected({});
  assert.equal(h.element('rustdeskStatus').textContent, 'Подключено');
  h.window.closeEmbeddedRustDesk();
  assert.equal(session.closed, true);
  session.handlers.connected({});
  assert.equal(h.element('rustdeskStatus').textContent, 'Отключено');
});

test('does not open insecure WebSockets in the browser', () => {
  const h = setup('https:');
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  assert.equal(h.sessions.length, 0);
  assert.match(h.element('rustdeskError').textContent, /десктоп/);
});
