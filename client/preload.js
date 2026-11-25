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
  rdpLayoutFocus: (focused, token) => ipcRenderer.send('rdp-layout-focus', Boolean(focused), token),
  onRdpLayoutSwitch: (cb) => bindChannel('rdp-layout-switch', cb),
  webApp: {
    open: (options) => ipcRenderer.invoke('web-app-open', options),
    close: (id) => ipcRenderer.invoke('web-app-close', id),
    bounds: (id, rect) => ipcRenderer.invoke('web-app-bounds', id, rect),
    action: (id, command) => ipcRenderer.invoke('web-app-action', id, command),
    onEvent: (cb) => bindChannel('web-app-event', cb),
  },
  ssh: {
    open: (options) => ipcRenderer.invoke('ssh-open', options),
    close: (id) => ipcRenderer.invoke('ssh-close', id),
    write: (id, data) => ipcRenderer.invoke('ssh-write', id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke('ssh-resize', id, cols, rows),
    list: (id, directory) => ipcRenderer.invoke('ssh-list', id, directory),
    transfer: (id, remote, direction) => ipcRenderer.invoke('ssh-transfer', id, remote, direction),
    onEvent: (cb) => bindChannel('ssh-event', cb),
  },
  fileTransfer: {
    virtualAvailable: () => ipcRenderer.invoke('rdp-virtual-available'),
    virtualActive: () => ipcRenderer.invoke('rdp-virtual-active'),
    virtualPublish: (files, fingerprint, asyncMode) => ipcRenderer.invoke('rdp-virtual-publish', files, fingerprint, asyncMode),
    clipboardFingerprint: () => ipcRenderer.invoke('rdp-clipboard-fingerprint'),
    virtualActivate: (token) => ipcRenderer.invoke('rdp-virtual-activate', token),
    virtualClear: (token) => ipcRenderer.invoke('rdp-virtual-clear', token),
    virtualRespond: (response) => ipcRenderer.invoke('rdp-virtual-response', response),
    onVirtualRead: (cb) => bindChannel('rdp-virtual-read', cb),
    readTextOnly: () => ipcRenderer.invoke('rdp-clipboard-read-text-only'),
    readRich: () => ipcRenderer.invoke('rdp-clipboard-read-rich'),
    writeRich: (entries) => ipcRenderer.invoke('rdp-clipboard-write-rich', entries),
    clipboardFiles: () => ipcRenderer.invoke('rdp-clipboard-files'),
    readClipboardFile: (id, offset, size) => ipcRenderer.invoke('rdp-clipboard-file-read', id, offset, size),
    resetClipboardFiles: () => ipcRenderer.invoke('rdp-clipboard-files-reset'),
    receiveBegin: (files) => ipcRenderer.invoke('rdp-clipboard-receive-begin', files),
    receiveOpen: (id, index) => ipcRenderer.invoke('rdp-clipboard-receive-open', id, index),
    receiveWrite: (id, index, chunk) => ipcRenderer.invoke('rdp-clipboard-receive-write', id, index, chunk),
    receiveClose: (id, index) => ipcRenderer.invoke('rdp-clipboard-receive-close', id, index),
    receiveCommit: (id) => ipcRenderer.invoke('rdp-clipboard-receive-commit', id),
    receiveCancel: (id) => ipcRenderer.invoke('rdp-clipboard-receive-cancel', id),
    begin: (name) => ipcRenderer.invoke('rdp-file-begin', name),
    write: (id, chunk) => ipcRenderer.invoke('rdp-file-write', id, chunk),
    finish: (id) => ipcRenderer.invoke('rdp-file-finish', id),
    cancel: (id) => ipcRenderer.invoke('rdp-file-cancel', id),
  },
  /** Проверка и установка обновлений из GitHub Releases */
  updates: {
    /** Ручная проверка. Возвращает { packaged, version?, error? } — packaged:false в dev-режиме */
    check: () => ipcRenderer.invoke('update-check'),
    state: () => ipcRenderer.invoke('update-state'),
    onState: (cb) => bindChannel('update-state', cb),
    /** Перезапустить и установить загруженное обновление */
    install: () => ipcRenderer.invoke('update-install'),
    /** Подписка на «доступна новая версия» (версия придёт аргументом) */
    onAvailable: (cb) => bindChannel('update-available', cb),
    /** Подписка на «обновление загружено и готово к установке» */
    onDownloaded: (cb) => bindChannel('update-downloaded', cb),
    /** Подписка на ошибку проверки обновлений */
    onError: (cb) => bindChannel('update-error', cb),
  },
  /** Управление локальной службой Windows — доступно только из отдельного окна Server Manager. */
  server: {
    status: () => ipcRenderer.invoke('server-manager-status'),
    action: (action) => ipcRenderer.invoke('server-manager-action', action),
    logs: () => ipcRenderer.invoke('server-manager-logs'),
    openLogFolder: () => ipcRenderer.invoke('server-manager-open-log-folder'),
    openPanel: () => ipcRenderer.invoke('server-manager-open-panel'),
    checkUpdates: () => ipcRenderer.invoke('server-manager-update-check'),
    openRelease: (url) => ipcRenderer.invoke('server-manager-open-release', url),
    onUpdateResult: (cb) => bindChannel('server-manager-update', cb),
    onToast: (cb) => bindChannel('server-manager-toast', cb),
  },
});

function bindChannel(channel, cb) {
  const listener = (_event, value) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
