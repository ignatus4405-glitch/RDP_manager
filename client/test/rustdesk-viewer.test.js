'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { directRustDeskConfig, directRelayUrl } = require('../renderer/rustdesk-config');
const { createRustDeskClipboardSync } = require('../renderer/rustdesk-clipboard');

function setup(protocol = 'file:') {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      const handlers = {}; const hidden = new Set();
      elements.set(id, { value: '', textContent: '', disabled: false, dataset: {}, handlers, children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); },
        classList: { add: (x) => hidden.add(x), remove: (x) => hidden.delete(x), contains: (x) => hidden.has(x), toggle: (x, enabled) => { if (enabled) hidden.add(x); else hidden.delete(x); } },
        addEventListener: (name, fn) => { handlers[name] = fn; }, focus() {}, contains: () => false, querySelector: () => ({ focus() {} }) });
    }
    return elements.get(id);
  }
  const store = new Map(); const sessions = [];
  class Session {
    constructor(options) { this.options = options; this.handlers = {}; this.canControl = true; this.permission = { clipboard: true }; this.peer = { displays: [], currentDisplay: 0 }; sessions.push(this); }
    sendClipboard(text) { this.sent = text; }
    switchDisplay(index) { this.switched = index; }
    on(name, fn) { this.handlers[name] = fn; }
    connect() { return new Promise(() => {}); }
    close() { this.closed = true; }
    async login(password) { this.password = password; }
    submitTwoFactor(code) { this.code = code; }
  }
  class Viewer { constructor() { this.handlers = {}; } on(n, f) { this.handlers[n] = f; } destroy() { this.destroyed = true; } }
  const window = { location: { protocol }, RustDeskWeb: { Session, Viewer }, RustDeskConfig: { directRustDeskConfig, directRelayUrl }, createRustDeskClipboardSync, rdpManager: { writeClipboard: async () => {}, fileTransfer: { readTextOnly: async () => null } } };
  const context = { window, document: { getElementById: element, createElement: () => ({}) }, localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) }, VideoDecoder: function () {}, EncodedVideoChunk: function () {}, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/rustdesk.js'), 'utf8'), context);
  window.openEmbeddedRustDesk({ address: '123 456', name: 'test', rustdesk_server: '37.17.55.196', rustdesk_key: Buffer.alloc(32, 42).toString('base64') });
  return { element, sessions, store, window };
}

test('desktop launches a verified direct RustDesk attempt without saving the password', async () => {
  const h = setup();
  h.element('rustdeskPassword').value = 'secret';
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  await Promise.resolve();
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


test('monitor selector follows remote screen changes and is cleared on disconnect', async () => {
  const h = setup();
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  await Promise.resolve();
  const session = h.sessions[0];
  session.peer = { displays: [{ name: 'Main', online: true }, { name: 'Second', online: true }], currentDisplay: 0 };
  session.handlers.connected({});
  const select = h.element('rustdeskDisplay');
  assert.equal(select.classList.contains('hidden'), false);
  assert.equal(select.children.length, 2);
  select.handlers.change({ target: { value: '1' } });
  assert.equal(session.switched, 1);
  session.peer.currentDisplay = 1;
  session.handlers.display({});
  assert.equal(select.value, '1');
  h.window.closeEmbeddedRustDesk();
  assert.equal(select.classList.contains('hidden'), true);
  assert.equal(select.children.length, 0);
});

test('per-connection configuration takes precedence, old cards retain local fallback', async () => {
  const h = setup();
  const key = Buffer.alloc(32, 42).toString('base64');
  h.store.set('rustdesk_server', 'legacy.example');
  h.store.set('rustdesk_public_key', key);
  h.window.openEmbeddedRustDesk({ address: '123', rustdesk_server: 'new.example', rustdesk_key: key });
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(h.sessions.at(-1).options.server.rendezvousUrl, 'ws://new.example:21118/');
  h.window.openEmbeddedRustDesk({ address: '456', rustdesk_server: '', rustdesk_key: '' });
  void h.element('rustdeskForm').handlers.submit({ preventDefault() {} });
  await Promise.resolve();
  assert.equal(h.sessions.at(-1).options.server.rendezvousUrl, 'ws://legacy.example:21118/');
});
