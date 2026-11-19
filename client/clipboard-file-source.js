'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const crypto = require('node:crypto');

// Capabilities expose only files that the user has copied to the OS clipboard.
function createClipboardFileSource({ clipboard }) {
  let snapshot = '';
  let files = new Map();
  let generation = 0;
  async function inspect() {
    const currentGeneration = generation;
    const ensureCurrent = () => { if (generation !== currentGeneration) throw new Error('Буфер обмена был сброшен.'); };
    const items = await clipboard.read();
    ensureCurrent();
    const item = items.find((candidate) => candidate.types.includes('text/uri-list'));
    if (!item) { snapshot = ''; files = new Map(); return null; }
    const raw = await (await item.getType('text/uri-list')).text();
    ensureCurrent();
    const urls = raw.split(/\r?\n/).filter((line) => line && !line.startsWith('#'));
    if (!urls.length) { snapshot = ''; files = new Map(); return null; }
    if (raw === snapshot) return { unchanged: true };
    const roots = urls.map((url) => fileURLToPath(url));
    const names = new Set();
    const next = new Map();
    const descriptors = [];
    async function visit(filePath, relative) {
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink()) throw new Error('Копирование ссылок через RDP не поддерживается.');
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('Можно копировать только файлы и папки.');
      const name = relative.split(path.sep).join('\\');
      if (names.has(name.toLowerCase())) throw new Error('В буфере есть файлы с одинаковыми именами.');
      names.add(name.toLowerCase());
      const id = crypto.randomUUID();
      const parent = path.dirname(relative);
      const entry = { id, name: path.basename(relative), path: parent === '.' ? undefined : parent.split(path.sep).join('\\'), size: stat.isDirectory() ? 0 : stat.size, lastModified: Math.trunc(stat.mtimeMs), isDirectory: stat.isDirectory() };
      descriptors.push(entry);
      if (stat.isFile()) next.set(id, { path: filePath, size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
      if (stat.isDirectory()) {
        const children = await fs.readdir(filePath);
        children.sort();
        for (const child of children) await visit(path.join(filePath, child), path.join(relative, child));
      }
    }
    for (const root of roots) await visit(root, path.basename(root));
    ensureCurrent();
    snapshot = raw;
    files = next;
    return { unchanged: false, files: descriptors };
  }
  async function read(id, offset, size) {
    const file = files.get(id);
    if (!file || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || size > 1024 * 1024 || offset > file.size) throw new Error('Некорректный запрос файла из буфера.');
    const handle = await fs.open(file.path, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.size || stat.mtimeMs !== file.mtimeMs) throw new Error('Файл в буфере изменился; скопируйте его заново.');
      const bytes = Buffer.alloc(Math.min(size, file.size - offset));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      return bytes.subarray(0, bytesRead);
    } finally { await handle.close(); }
  }
  function reset() { generation++; snapshot = ''; files = new Map(); }
  return { inspect, read, reset };
}
module.exports = { createClipboardFileSource };
