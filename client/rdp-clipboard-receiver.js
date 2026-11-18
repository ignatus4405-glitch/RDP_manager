'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Remote names are untrusted. Never allow absolute paths, traversal, alternate
// streams, or Windows device names to escape the private staging directory.
function validateParts(file) {
  const parent = String(file.path || '');
  const name = String(file.name || '');
  if (!name || /[\\/]/.test(name) || /^[\\/]/.test(parent)) throw new Error('Недопустимое имя в удалённом буфере.');
  const parts = [...(parent ? parent.split(/[\\/]/) : []), name];
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error('Недопустимый путь в удалённом буфере.');
    }
  }
  return parts;
}

async function clipboardFingerprint(clipboard) {
  const hash = crypto.createHash('sha256');
  const items = await clipboard.read();
  for (const item of items) {
    for (const type of [...item.types].sort()) {
      hash.update(type).update('\0');
      // All exposed payloads are included: do not overwrite a local copy made
      // while the remote files are being downloaded.
      const value = await item.getType(type);
      if (typeof value?.arrayBuffer === 'function') hash.update(Buffer.from(await value.arrayBuffer()));
      else hash.update(JSON.stringify(value ?? null));
      hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function createClipboardReceiver({ clipboard, ClipboardItem, tempDirectory }) {
  const transfers = new Map();
  async function begin(files) {
    if (!Array.isArray(files) || !files.length) throw new Error('В удалённом буфере нет файлов.');
    const names = new Set();
    const entries = files.map((file) => {
      const parts = validateParts(file);
      const key = parts.join('/').toLowerCase();
      if (names.has(key)) throw new Error('В удалённом буфере есть одинаковые имена.');
      names.add(key);
      return { parts, isDirectory: Boolean(file.isDirectory) };
    });
    const baseline = await clipboardFingerprint(clipboard);
    const directory = await fs.mkdtemp(path.join(tempDirectory, 'rdp-manager-clipboard-'));
    const id = crypto.randomUUID();
    transfers.set(id, { directory, entries, baseline, handles: new Map(), completed: new Set() });
    return id;
  }
  function get(id) {
    const transfer = transfers.get(id);
    if (!transfer) throw new Error('Передача в буфер уже завершена.');
    return transfer;
  }
  async function open(id, index) {
    const transfer = get(id);
    if (!Number.isInteger(index) || index < 0 || index >= transfer.entries.length || transfer.handles.size || transfer.completed.has(index)) throw new Error('Недопустимый файл.');
    const entry = transfer.entries[index];
    const target = path.join(transfer.directory, ...entry.parts);
    if (entry.isDirectory) { await fs.mkdir(target, { recursive: true }); transfer.completed.add(index); return; }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, 'wx', 0o600);
    transfer.handles.set(index, handle);
  }
  async function write(id, index, input) {
    const handle = get(id).handles.get(index);
    if (!handle || !(input instanceof Uint8Array) || !input.length || input.length > 1024 * 1024) throw new Error('Некорректный блок файла.');
    let offset = 0;
    while (offset < input.length) {
      const { bytesWritten } = await handle.write(input, offset, input.length - offset);
      if (!bytesWritten) throw new Error('Не удалось записать файл.');
      offset += bytesWritten;
    }
  }
  async function close(id, index) {
    const transfer = get(id);
    const handle = transfer.handles.get(index);
    if (!handle) throw new Error('Файл не открыт.');
    transfer.handles.delete(index);
    await handle.close();
    transfer.completed.add(index);
  }
  async function cancel(id) {
    const transfer = transfers.get(id);
    if (!transfer) return;
    transfers.delete(id);
    await Promise.allSettled([...transfer.handles.values()].map((handle) => handle.close()));
    await fs.rm(transfer.directory, { recursive: true, force: true });
  }
  async function commit(id) {
    const transfer = get(id);
    if (transfer.handles.size || transfer.completed.size !== transfer.entries.length) throw new Error('Передача файлов ещё не завершена.');
    if (await clipboardFingerprint(clipboard) !== transfer.baseline) throw new Error('Локальный буфер изменился во время передачи. Повторите копирование.');
    const top = [...new Set(transfer.entries.map((entry) => entry.parts[0]))];
    const uris = top.map((name) => pathToFileURL(path.join(transfer.directory, name)).href).join('\r\n') + '\r\n';
    await clipboard.write([new ClipboardItem({ 'text/uri-list': uris })]);
    // Keep the staging directory after app exit: the OS clipboard references it.
    transfers.delete(id);
  }
  async function cancelAll() { await Promise.allSettled([...transfers.keys()].map(cancel)); }
  return { begin, open, write, close, commit, cancel, cancelAll };
}

module.exports = { createClipboardReceiver, clipboardFingerprint, validateParts };
