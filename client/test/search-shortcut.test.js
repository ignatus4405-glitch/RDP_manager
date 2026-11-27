'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
const handler = source.slice(source.indexOf('function handleConnectionSearchShortcut'), source.indexOf('function applyRoleVisibility'));

function setup() {
  const ids = ['appView', 'loginView', 'requiredPasswordView', 'modalBackdrop', 'rdpOverlay', 'rustdeskOverlay', 'sshOverlay', 'webOverlay', 'connSearch'];
  const elements = Object.fromEntries(ids.map((id) => [id, { hidden: id !== 'appView', classList: { contains(name) { return name === 'hidden' && elements[id].hidden; } } }]));
  let focus = 0, clicks = 0, listener, dialog = false;
  elements.connSearch.focus = () => { focus++; };
  const document = { querySelector(selector) { return selector === 'dialog[open]' ? (dialog ? {} : null) : { click() { clicks++; } }; }, addEventListener(type, cb) { if (type === 'keydown') listener = cb; } };
  vm.runInNewContext(handler, { document, $: (id) => elements[id] });
  const trigger = (attrs = {}) => {
    let prevented = false;
    const event = { ctrlKey: true, code: 'KeyK', target: {}, preventDefault() { prevented = true; }, ...attrs };
    listener(event); return prevented;
  };
  return { elements, trigger, setDialog: (value) => { dialog = value; }, get focus() { return focus; }, get clicks() { return clicks; } };
}

test('Ctrl+K opens connections and focuses search, including non-Latin layouts', () => {
  const app = setup();
  assert.equal(app.trigger({ key: 'л' }), true);
  assert.equal(app.clicks, 1); assert.equal(app.focus, 1);
  assert.equal(app.trigger({ target: app.elements.connSearch }), true);
});

test('shortcut does not interrupt sessions, login, dialogs or text editing', () => {
  const app = setup();
  for (const id of ['modalBackdrop', 'rdpOverlay', 'rustdeskOverlay', 'sshOverlay', 'webOverlay', 'loginView', 'requiredPasswordView']) {
    app.elements[id].hidden = false; assert.equal(app.trigger(), false, id); app.elements[id].hidden = true;
  }
  app.elements.appView.hidden = true; assert.equal(app.trigger(), false); app.elements.appView.hidden = false;
  app.setDialog(true); assert.equal(app.trigger(), false); app.setDialog(false);
  assert.equal(app.trigger({ target: { closest: () => ({}) } }), false);
  assert.equal(app.trigger({ target: { isContentEditable: true } }), false);
  for (const extra of [{ altKey: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: false }, { repeat: true }, { isComposing: true }, { defaultPrevented: true }, { code: 'KeyL' }]) assert.equal(app.trigger(extra), false);
  assert.equal(app.clicks, 0); assert.equal(app.focus, 0);
});
