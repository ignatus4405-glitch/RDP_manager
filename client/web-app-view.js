'use strict';
const { randomUUID } = require('node:crypto');
const { parseWebUrl, fillLogin } = require('./web-app-security');

function createWebAppView(getWindow, electron = require('electron')) {
  const { WebContentsView, session } = electron;
  let active = null;
  function close(id) {
    if (id && active?.id !== id) return;
    const state = active; active = null;
    if (!state) return;
    state.credentials = null;
    if (!state.window.isDestroyed()) state.window.contentView.removeChildView(state.view);
    if (!state.view.webContents.isDestroyed()) state.view.webContents.close();
    void state.session.clearStorageData().catch(() => {});
  }
  function report(state, message) {
    if (active === state && !state.window.isDestroyed()) state.window.webContents.send('web-app-event', { id: state.id, message, origin: (() => { try { return new URL(state.view.webContents.getURL()).origin; } catch { return ''; } })() });
  }
  function bounds(id, rect) {
    if (!active || active.id !== id) return;
    if (!rect || !['x','y','width','height'].every((key) => Number.isFinite(rect[key]))) throw new Error('Некорректный размер окна.');
    const [width, height] = active.window.getContentSize();
    const x = Math.max(0, Math.min(width, Math.round(rect.x))), y = Math.max(0, Math.min(height, Math.round(rect.y)));
    active.view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) });
  }
  function open(options) {
    const url = parseWebUrl(options?.url);
    if (typeof options.username !== 'string' || options.username.length > 150 || typeof options.password !== 'string' || Buffer.byteLength(options.password) > 8192) throw new Error('Некорректные учётные данные.');
    const win = getWindow(); if (!win || win.isDestroyed()) throw new Error('Окно недоступно.');
    close();
    // A non-persistent, per-opening partition shares neither cookies nor storage with the manager or other sites.
    const ses = session.fromPartition(`web-app-${randomUUID()}`, { cache: false });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        try { parseWebUrl(details.url); } catch { return callback({ cancel: true }); }
      }
      callback({ cancel: false });
    });
    const view = new WebContentsView({ webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    const state = { id: randomUUID(), window: win, view, session: ses, credentials: options.password && options.username ? { username: options.username, password: options.password, origin: url.origin } : null };
    active = state; win.contentView.addChildView(view);
    try { bounds(state.id, options.bounds); } catch (error) { close(state.id); throw error; }
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, target) => { try { parseWebUrl(target); } catch { event.preventDefault(); report(state, 'Разрешены только HTTPS-страницы.'); } });
    wc.on('did-navigate', () => report(state, 'Страница открыта.'));
    wc.on('did-finish-load', async () => {
      if (active !== state) return;
      const creds = state.credentials; state.credentials = null;
      if (!creds) { report(state, 'Страница загружена.'); return; }
      try {
        if (new URL(wc.getURL()).origin !== creds.origin) { report(state, 'Адрес изменился: введите данные вручную.'); return; }
        const code = `(${fillLogin.toString()})(${JSON.stringify(creds.origin)},${JSON.stringify(creds.username)},${JSON.stringify(creds.password)})`;
        const result = await wc.executeJavaScriptInIsolatedWorld(1234, [{ code }]);
        report(state, result ? 'Данные заполнены; проверьте и войдите.' : 'Форма не распознана: введите данные вручную.');
      } catch { report(state, 'Не удалось заполнить форму; войдите вручную.'); }
    });
    wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { state.credentials = null; report(state, 'Не удалось загрузить страницу. Проверьте адрес и сертификат.'); } });
    void wc.loadURL(url.href).catch(() => {});
    return { id: state.id };
  }
  function action(id, command) {
    if (!active || active.id !== id) return;
    const wc = active.view.webContents;
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (command === 'reload') wc.reload();
  }
  return { open, close, bounds, action };
}
module.exports = { createWebAppView };
