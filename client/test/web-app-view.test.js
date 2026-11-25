'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createWebAppView } = require('../web-app-view');
function setup() {
  const reports = [], views = [], sessions = [];
  class Contents extends EventEmitter {
    constructor() { super(); this.url = ''; this.code = []; }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    isDestroyed() { return !!this.destroyed; }
    close() { this.destroyed = true; }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    getURL() { return this.url; }
    async executeJavaScriptInIsolatedWorld(id, scripts) { this.code.push({ id, scripts }); return true; }
  }
  class View { constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); } setBounds(bounds) { this.rect = bounds; } }
  const electron = { WebContentsView: View, session: { fromPartition(name) { const ses = new EventEmitter(); ses.name = name; ses.webRequest = { onBeforeRequest(cb) { ses.filter = cb; } }; ses.setPermissionRequestHandler = (cb) => { ses.permission = cb; }; ses.setPermissionCheckHandler = (cb) => { ses.check = cb; }; ses.clearStorageData = async () => { ses.cleared = true; }; sessions.push(ses); return ses; } } };
  const win = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, getContentSize: () => [800, 600], webContents: { send(_name, data) { reports.push(data); } } };
  return { manager: createWebAppView(() => win, electron), views, sessions, reports };
}
const options = { url: 'https://example.com/login', username: 'user', password: 'secret', bounds: { x: 0, y: 50, width: 800, height: 550 } };
test('embedded view is sandboxed and isolated; navigation and permissions restricted', async () => {
  const { manager, views, sessions } = setup(); const { id } = manager.open(options); const wc = views[0].webContents; const ses = sessions[0];
  assert.equal(views[0].options.webPreferences.sandbox, true); assert.equal(views[0].options.webPreferences.nodeIntegration, false); assert.equal(ses.check(), false); assert.equal(wc.openHandler().action, 'deny');
  let result; ses.filter({ resourceType: 'mainFrame', url: 'http://example.com/' }, (r) => { result = r; }); assert.equal(result.cancel, true);
  wc.emit('did-finish-load'); await new Promise(setImmediate); assert.equal(wc.code.length, 1); assert.equal(wc.code[0].id, 1234);
  wc.emit('did-finish-load'); await new Promise(setImmediate); assert.equal(wc.code.length, 1);
  manager.close('stale-id'); assert.equal(wc.destroyed, undefined); manager.close(id); assert.equal(wc.destroyed, true); assert.equal(ses.cleared, true);
});
test('does not inject credentials after a cross-origin redirect', async () => {
  const { manager, views, reports } = setup(); manager.open(options); const wc = views[0].webContents; wc.url = 'https://other.example/login'; wc.emit('did-finish-load'); await new Promise(setImmediate);
  assert.equal(wc.code.length, 0); assert.match(reports.at(-1).message, /вручную/); manager.close();
});
