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
    const state = { id: randomUUID(), window: win, view, session: ses, issue: null, credentials: options.password && options.username ? { username: options.username, password: options.password, origin: url.origin } : null };
    active = state; win.contentView.addChildView(view);
    // Do not collect URLs, response bodies or console text: these may contain secrets.
    const resourceTypes = new Set(['script', 'stylesheet', 'xhr', 'fetch']);
    function issue(message) { if (active !== state || state.issue) return; state.issue = message; report(state, message); }
    ses.webRequest.onErrorOccurred((details) => {
      if (!resourceTypes.has(details.resourceType) || details.error === 'net::ERR_ABORTED') return;
      const certificate = typeof details.error === 'string' && details.error.startsWith('net::ERR_CERT_');
      issue(certificate ? 'Ошибка сертификата при загрузке ресурсов страницы. Проверьте доверие к сертификату.' : 'Не удалось загрузить ресурс страницы. Проверьте доступность приложения.');
    });
    ses.webRequest.onCompleted((details) => {
      if (details.resourceType === 'mainFrame' && details.statusCode >= 400) issue(`Сервер вернул HTTP ${details.statusCode}. Проверьте адрес и приложение.`);
      else if (resourceTypes.has(details.resourceType) && details.statusCode >= 400) issue(`Ресурс страницы вернул HTTP ${details.statusCode}. Приложение может работать неправильно.`);
    });
    try { bounds(state.id, options.bounds); } catch (error) { close(state.id); throw error; }
    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event, target) => { try { parseWebUrl(target); } catch { event.preventDefault(); report(state, 'Разрешены только HTTPS-страницы.'); } });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => { if (isMainFrame && !isInPlace) state.issue = null; });
    wc.on('did-navigate', () => { if (!state.issue) report(state, 'Страница открыта.'); });
    wc.on('render-process-gone', () => issue('Процесс страницы завершился. Попробуйте обновить страницу.'));
    wc.on('console-message', (_event, details) => { if (details?.level === 'error' || details === 3) issue('Ошибка скрипта веб-приложения. Проверьте работу в обычном браузере.'); });
    wc.on('did-finish-load', async () => {
      if (active !== state) return;
      const creds = state.credentials; state.credentials = null;
      if (!creds) { if (!state.issue) report(state, 'Загрузка завершена. Если экран пуст, проверьте приложение в браузере.'); return; }
      try {
        if (new URL(wc.getURL()).origin !== creds.origin) { report(state, 'Адрес изменился: введите данные вручную.'); return; }
        const code = `(${fillLogin.toString()})(${JSON.stringify(creds.origin)},${JSON.stringify(creds.username)},${JSON.stringify(creds.password)})`;
        const result = await wc.executeJavaScriptInIsolatedWorld(1234, [{ code }]);
        if (!state.issue) report(state, result ? 'Данные заполнены; проверьте и войдите.' : 'Форма не распознана: введите данные вручную.');
      } catch { if (!state.issue) report(state, 'Не удалось заполнить форму; войдите вручную.'); }
    });
    wc.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { state.credentials = null; state.issue = null; issue('Не удалось загрузить страницу. Проверьте адрес и сертификат.'); } });
    void wc.loadURL(url.href).catch(() => {});
    return { id: state.id };
  }
  function action(id, command) {
    if (!active || active.id !== id) return;
    const wc = active.view.webContents;
    if (command === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (command === 'reload') { active.issue = null; report(active, 'Повторная загрузка…'); wc.reload(); }
  }
  return { open, close, bounds, action };
}
module.exports = { createWebAppView };
