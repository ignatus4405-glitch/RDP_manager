'use strict';
/**
 * Безопасный мостик между renderer-процессом и Node/Electron.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rdpManager', {
  /** Запустить подключение (RDP / AnyDesk / RustDesk). conn = {type, name, address, port, username} */
  launch: (conn) => ipcRenderer.invoke('launch-connection', conn),
  /** Версия приложения (строка, напр. "1.1.0") */
  version: () => ipcRenderer.invoke('app-version'),
  /** Внешняя ссылка в системном браузере (http/https) */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  /** Прочитать системный буфер обмена (текст) — из главного процесса, без разрешений renderer'а */
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  /** Записать текст в системный буфер обмена */
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write', text),
  /** ОС клиента: win32 | linux | darwin */
  platform: process.platform,
  /** Проверка и установка обновлений из GitHub Releases */
  updates: {
    /** Ручная проверка. Возвращает { packaged, version?, error? } — packaged:false в dev-режиме */
    check: () => ipcRenderer.invoke('update-check'),
    /** Перезапустить и установить загруженное обновление */
    install: () => ipcRenderer.invoke('update-install'),
    /** Подписка на «доступна новая версия» (версия придёт аргументом) */
    onAvailable: (cb) => bindChannel('update-available', cb),
    /** Подписка на «обновление загружено и готово к установке» */
    onDownloaded: (cb) => bindChannel('update-downloaded', cb),
    /** Подписка на ошибку проверки обновлений */
    onError: (cb) => bindChannel('update-error', cb),
  },
});

function bindChannel(channel, cb) {
  const listener = (_event, value) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
