'use strict';
/**
 * RDP Manager — главный процесс Electron.
 * Окно приложения + безопасный запуск внешних программ (mstsc / AnyDesk / RustDesk).
 */
const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, Tray, Menu, nativeImage, Notification } = require('electron');
const { spawn, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { compareVersions, parseServiceStatus, readLogTail } = require('./server-manager-utils');

// electron-updater (auto-update from GitHub Releases). В dev-режиме не используется.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { autoUpdater = null; }

let mainWindow = null;
let serverManagerWindow = null;
let serverManagerTray = null;
let allowServerManagerQuit = false;
let serverManagerUpdateTimer = null;
const serverManagerMode = process.argv.includes('--server-manager');
const serverManagerStartInTray = process.argv.includes('--server-manager-tray');
const SERVER_SERVICE_NAME = 'RDPManagerServer';
const GH_REPO = 'ignatus4405-glitch/RDP_manager';
const GH_RELEASES_LATEST = `https://api.github.com/repos/${GH_REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${GH_REPO}/releases/latest`;
const SERVER_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
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

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function initAutoUpdates() {
  // Менеджер сервера только проверяет релизы: автоустановка не должна останавливать службу без подтверждения.
  // В dev-режиме (app не собран в .exe/.AppImage) каждый запуск — запуск свежего кода.
  if (serverManagerMode || !app.isPackaged || !autoUpdater) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => sendToWindow('update-available', info?.version));
  autoUpdater.on('update-downloaded', (info) => sendToWindow('update-downloaded', info?.version));
  autoUpdater.on('error', (err) => sendToWindow('update-error', String(err?.message || err)));

  const check = () => autoUpdater.checkForUpdates().catch((err) => console.warn('Проверка обновлений не удалась:', err?.message || err));
  check();
  updateTimer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
}

/* ---------- IPC ---------- */
ipcMain.handle('launch-connection', (event, conn) => launchConnection(conn));
ipcMain.handle('app-version', () => app.getVersion());
/* Клипборд главного процесса: надёжно работает без разрешений renderer'а */
ipcMain.handle('clipboard-read', () => clipboard.readText());
ipcMain.handle('clipboard-write', (_event, text) => { clipboard.writeText(String(text ?? '')); return true; });
ipcMain.handle('update-check', async () => {
  if (!app.isPackaged || !autoUpdater) return { packaged: false };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { packaged: true, version: result?.updateInfo?.version || null };
  } catch (err) {
    return { packaged: true, error: String(err?.message || err) };
  }
});
ipcMain.handle('update-install', () => {
  if (app.isPackaged && autoUpdater) autoUpdater.quitAndInstall();
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

function initServerManagerUpdates() {
  const check = async () => {
    try { sendServerManagerUpdate(await checkServerManagerUpdates()); }
    catch (error) { sendServerManagerUpdate({ current: getManagedServerVersion(), latest: null, available: false, error: error.message }); }
  };
  check();
  serverManagerUpdateTimer = setInterval(check, SERVER_UPDATE_CHECK_INTERVAL_MS);
}

app.whenReady().then(() => {
  if (!hasServerManagerLock) return;
  if (serverManagerMode) {
    createServerManagerWindow();
    createServerManagerTray();
    initServerManagerUpdates();
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
  if (serverManagerUpdateTimer) clearInterval(serverManagerUpdateTimer);
  if (process.platform !== 'darwin') app.quit();
});
