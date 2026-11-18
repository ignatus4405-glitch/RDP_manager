'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

// The renderer never supplies a destination path. It receives only a random handle
// after the user has approved a save dialog in the main process.
function createRdpFileWriter({ choosePath }) {
  const transfers = new Map();
  let opening = false;
  let generation = 0;
  async function begin(name) {
    if (opening || transfers.size) throw new Error('Другая запись файла уже выполняется.');
    opening = true;
    const currentGeneration = generation;
    try {
      const destination = await choosePath(name);
      if (!destination || currentGeneration !== generation) throw new Error('Сохранение файла отменено.');
      const id = crypto.randomUUID();
      const temporary = path.join(path.dirname(destination), `.rdp-transfer-${id}.tmp`);
      const handle = await fs.open(temporary, 'wx', 0o600);
      if (currentGeneration !== generation) {
        await handle.close();
        await fs.unlink(temporary).catch(() => {});
        throw new Error('Сохранение файла отменено.');
      }
      transfers.set(id, { destination, temporary, handle, writing: false });
      return id;
    } finally { opening = false; }
  }
  async function write(id, input) {
    const transfer = transfers.get(id);
    if (!transfer || transfer.writing) throw new Error('Файл передачи недоступен.');
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > 1024 * 1024) throw new Error('Некорректный блок файла.');
    transfer.writing = true;
    let resolveWrite;
    transfer.writeDone = new Promise((resolve) => { resolveWrite = resolve; });
    try {
      let offset = 0;
      while (offset < input.byteLength) {
        const { bytesWritten } = await transfer.handle.write(input, offset, input.byteLength - offset);
        if (!bytesWritten) throw new Error('Не удалось записать файл.');
        offset += bytesWritten;
      }
    } finally { transfer.writing = false; resolveWrite(); }
  }
  async function cancel(id) {
    const transfer = transfers.get(id);
    if (!transfer) return;
    if (transfer.writing) throw new Error('Запись файла ещё выполняется.');
    transfers.delete(id);
    await transfer.handle.close();
    await fs.unlink(transfer.temporary).catch(() => {});
  }
  async function finish(id) {
    const transfer = transfers.get(id);
    if (!transfer || transfer.writing) throw new Error('Файл передачи недоступен.');
    await transfer.handle.close();
    transfers.delete(id);
    try { await fs.rename(transfer.temporary, transfer.destination); }
    catch (error) { await fs.unlink(transfer.temporary).catch(() => {}); throw error; }
  }
  async function cancelAll() {
    generation++;
    await Promise.allSettled([...transfers.entries()].map(async ([id, transfer]) => {
      if (transfer.writeDone) await transfer.writeDone;
      await cancel(id);
    }));
  }
  return { begin, write, finish, cancel, cancelAll };
}
module.exports = { createRdpFileWriter };
