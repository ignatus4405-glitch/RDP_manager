'use strict';
/**
 * RDP Manager — главный процесс Electron.
 * Окно приложения + безопасный запуск внешних программ (mstsc / AnyDesk / RustDesk).
 */
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, ClipboardItem, Tray, Menu, nativeImage, Notification } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { compareVersions, parseServiceStatus, readLogTail } = require('./server-manager-utils');
const { createUpdateController } = require('./update-controller');
const { createRdpFileWriter } = require('./rdp-file-writer');
const { createClipboardFileSource } = require('./clipboard-file-source');
const { createClipboardReceiver } = require('./rdp-clipboard-receiver');
const { createRichClipboard } = require('./clipboard-rich');
const { createWindowsVirtualClipboard } = require('./windows-virtual-clipboard');
const { createWindowsLayoutHook } = require('./windows-layout-hook');

// electron-updater (auto-update from GitHub Releases). В dev-режиме не используется.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }

let mainWindow = null;
let serverManagerWindow = null;
let serverManagerTray = null;
let allowServerManagerQuit = false;
const serverManagerMode = process.argv.includes('--server-manager');
const serverManagerStartInTray = process.argv.includes('--server-manager-tray');
const fileWriter = createRdpFileWriter({
  choosePath: async (name) => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Сохранить файл из RDP', defaultPath: String(name) });
    return result.canceled ? null : result.filePath;
  },
});
const virtualClipboardExecutable = app.isPackaged ? path.join(process.resourcesPath, 'rdp-virtual-clipboard.exe') : path.join(__dirname, 'build', 'rdp-virtual-clipboard.exe');
const windowsVirtualClipboard = createWindowsVirtualClipboard({
  executable: virtualClipboardExecutable,
  sendRequest: (request) => {
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Окно клиента недоступно.');
    mainWindow.webContents.send('rdp-virtual-read', request);
  },
});
const layoutHookExecutable = app.isPackaged ? path.join(process.resourcesPath, 'rdp-layout-hook.exe') : path.join(__dirname, 'build', 'rdp-layout-hook.exe');
let layoutFocusToken = null;
const layoutHook = createWindowsLayoutHook({
  executable: layoutHookExecutable,
  onSwitch: () => { if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) mainWindow.webContents.send('rdp-layout-switch', layoutFocusToken); },
  onError: (error) => console.warn('RDP keyboard hook:', error.message),
});
const clipboardFileSource = createClipboardFileSource({ clipboard });
const richClipboard = createRichClipboard({ clipboard, ClipboardItem });
const clipboardReceiver = createClipboardReceiver({ clipboard, ClipboardItem, tempDirectory: app.getPath('temp') });
const SERVER_SERVICE_NAME = 'RDPManagerServer';
const GH_REPO = 'ignatus4405-glitch/RDP_manager';
const GH_RELEASES_LATEST = `https://api.github.com/repos/${GH_REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${GH_REPO}/releases/latest`;
const hasServerManagerLock = !serverManagerMode || app.requestSingleInstanceLock();
if (!hasServerManagerLock) app.quit();
else if (serverManagerMode) app.on('second-instance', () => { app.whenReady().then(showServerManagerWindow); });

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0d1117',
    title: 'RDP Manager',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('blur', () => { layoutFocusToken = null; layoutHook.stop(); });
  mainWindow.on('closed', () => { layoutHook.stop(); mainWindow = null; clipboardFileSource.reset(); fileWriter.cancelAll(); clipboardReceiver.cancelAll(); windowsVirtualClipboard.clear(); });
}

function createServerManagerWindow() {
  if (serverManagerWindow && !serverManagerWindow.isDestroyed()) {
    serverManagerWindow.show();
    serverManagerWindow.focus();
    return;
  }

  serverManagerWindow = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 680,
    minHeight: 680,
    backgroundColor: '#0d1117',
    title: 'RDP Manager Server — Управление',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    show: !serverManagerStartInTray,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  serverManagerWindow.loadFile(path.join(__dirname, 'renderer', 'server-manager.html'));
  serverManagerWindow.on('close', (event) => {
    if (process.platform === 'win32' && !allowServerManagerQuit) {
      event.preventDefault();
      serverManagerWindow.hide();
    }
  });
  serverManagerWindow.on('closed', () => { serverManagerWindow = null; });
}

function showServerManagerWindow() {
  createServerManagerWindow();
}

function notifyServerManager(title, body) {
  if (Notification.isSupported()) new Notification({ title, body }).show();
  else if (serverManagerWindow && !serverManagerWindow.isDestroyed()) {
    serverManagerWindow.webContents.send('server-manager-toast', body);
  }
}

function createServerManagerTray() {
  if (process.platform !== 'win32' || serverManagerTray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
  serverManagerTray = new Tray(icon);
  serverManagerTray.setToolTip('RDP Manager Server');
  serverManagerTray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть управление сервером', click: showServerManagerWindow },
    { label: 'Открыть веб-панель', click: () => openServerPanel().catch((error) => notifyServerManager('RDP Manager Server', error.message)) },
    { type: 'separator' },
    { label: 'Запустить службу', click: () => runServerServiceAction('start').catch((error) => notifyServerManager('Ошибка службы', error.message)) },
    { label: 'Остановить службу', click: () => runServerServiceAction('stop').catch((error) => notifyServerManager('Ошибка службы', error.message)) },
    { type: 'separator' },
    { label: 'Проверить обновления', click: async () => {
      try {
        const result = await checkServerManagerUpdates();
        notifyServerManager('RDP Manager Server', result.available ? `Доступна версия ${result.latest}` : `Установлена последняя версия ${result.current}`);
      } catch (error) { notifyServerManager('Проверка обновлений', error.message); }
    } },
    { type: 'separator' },
    { label: 'Выход', click: () => { allowServerManagerQuit = true; app.quit(); } },
  ]));
  serverManagerTray.on('double-click', showServerManagerWindow);
}

function getServerManagerDataDirectory() {
  const programData = process.env.ProgramData || process.env.PROGRAMDATA || path.join(process.env.SystemDrive || 'C:\\', 'ProgramData');
  return path.join(programData, 'RDP Manager Server');
}

function runFile(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: options.timeout || 15_000, ...options }, (error, stdout, stderr) => {
      const numericCode = error && Number.isInteger(error.code) ? error.code : (error ? 1 : 0);
      resolve({ error, code: numericCode, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function getServerServiceStatus() {
  if (process.platform !== 'win32') return { supported: false, installed: false, state: 'unsupported', stateCode: null };
  const result = await runFile('sc.exe', ['query', SERVER_SERVICE_NAME]);
  const parsed = parseServiceStatus(`${result.stdout}\n${result.stderr}`, result.code);
  if (result.error && result.error.code === 'ENOENT') {
    return { supported: true, installed: false, state: 'unknown', stateCode: null, error: 'Не найден sc.exe — невозможно проверить службу.' };
  }
  return { supported: true, ...parsed };
}

async function runServerServiceAction(action) {
  if (process.platform !== 'win32') throw new Error('Управление службой доступно только в Windows.');
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error('Недопустимая команда службы.');

  const command = action === 'start' ? 'Start-Service' : action === 'stop' ? 'Stop-Service' : 'Restart-Service';
  const script = `$ErrorActionPreference='Stop'; try { ${command} -Name '${SERVER_SERVICE_NAME}' -Force; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const argumentsForElevated = `-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
  const outerScript = `$ErrorActionPreference='Stop'; try { $p = Start-Process -FilePath \"$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -ArgumentList '${argumentsForElevated}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
  const result = await runFile('powershell.exe', ['-NoLogo', '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', outerScript], { timeout: 120_000 });
  if (result.error || result.code !== 0) {
    const output = (result.stderr || result.stdout || '').trim();
    throw new Error(output || result.error?.message || (result.error ? 'Запрос UAC отменён или не удалось запустить PowerShell.' : `Команда службы завершилась с кодом ${result.code}.`));
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  return getServerServiceStatus();
}

async function openServerPanel() {
  const status = await getServerServiceStatus();
  if (!status.installed || status.state !== 'running') return { ok: false, message: 'Служба не запущена.' };
  await shell.openExternal('http://127.0.0.1:8720/');
  return { ok: true };
}

function getManagedServerVersion() {
  if (app.isPackaged) {
    try {
      const versionFile = path.join(path.dirname(process.execPath), 'server', 'server-version.txt');
      const version = fs.readFileSync(versionFile, 'utf8').trim();
      if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) return version;
    } catch { /* Client-only installations and development builds use the app version. */ }
  }
  return app.getVersion();
}

async function checkServerManagerUpdates() {
  const current = getManagedServerVersion();
  const response = await fetch(GH_RELEASES_LATEST, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'RDP-Manager-Server-Manager' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub API вернул HTTP ${response.status}.`);
  const release = await response.json();
  const latest = String(release.tag_name || '').replace(/^v/, '');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(latest)) throw new Error('GitHub вернул некорректную версию релиза.');
  const releaseUrl = typeof release.html_url === 'string' && /^https:\/\/github\.com\/ignatus4405-glitch\/RDP_manager\/releases\//.test(release.html_url)
    ? release.html_url
    : RELEASE_PAGE;
  return { current, latest, available: compareVersions(latest, current) > 0, releaseUrl };
}

function sendServerManagerUpdate(result) {
  if (serverManagerWindow && !serverManagerWindow.isDestroyed()) {
    serverManagerWindow.webContents.send('server-manager-update', result);
  }
}

async function openServerRelease(url) {
  let target = RELEASE_PAGE;
  try {
    const parsed = new URL(String(url || ''));
    if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && parsed.pathname.startsWith(`/ignatus4405-glitch/RDP_manager/releases/`)) target = parsed.toString();
  } catch { /* Use the fixed latest-release page for invalid renderer input. */ }
  return shell.openExternal(target);
}

/* ---------- Проверка, есть ли программа в PATH ---------- */
function which(binary) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFileSync(cmd, [binary], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Запускает подключение. conn = { type, name, address, port, username }
 * Возвращает { ok, message }
 */
function launchConnection(conn) {
  const type = String(conn?.type || '');
  const address = String(conn?.address || '').trim();
  const name = String(conn?.name || address);
  if (!address) return { ok: false, message: 'Пустой адрес подключения' };

  // Адреса не должны содержать управляющих символов
  if (/[\r\n\x00-\x1f]/.test(address)) return { ok: false, message: 'Недопустимые символы в адресе' };

  try {
    if (type === 'rdp') return launchRdp(address, Number(conn?.port) || 3389, conn?.username, name);
    if (type === 'anydesk') return launchAnyDesk(address, name);
    if (type === 'rustdesk') return launchRustDesk(address, name);
    return { ok: false, message: `Неизвестный тип подключения: ${type}` };
  } catch (err) {
    return { ok: false, message: `Не удалось запустить: ${err.message}` };
  }
}

function launchRdp(address, port, username, name) {
  const target = port === 3389 ? address : `${address}:${port}`;

  if (process.platform === 'win32') {
    const args = [`/v:${target}`];
    if (username) args.push(`/u:${username}`);
    spawn('mstsc.exe', args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю RDP: ${name}` };
  }

  if (process.platform === 'darwin') {
    // Microsoft Remote Desktop на macOS открывает .rdp файлы
    const rdpFile = path.join(os.tmpdir(), `rdp-manager-${Date.now()}.rdp`);
    const userLine = username ? `username:s:${username}\r\n` : '';
    fs.writeFileSync(rdpFile, `full address:s:${target}\r\n${userLine}prompt for credentials:i:1\r\n`);
    spawn('open', [rdpFile], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю RDP: ${name}` };
  }

  // Linux: xfreerdp → freerdp → remmina
  const cli = ['xfreerdp3', 'xfreerdp', 'wlfreerdp'].find(which);
  if (cli) {
    const args = [`/v:${target}`, '/cert:ignore'];
    if (username) args.push(`/u:${username}`);
    spawn(cli, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю RDP (${cli}): ${name}` };
  }
  if (which('remmina')) {
    spawn('remmina', ['-c', `rdp://${target}`], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю RDP (remmina): ${name}` };
  }
  return { ok: false, message: 'Не найден клиент RDP. Установите Remmina или FreeRDP (sudo apt install remmina / freerdp2-x11).' };
}

function launchAnyDesk(address, name) {
  const id = address.replace(/\s+/g, '');
  const exe = process.platform === 'win32'
    ? path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'AnyDesk', 'AnyDesk.exe')
    : null;

  if (process.platform === 'win32' && exe && fs.existsSync(exe)) {
    spawn(exe, [id], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю AnyDesk: ${name}` };
  }
  if (which('anydesk')) {
    spawn('anydesk', [id], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю AnyDesk: ${name}` };
  }
  shell.openExternal(`anydesk:${id}`);
  return { ok: true, message: `Передаю AnyDesk (${id}) системному обработчику…` };
}

function launchRustDesk(address, name) {
  const id = address.replace(/\s+/g, '');
  if (which('rustdesk')) {
    spawn('rustdesk', ['--connect', id], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, message: `Открываю RustDesk: ${name}` };
  }
  shell.openExternal(`rustdesk://${id}`);
  return { ok: true, message: `Передаю RustDesk (${id}) системному обработчику…` };
}

/* ---------- Автоматическое обновление из GitHub Releases ---------- */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // раз в 6 часов
let updateTimer = null;

let updateController;

function initAutoUpdates() {
  updateController = createUpdateController({
    updater: autoUpdater,
    supported: app.isPackaged && (process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.APPIMAGE))),
    currentVersion: app.getVersion(),
    onChange: (state) => {
      for (const window of [mainWindow, serverManagerWindow]) {
        if (window && !window.isDestroyed()) window.webContents.send('update-state', state);
      }
    },
  });
  const check = () => updateController.check();
  check();
  updateTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

/* ---------- IPC ---------- */
ipcMain.handle('launch-connection', (event, conn) => launchConnection(conn));
ipcMain.handle('app-version', () => app.getVersion());
/* Клипборд главного процесса: надёжно работает без разрешений renderer'а */
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.handle('clipboard-write', async (_event, text) => { await clipboard.writeText(String(text ?? '')); return true; });
function requireClientWindow(event) {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('Операция доступна только окну клиента.');
}
ipcMain.on('rdp-layout-focus', (event, focused, token) => {
  requireClientWindow(event);
  if (!focused || !Number.isSafeInteger(token) || process.platform !== 'win32' || !mainWindow.isFocused() || !fs.existsSync(layoutHookExecutable)) { layoutFocusToken = null; layoutHook.stop(); return; }
  layoutFocusToken = token;
  const handle = mainWindow.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE());
  layoutHook.start(hwnd);
});
ipcMain.handle('rdp-virtual-available', (event) => { requireClientWindow(event); return process.platform === 'win32' && fs.existsSync(virtualClipboardExecutable); });
ipcMain.handle('rdp-virtual-active', (event) => { requireClientWindow(event); return windowsVirtualClipboard.isActive(); });
ipcMain.handle('rdp-virtual-publish', (event, files) => { requireClientWindow(event); if (process.platform !== 'win32') throw new Error('OLE доступен только в Windows.'); return windowsVirtualClipboard.publish(files); });
ipcMain.handle('rdp-virtual-activate', (event, token) => { requireClientWindow(event); return windowsVirtualClipboard.activate(token); });
ipcMain.handle('rdp-virtual-clear', (event, token) => { requireClientWindow(event); if (typeof token !== 'string') return; return windowsVirtualClipboard.clear(token); });
ipcMain.handle('rdp-virtual-response', (event, response) => { requireClientWindow(event); return windowsVirtualClipboard.respond(response); });
ipcMain.handle('rdp-clipboard-read-text-only', (event) => { requireClientWindow(event); return windowsVirtualClipboard.isActive() ? null : richClipboard.readTextOnly(); });
ipcMain.handle('rdp-clipboard-read-rich', (event) => { requireClientWindow(event); return richClipboard.read(); });
ipcMain.handle('rdp-clipboard-write-rich', (event, entries) => { requireClientWindow(event); return richClipboard.write(entries); });
ipcMain.handle('rdp-clipboard-files', (event) => { requireClientWindow(event); return clipboardFileSource.inspect(); });
ipcMain.handle('rdp-clipboard-file-read', (event, id, offset, size) => { requireClientWindow(event); return clipboardFileSource.read(id, offset, size); });
ipcMain.handle('rdp-clipboard-files-reset', (event) => { requireClientWindow(event); clipboardFileSource.reset(); });
ipcMain.handle('rdp-clipboard-receive-begin', (event, files) => { requireClientWindow(event); return clipboardReceiver.begin(files); });
ipcMain.handle('rdp-clipboard-receive-open', (event, id, index) => { requireClientWindow(event); return clipboardReceiver.open(id, index); });
ipcMain.handle('rdp-clipboard-receive-write', (event, id, index, data) => { requireClientWindow(event); return clipboardReceiver.write(id, index, data); });
ipcMain.handle('rdp-clipboard-receive-close', (event, id, index) => { requireClientWindow(event); return clipboardReceiver.close(id, index); });
ipcMain.handle('rdp-clipboard-receive-commit', (event, id) => { requireClientWindow(event); return clipboardReceiver.commit(id); });
ipcMain.handle('rdp-clipboard-receive-cancel', (event, id) => { requireClientWindow(event); return clipboardReceiver.cancel(id); });
ipcMain.handle('rdp-file-begin', (event, name) => {
  requireClientWindow(event);
  const safeName = String(name || 'file').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_') || 'file';
  return fileWriter.begin(safeName);
});
ipcMain.handle('rdp-file-write', (event, id, chunk) => { requireClientWindow(event); return fileWriter.write(id, chunk); });
ipcMain.handle('rdp-file-finish', (event, id) => { requireClientWindow(event); return fileWriter.finish(id); });
ipcMain.handle('rdp-file-cancel', (event, id) => { requireClientWindow(event); return fileWriter.cancel(id); });
ipcMain.handle('update-state', () => updateController.getState());
ipcMain.handle('update-check', () => updateController.check());
ipcMain.handle('update-install', async () => {
  if (updateController.getState().phase !== 'ready') return { ok: false, message: 'Обновление ещё не загружено.' };
  const { response } = await dialog.showMessageBox(serverManagerWindow || mainWindow, {
    type: 'question', title: 'Установка обновления',
    message: 'Установить обновление сейчас?',
    detail: 'Приложение закроется. При обновлении сервера служба будет временно остановлена. Сохраните работу и закройте другие окна RDP Manager.',
    buttons: ['Установить', 'Отмена'], defaultId: 1, cancelId: 1, noLink: true,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  allowServerManagerQuit = true;
  return { ok: updateController.install() };
});
ipcMain.handle('open-external', (event, url) => {
  if (/^https?:\/\//i.test(String(url || ''))) return shell.openExternal(url);
  return Promise.resolve();
});
ipcMain.handle('show-error', (_event, message) => {
  const parent = serverManagerWindow || mainWindow;
  return dialog.showMessageBox(parent, { type: 'error', title: 'RDP Manager', message: String(message || 'Ошибка') });
});
ipcMain.handle('server-manager-status', () => getServerServiceStatus());
ipcMain.handle('server-manager-action', async (_event, action) => {
  const status = await runServerServiceAction(action);
  return { ok: true, status, message: action === 'start' ? 'Служба запущена.' : action === 'stop' ? 'Служба остановлена.' : 'Служба перезапущена.' };
});
ipcMain.handle('server-manager-logs', () => {
  const logDirectory = path.join(getServerManagerDataDirectory(), 'logs');
  const logFile = path.join(logDirectory, 'server.log');
  return { ...readLogTail(logFile), logFile, logDirectory };
});
ipcMain.handle('server-manager-open-log-folder', async () => {
  const logDirectory = path.join(getServerManagerDataDirectory(), 'logs');
  fs.mkdirSync(logDirectory, { recursive: true });
  const error = await shell.openPath(logDirectory);
  if (error) throw new Error(error);
  return { ok: true };
});
ipcMain.handle('server-manager-open-panel', () => openServerPanel());
ipcMain.handle('server-manager-update-check', async () => {
  const result = await checkServerManagerUpdates();
  sendServerManagerUpdate(result);
  return result;
});
ipcMain.handle('server-manager-open-release', (_event, url) => openServerRelease(url));

app.whenReady().then(() => {
  if (!hasServerManagerLock) return;
  if (serverManagerMode) {
    createServerManagerWindow();
    createServerManagerTray();
    initAutoUpdates();
  } else {
    createWindow();
    initAutoUpdates();
  }
  app.on('activate', () => {
    if (serverManagerMode) showServerManagerWindow();
    else if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  allowServerManagerQuit = true;
  if (serverManagerTray) {
    serverManagerTray.destroy();
    serverManagerTray = null;
  }
});

app.on('window-all-closed', () => {
  if (updateTimer) clearInterval(updateTimer);
  if (process.platform !== 'darwin') app.quit();
});
