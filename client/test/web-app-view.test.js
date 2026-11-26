'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
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
  const app = new EventEmitter(); const prompts = []; let answer = async () => ({ response: 0 });
  const electron = { app, dialog: { showMessageBox: async (_win, options) => { prompts.push(options); return answer(); } }, WebContentsView: View, session: { fromPartition(name) { const ses = new EventEmitter(); ses.name = name; ses.webRequest = { onBeforeRequest(cb) { ses.filter = cb; }, onErrorOccurred(cb) { ses.error = cb; }, onCompleted(cb) { ses.completed = cb; } }; ses.setPermissionRequestHandler = (cb) => { ses.permission = cb; }; ses.setPermissionCheckHandler = (cb) => { ses.check = cb; }; ses.clearStorageData = async () => { ses.cleared = true; }; sessions.push(ses); return ses; } } };
  const win = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, getContentSize: () => [800, 600], webContents: { send(_name, data) { reports.push(data); } } };
  return { manager: createWebAppView(() => win, electron), views, sessions, reports, app, prompts, setAnswer: (fn) => { answer = fn; } };
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

test('reports resource and script errors without leaking URLs or console contents, retaining warnings through load', async () => {
  const { manager, sessions, views, reports } = setup(); manager.open(options); const ses = sessions[0], wc = views[0].webContents;
  ses.error({ resourceType: 'script', error: 'net::ERR_CERT_AUTHORITY_INVALID', url: 'https://site/secret?token=private' });
  assert.match(reports.at(-1).message, /сертификата/);
  wc.emit('did-finish-load'); await new Promise(setImmediate); assert.match(reports.at(-1).message, /сертификата/);
  assert.doesNotMatch(JSON.stringify(reports), /private|secret\?token/);
  wc.emit('did-start-navigation', {}, '', false, true);
  ses.completed({ resourceType: 'script', statusCode: 404 }); assert.match(reports.at(-1).message, /HTTP 404/);
  wc.emit('did-start-navigation', {}, '', false, true);
  wc.emit('console-message', {}, { level: 'error', message: 'password=secret' }); assert.match(reports.at(-1).message, /скрипта/);
  assert.doesNotMatch(JSON.stringify(reports), /password=secret/);
  wc.emit('did-start-navigation', {}, '', false, true);
  ses.completed({ resourceType: 'mainFrame', statusCode: 503 }); assert.match(reports.at(-1).message, /HTTP 503/);
  manager.close(); const length = reports.length; ses.error({ resourceType: 'script', error: 'net::ERR_FAILED' }); assert.equal(reports.length, length);
});

const cert = { data: fs.readFileSync(path.join(__dirname, '../../server/test/fixtures/rdp-test-cert.pem'), 'utf8') };
function certificateRequest(app, wc, url, certificate = cert, error = 'net::ERR_CERT_AUTHORITY_INVALID') {
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  let resolve; const result = new Promise((r) => { resolve = r; });
  app.emit('certificate-error', event, wc, url, error, certificate, resolve);
  return { event, result };
}
test('certificate exception requires explicit approval and is scoped to the configured origin and window', async () => {
  const { manager, views, app, prompts, setAnswer, reports } = setup(); manager.open(options); const wc = views[0].webContents;
  setAnswer(async () => ({ response: 1 }));
  let req = certificateRequest(app, wc, 'https://other.example/file'); assert.equal(req.event.prevented, true); assert.equal(await req.result, false); assert.equal(prompts.length, 0);
  req = certificateRequest(app, wc, 'https://example.com:444/file'); assert.equal(await req.result, false); assert.equal(prompts.length, 0);
  req = certificateRequest(app, wc, 'https://example.com/'); assert.equal(await req.result, true); assert.equal(prompts.length, 1);
  assert.match(prompts[0].detail, new RegExp(new X509Certificate(cert.data).fingerprint256)); assert.match(prompts[0].detail, /пароль/);
  req = certificateRequest(app, wc, 'https://example.com/resource'); assert.equal(await req.result, true); assert.equal(prompts.length, 1);
  req = certificateRequest(app, wc, 'https://example.com/', { data: 'bad certificate' }); assert.equal(await req.result, false);
  wc.emit('did-finish-load'); await new Promise(setImmediate); assert.equal(wc.code.length, 1); assert.match(wc.code[0].scripts[0].code, /secret/); assert.match(reports.at(-1).message, /принят вручную/);
  manager.close(); assert.equal(app.listenerCount('certificate-error'), 0);
  manager.open(options); req = certificateRequest(app, views[1].webContents, 'https://example.com/'); assert.equal(await req.result, true); assert.equal(prompts.length, 2); manager.close();
});
test('certificate rejection and closing or navigating during confirmation never grant an exception', async () => {
  const { manager, views, app, setAnswer, prompts } = setup(); manager.open(options); const wc = views[0].webContents;
  let req = certificateRequest(app, wc, 'https://example.com/'); assert.equal(await req.result, false);
  let resolve; setAnswer(() => new Promise((r) => { resolve = r; }));
  req = certificateRequest(app, wc, 'https://example.com/'); const req2 = certificateRequest(app, wc, 'https://example.com/file'); await new Promise(setImmediate); assert.equal(prompts.length, 2);
  wc.emit('did-start-navigation', {}, '', false, true); resolve({ response: 1 }); assert.equal(await req.result, false); assert.equal(await req2.result, false);
  req = certificateRequest(app, wc, 'https://example.com/'); await new Promise(setImmediate); manager.close(); resolve({ response: 1 }); assert.equal(await req.result, false);
});
