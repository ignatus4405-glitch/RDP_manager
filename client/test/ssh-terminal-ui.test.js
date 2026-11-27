'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Classes {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) { if (force === undefined ? !this.contains(value) : force) this.add(value); else this.remove(value); }
}
class Element {
  constructor(id = '') { this.id = id; this.children = []; this.events = {}; this.classList = new Classes(); this.style = {}; this.dataset = {}; this.value = ''; this.disabled = false; this.textContent = ''; this.open = false; }
  addEventListener(name, callback) { (this.events[name] ||= []).push(callback); }
  emit(name, extra = {}) { const event = { target: this, key: '', preventDefault() {}, stopPropagation() {}, ...extra }; for (const callback of this.events[name] || []) callback(event); }
  click() { if (!this.disabled) this.emit('click'); }
  focus() {} setAttribute() {} matches() { return false; }
  appendChild(child) { this.children.push(child); return child; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(target) { return this === target || this.children.some((c) => c.contains?.(target)); }
  getBoundingClientRect() { return { width: 250, height: 200 }; }
  querySelector() { return this.children.find((child) => !child.disabled && child.id !== 'hr') || null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit('close'); }
}
const tick = () => new Promise(setImmediate);
function label(button) { return button.children[1]?.textContent; }

test('SSH clipboard shortcuts, controls and session safety', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  const document = new Element(); document.getElementById = (id) => elements[id] || null; document.createElement = (name) => new Element(name);
  let onEvent, instance, clipboard = 'hello', copied = [], writes = [], allow = false, deferred;
  class Terminal {
    constructor() { instance = this; this.cols = 80; this.rows = 24; this.selection = ''; this.pastes = []; }
    loadAddon() {} open() {} focus() {} dispose() {} write() {} clear() { this.cleared = true; } selectAll() { this.selectedAll = true; }
    getSelection() { return this.selection; } onSelectionChange(f) { this.selectionChanged = f; } onData(f) { this.data = f; }
    attachCustomKeyEventHandler(f) { this.key = f; } paste(text) { this.pastes.push(text); this.data(text); }
  }
  const ssh = { onEvent(f) { onEvent = f; }, open: async () => ({ id: 'session' }), close: async () => {}, resize: async () => {}, write: async (...args) => { writes.push(args); } };
  const window = { addEventListener() {}, confirm: () => allow, SshTerminal: { Terminal, FitAddon: class { fit() {} } }, rdpManager: { ssh, readClipboard: () => deferred || Promise.resolve(clipboard), writeClipboard: async (s) => { copied.push(s); } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/ssh.js'), 'utf8'), { window, document, console, Date, Number, String, Uint8Array, TextEncoder });
  window.openEmbeddedSsh({ type: 'ssh', name: 'Test', address: 'example', username: 'user' });
  elements.sshForm.emit('submit'); await tick(); onEvent({ id: 'session', type: 'ready' });
  function key(key, options = {}) { return instance.key({ key, type: 'keydown', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {}, ...options }); }
  assert.equal(key('c', { ctrlKey: true }), true); // Interrupt remains with xterm.
  assert.equal(key('м', { ctrlKey: true, code: 'KeyV' }), false); await tick(); assert.deepEqual(writes[0], ['session', 'hello']);
  elements.sshTerminal.emit('contextmenu'); await tick(); assert.equal(instance.pastes.length, 2);
  instance.selection = 'selected'; instance.selectionChanged(); await tick(); assert.equal(copied.at(-1), 'selected');
  key('c', { ctrlKey: true, shiftKey: true }); await tick(); assert.equal(copied.at(-1), 'selected');
  elements.sshSelectAll.click(); elements.sshClear.click(); assert.ok(instance.selectedAll && instance.cleared);
  clipboard = 'danger\ncommand'; elements.sshPaste.click(); await tick(); assert.equal(instance.pastes.length, 2);
  allow = true; elements.sshPaste.click(); await tick(); assert.equal(instance.pastes.length, 3);
  clipboard = 'x'.repeat(60001); elements.sshPaste.click(); await tick(); assert.equal(instance.pastes.length, 3);
  let resolve; deferred = new Promise((r) => { resolve = r; }); elements.sshPaste.click(); onEvent({ id: 'session', type: 'close' }); resolve('late'); await tick(); assert.equal(instance.pastes.length, 3);
});
