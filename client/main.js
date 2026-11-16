'use strict';
/**
 * RDP Manager — главный процесс Electron.
 * Окно приложения + безопасный запуск внешних программ (mstsc / AnyDesk / RustDesk).
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow = null;

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

/* ---------- IPC ---------- */
ipcMain.handle('launch-connection', (event, conn) => launchConnection(conn));
ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('open-external', (event, url) => {
  if (/^https?:\/\//i.test(String(url || ''))) return shell.openExternal(url);
  return Promise.resolve();
});
ipcMain.handle('show-error', (event, message) => {
  return dialog.showMessageBox(mainWindow, { type: 'error', title: 'RDP Manager', message: String(message || 'Ошибка') });
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
