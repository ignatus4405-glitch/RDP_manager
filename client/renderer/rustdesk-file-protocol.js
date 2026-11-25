'use strict';
// RustDesk Message.cliprdr (message.proto field 20) and Windows FILEGROUPDESCRIPTORW.
(function (root) {
  const MAX_WIRE = 8 * 1024 * 1024;
  const MAX_FILES = 4096;
  function varint(value) {
    let n = BigInt(value);
    if (n < 0n) n = BigInt.asUintN(64, n);
    const out = [];
    do { let b = Number(n & 127n); n >>= 7n; if (n) b |= 128; out.push(b); } while (n);
    return out;
  }
  function join(parts) { const n = parts.reduce((sum, x) => sum + x.length, 0); const out = new Uint8Array(n); let p = 0; for (const x of parts) { out.set(x, p); p += x.length; } return out; }
  function intField(no, value) { return Uint8Array.from([...varint(no * 8), ...varint(value)]); }
  function bytesField(no, value) { return join([Uint8Array.from([...varint(no * 8 + 2), ...varint(value.length)]), value]); }
  function fields(data) {
    if (!(data instanceof Uint8Array) || data.length > MAX_WIRE) throw new Error('Некорректное сообщение файлового буфера.');
    let p = 0; const out = [];
    function readVar() { let n = 0n; for (let i = 0; i < 10; i++) { if (p >= data.length) throw new Error('Обрезанное сообщение.'); const b = data[p++]; n |= BigInt(b & 127) << BigInt(i * 7); if (!(b & 128)) return n; } throw new Error('Некорректное число protobuf.'); }
    while (p < data.length) {
      if (out.length >= 16384) throw new Error('Слишком много полей protobuf.');
      const tag = readVar(); const no = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!no) throw new Error('Некорректное поле protobuf.');
      if (wire === 0) out.push({ no, wire, value: readVar() });
      else if (wire === 2) { const len = readVar(); if (len > BigInt(data.length - p)) throw new Error('Обрезанное поле protobuf.'); const n = Number(len); out.push({ no, wire, value: data.subarray(p, p + n) }); p += n; }
      else if (wire === 1 || wire === 5) { const n = wire === 1 ? 8 : 4; if (p + n > data.length) throw new Error('Обрезанное поле protobuf.'); p += n; }
      else throw new Error('Неподдерживаемое поле protobuf.');
    }
    return out;
  }
  const utf8 = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const kinds = { ready: 1, formatList: 2, formatListResponse: 3, formatDataRequest: 4, formatDataResponse: 5, fileContentsRequest: 6, fileContentsResponse: 7, tryEmpty: 8 };
  function encode(kind, value = {}) {
    const inner = [];
    if (kind === 'formatList') for (const f of value.formats) inner.push(bytesField(2, join([intField(2, f.id), bytesField(3, utf8.encode(f.name))])));
    else {
      const specs = {
        formatListResponse: [['flags', 2, 'int']], formatDataRequest: [['formatId', 2, 'int']],
        formatDataResponse: [['flags', 2, 'int'], ['data', 3, 'bytes']],
        fileContentsRequest: [['streamId', 2, 'int'], ['index', 3, 'int'], ['flags', 4, 'int'], ['positionLow', 5, 'int'], ['positionHigh', 6, 'int'], ['size', 7, 'int'], ['haveClipDataId', 8, 'int'], ['clipDataId', 9, 'int']],
        fileContentsResponse: [['flags', 3, 'int'], ['streamId', 4, 'int'], ['data', 5, 'bytes']],
      };
      for (const [name, no, type] of specs[kind] || []) if (value[name] !== undefined) inner.push(type === 'int' ? intField(no, value[name]) : bytesField(no, value[name]));
    }
    if (!kinds[kind]) throw new Error('Неизвестный тип файлового буфера.');
    return bytesField(kinds[kind], join(inner));
  }
  function decode(data) {
    const top = fields(data).filter((f) => f.wire === 2 && f.no >= 1 && f.no <= 8).at(-1);
    if (!top) return null;
    const kind = Object.keys(kinds).find((key) => kinds[key] === top.no); const f = fields(top.value);
    const num = (no) => Number(BigInt.asIntN(32, f.findLast((x) => x.no === no && x.wire === 0)?.value ?? 0n));
    const bytes = (no) => f.findLast((x) => x.no === no && x.wire === 2)?.value ?? new Uint8Array();
    let value = {};
    if (kind === 'formatList') value.formats = f.filter((x) => x.no === 2 && x.wire === 2).map((x) => { const z = fields(x.value); return { id: Number(BigInt.asIntN(32, z.findLast((y) => y.no === 2 && y.wire === 0)?.value ?? 0n)), name: decoder.decode(z.findLast((y) => y.no === 3 && y.wire === 2)?.value ?? new Uint8Array()) }; });
    if (kind === 'formatListResponse') value = { flags: num(2) };
    if (kind === 'formatDataRequest') value = { formatId: num(2) };
    if (kind === 'formatDataResponse') value = { flags: num(2), data: bytes(3) };
    if (kind === 'fileContentsRequest') value = { streamId: num(2), index: num(3), flags: num(4), positionLow: num(5), positionHigh: num(6), size: num(7), haveClipDataId: Boolean(num(8)), clipDataId: num(9) };
    if (kind === 'fileContentsResponse') value = { flags: num(3), streamId: num(4), data: bytes(5) };
    return { kind, value };
  }
  function encodeDescriptors(files) {
    if (!files.length || files.length > MAX_FILES) throw new Error('Некорректное число файлов.');
    const data = new Uint8Array(4 + files.length * 592); const view = new DataView(data.buffer); view.setUint32(0, files.length, true);
    files.forEach((file, i) => {
      const name = (file.path ? `${file.path}\\` : '') + file.name;
      if (!name || name.length >= 260 || name.includes('\0') || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('Некорректное имя или размер файла.');
      const off = 4 + i * 592;
      view.setUint32(off, 0x44, true); // FD_ATTRIBUTES | FD_FILESIZE
      view.setUint32(off + 36, file.isDirectory ? 0x10 : 0x80, true);
      view.setUint32(off + 64, Math.floor(file.size / 0x100000000), true);
      view.setUint32(off + 68, file.size >>> 0, true);
      for (let j = 0; j < name.length; j++) view.setUint16(off + 72 + j * 2, name.charCodeAt(j), true);
    });
    return data;
  }
  function decodeDescriptors(data) {
    if (!(data instanceof Uint8Array) || data.length < 4) throw new Error('Некорректный список файлов.');
    const v = new DataView(data.buffer, data.byteOffset, data.byteLength); const count = v.getUint32(0, true);
    if (!count || count > MAX_FILES || data.length !== 4 + count * 592) throw new Error('Некорректный список файлов.');
    const files = [];
    for (let i = 0; i < count; i++) {
      const off = 4 + i * 592; const flags = v.getUint32(off, true); const attr = v.getUint32(off + 36, true);
      if (!(flags & 0x40) && !(attr & 0x10)) throw new Error('Отсутствует размер файла.');
      const size = v.getUint32(off + 64, true) * 0x100000000 + v.getUint32(off + 68, true);
      if (!Number.isSafeInteger(size)) throw new Error('Слишком большой файл.');
      let name = ''; let terminated = false;
      for (let j = 0; j < 260; j++) { const c = v.getUint16(off + 72 + j * 2, true); if (!c) { terminated = true; break; } name += String.fromCharCode(c); }
      if (!terminated || !name || /\//.test(name)) throw new Error('Некорректное имя файла.');
      const parts = name.split('\\'); if (parts.some((x) => !x || x === '.' || x === '..')) throw new Error('Некорректный путь файла.');
      files.push({ name: parts.pop(), path: parts.length ? parts.join('\\') : undefined, size, isDirectory: Boolean(attr & 0x10) });
    }
    return files;
  }
  function fileListId(bytes) { let hash = 0x811c9dc5; for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0; return hash | 0; }
  const api = { encode, decode, encodeDescriptors, decodeDescriptors, fileListId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RustDeskFileProtocol = api;
})(typeof window === 'undefined' ? null : window);
