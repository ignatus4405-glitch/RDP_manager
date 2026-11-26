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

test('SFTP context menus select a right-clicked file and perform actual actions', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const elements = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  elements.sftpPanel.classList.add('hidden');
  const document = new Element(); document.getElementById = (id) => elements[id] || null; document.createElement = (name) => new Element(name); document.createTextNode = (text) => ({ textContent: text });
  let onEvent, copied = '', transfers = [], folders = [], files = [], links = [], pastes = [], saves = [], propertySaves = [], confirmClose = false;
  const ssh = {
    onEvent(callback) { onEvent = callback; }, close: async () => {}, open: async () => ({ id: 'session' }),
    localList: async () => ({ path: '/local', parent: '/', files: [{ name: 'photo.txt', file: true, size: 5 }] }),
    list: async () => ({ path: '/home', files: [{ name: 'docs', directory: true }] }),
    transferBetween: async (...args) => { transfers.push(args); return { ok: true }; },
    createDirectory: async (...args) => { folders.push(args); return { ok: true }; },
    propertiesOpen: async () => ({ token: 'properties-token', type: 'directory', size: 12884901888, mode: 0o40755, uid: 0, gid: 0, mtime: 100 }),
    propertiesSave: async (...args) => { propertySaves.push(args); return { ok: true }; },
    propertiesReset: async () => {},
    editorOpen: async () => ({ token: 'edit-token', text: 'original' }),
    editorSave: async (...args) => { saves.push(args); return { ok: true }; },
    editorReset: async () => {},
    createFile: async (...args) => { files.push(args); return { ok: true }; },
    createLink: async (...args) => { links.push(args); return { ok: true }; },
    pasteFiles: async (...args) => { pastes.push(args); return { ok: true, count: 1 }; },
  };
  const window = { innerWidth: 800, innerHeight: 600, addEventListener() {}, confirm: () => confirmClose, rdpManager: { ssh, writeClipboard: async (text) => { copied = text; } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../renderer/ssh.js'), 'utf8'), { window, document, console, Date, Number, String, Uint8Array });
  window.openEmbeddedSsh({ type: 'sftp', name: 'Test', address: 'example', username: 'user' });
  elements.sshForm.emit('submit'); await tick(); onEvent({ id: 'session', type: 'ready' }); await tick();
  const row = elements.sftpLocalEntries.children[0]; assert.ok(row);
  row.emit('contextmenu', { clientX: 790, clientY: 590 });
  const menu = elements.sftpContextMenu; assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(menu.style.left, '546px'); assert.equal(menu.style.top, '396px');
  menu.children.find((button) => label(button) === 'Скопировать путь объекта').click(); await tick(); assert.equal(copied, '/local/photo.txt');
  row.emit('contextmenu', { clientX: 10, clientY: 10 }); menu.children.find((button) => label(button) === 'Изменить файл').click(); await tick();
  assert.equal(elements.sftpEditorDialog.open, true); assert.equal(elements.sftpEditorText.value, 'original');
  elements.sftpEditorText.value = 'edited'; elements.sftpEditorText.emit('input'); elements.sftpEditorClose.click(); assert.equal(elements.sftpEditorDialog.open, true);
  elements.sftpEditorSave.click(); await tick(); assert.deepEqual(saves[0], ['session', 'edit-token', 'edited']); assert.equal(elements.sftpEditorDialog.open, false);

  row.emit('contextmenu', { clientX: 10, clientY: 10 });
  menu.children.find((button) => label(button) === 'Отправить на сервер').click(); await tick();
  assert.deepEqual(transfers[0], ['session', '/local', '/home', 'photo.txt', 'upload']);
  elements.sftpRemoteList.emit('contextmenu', { clientX: 20, clientY: 20 });
  let group = menu.children.find((node) => node.className === 'sftp-submenu-wrap');
  group.children[0].click(); group.children[1].children.find((button) => label(button) === 'Каталог…').click(); assert.equal(elements.sftpNewFolderDialog.open, true);
  elements.sftpNewFolderName.value = 'folder'; elements.sftpNewFolderForm.emit('submit'); await tick();
  assert.deepEqual(folders[0], ['session', 'remote', '/home', 'folder']); assert.equal(elements.sftpNewFolderDialog.open, false);
  elements.sftpRemoteList.emit('contextmenu', { clientX: 20, clientY: 20 });
  group = menu.children.find((node) => node.className === 'sftp-submenu-wrap'); group.children[0].click(); group.children[1].children.find((button) => label(button) === 'Файл…').click();
  elements.sftpNewFolderName.value = 'empty.txt'; elements.sftpNewFolderForm.emit('submit'); await tick(); assert.deepEqual(files[0], ['session', 'remote', '/home', 'empty.txt']);
  elements.sftpRemoteList.emit('contextmenu', { clientX: 20, clientY: 20 });
  group = menu.children.find((node) => node.className === 'sftp-submenu-wrap'); group.children[0].click(); group.children[1].children.find((button) => label(button) === 'Ярлык…').click();
  elements.sftpNewFolderName.value = 'link'; elements.sftpNewLinkTarget.value = '../target'; elements.sftpNewFolderForm.emit('submit'); await tick(); assert.deepEqual(links[0], ['session', 'remote', '/home', 'link', '../target']);
  elements.sftpRemoteList.emit('contextmenu', { clientX: 20, clientY: 20 });
  menu.children.find((button) => label(button) === 'Вставить файлы из буфера').click(); await tick();
  assert.deepEqual(pastes[0], ['session', '/home']);
  const remoteRow = elements.sftpEntries.children[0]; remoteRow.emit('contextmenu', { clientX: 20, clientY: 20 });
  menu.children.find((button) => label(button) === 'Свойства').click(); await tick();
  assert.equal(elements.sftpPropertiesDialog.open, true); assert.equal(elements.sftpPropOctal.value, '0755');
  elements.sftpPerm2000.checked = true; elements.sftpPerm2000.emit('change'); assert.equal(elements.sftpPropOctal.value, '2755');
  elements.sftpPropOctal.value = '0640'; elements.sftpPropOctal.emit('input'); assert.equal(elements.sftpPerm10.checked, false);
  elements.sftpPropertiesForm.emit('submit'); await tick(); assert.equal(propertySaves[0][0], 'session'); assert.equal(propertySaves[0][1], 'properties-token'); assert.equal(propertySaves[0][2].mode, 0o640); assert.equal(elements.sftpPropertiesDialog.open, false);
  elements.sftpRemoteList.emit('contextmenu', { clientX: 20, clientY: 20 }); document.emit('keydown', { key: 'Escape' });
  assert.equal(menu.classList.contains('hidden'), true);
});
