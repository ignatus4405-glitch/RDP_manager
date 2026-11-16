'use strict';
/**
 * Безопасный мостик между renderer-процессом и Node/Electron.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rdpManager', {
  /** Запустить подключение (RDP / AnyDesk / RustDesk). conn = {type, name, address, port, username} */
  launch: (conn) => ipcRenderer.invoke('launch-connection', conn),
  /** Версия приложения */
  version: () => ipcRenderer.invoke('app-version'),
  /** Открыть внешнюю http(s) ссылку в браузере */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  /** ОС клиента: win32 | linux | darwin */
  platform: process.platform,
});
