'use strict';
const crypto = require('node:crypto');
const { Blob } = require('node:buffer');
const TYPES = ['text/plain', 'text/html', 'image/png'];

function createRichClipboard({ clipboard, ClipboardItem }) {
  async function read() {
    const source = await clipboard.read();
    const entries = [];
    const hash = crypto.createHash('sha256');
    for (const type of TYPES) {
      const item = source.find((entry) => entry.types.includes(type));
      if (!item) continue;
      const blob = await item.getType(type);
      const bytes = Buffer.from(await blob.arrayBuffer());
      hash.update(type).update('\0').update(String(bytes.length)).update('\0').update(bytes);
      entries.push({ type, value: type === 'image/png' ? bytes : bytes.toString('utf8') });
    }
    return { signature: hash.digest('hex'), entries };
  }
  async function write(entries) {
    if (!Array.isArray(entries)) throw new Error('Некорректный буфер обмена.');
    const values = {};
    for (const entry of entries) {
      if (!TYPES.includes(entry.type) || Object.hasOwn(values, entry.type)) throw new Error('Неподдерживаемый формат буфера.');
      if (entry.type === 'image/png') {
        if (!(entry.value instanceof Uint8Array)) throw new Error('Некорректное изображение.');
        values[entry.type] = new Blob([entry.value], { type: entry.type });
      } else {
        if (typeof entry.value !== 'string') throw new Error('Некорректный текст.');
        values[entry.type] = entry.value;
      }
    }
    if (!Object.keys(values).length) return null;
    await clipboard.write([new ClipboardItem(values)]);
    return (await read()).signature;
  }
  return { read, write };
}
module.exports = { createRichClipboard };
