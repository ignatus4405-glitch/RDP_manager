'use strict';

// CLIPRDR file streams; local access is limited to the OS clipboard or file picker.
(function (root) {
  const CHUNK_SIZE = 64 * 1024;
  const TIMEOUT_MS = 30000;

  function createRdpFileTransfer({ getSession, Extension, onStatus, onRemoteFiles = () => {}, onClipboardFinished = () => {}, openFile, clipboardReceiver }) {
    let localFiles = [];
    let remoteFiles = [];
    let pending = null;
    let nextStream = 1;
    let generation = 0;
    let remoteRevision = 0;
    let clipboardQueue = Promise.resolve();
    let virtualReadQueue = Promise.resolve();
    const status = (message) => onStatus(message);
    const extension = (name, value) => new Extension(name, value);
    function submit(stream, data, isError = false) {
      const session = getSession();
      if (session) session.invokeExtension(extension('submit_file_contents', { stream_id: stream, is_error: isError, data }));
    }
    function reset() {
      generation++;
      remoteRevision++;
      localFiles = [];
      remoteFiles = [];
      if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Сессия RDP завершена.')); pending = null; }
    }
    function setup(builder) {
      const sessionGeneration = generation;
      builder.extension(extension('files_available_callback', (files, clipDataId) => {
        if (sessionGeneration !== generation) return;
        remoteRevision++;
        if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Удалённый буфер изменился.')); pending = null; }
        remoteFiles = Array.from(files || []).map((file, index) => ({ ...file, index, clipDataId }));
        onRemoteFiles(remoteFiles.length > 0 && Boolean(clipboardReceiver));
        if (remoteFiles.length && clipboardReceiver) {
          const revision = remoteRevision;
          const selected = remoteFiles.slice();
          status(`Получение ${selected.length} файлов в буфер обмена…`);
          clipboardQueue = clipboardQueue.catch(() => {}).then(() => copyToClipboard(selected, revision)).catch((error) => {
            if (revision === remoteRevision) status(`Ошибка буфера обмена: ${error.message}`);
          });
        } else {
          status(remoteFiles.length ? `Удалённый буфер: ${remoteFiles.length} файл(ов). Нажмите «Получить файлы».` : 'В удалённом буфере нет файлов.');
        }
      }));
      builder.extension(extension('file_contents_request_callback', async (request) => {
        if (sessionGeneration !== generation) return;
        const session = getSession();
        const file = localFiles[request.index];
        try {
          if (!session || !file) throw new Error('Файл недоступен');
          let bytes;
          if (request.flags === 1) {
            bytes = new Uint8Array(8);
            new DataView(bytes.buffer).setBigUint64(0, BigInt(file.size), true);
          } else if (request.flags === 2 && Number.isSafeInteger(request.position) && Number.isSafeInteger(request.size)
                     && request.position >= 0 && request.position <= file.size && request.size >= 0 && request.size <= CHUNK_SIZE * 16) {
            bytes = new Uint8Array(await file.slice(request.position, request.position + request.size).arrayBuffer());
          } else throw new Error('Некорректный запрос файла');
          if (sessionGeneration === generation && session === getSession()) submit(request.streamId, bytes);
        } catch (error) {
          if (sessionGeneration === generation && session === getSession()) submit(request.streamId, new Uint8Array(0), true);
          status(`Ошибка передачи файла: ${error.message}`);
        }
      }));
      builder.extension(extension('file_contents_response_callback', (response) => {
        if (sessionGeneration !== generation || !pending || pending.stream !== response.streamId) return;
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (response.isError) request.reject(new Error('Удалённый компьютер отклонил запрос файла.'));
        else request.resolve(new Uint8Array(response.data));
      }));
    }
    function request(file, flags, position, size) {
      const session = getSession();
      if (!session) return Promise.reject(new Error('Сессия RDP не подключена.'));
      if (pending) return Promise.reject(new Error('Передача файла уже выполняется.'));
      const stream = nextStream++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { if (pending?.stream === stream) pending = null; reject(new Error('Превышено время ожидания файла.')); }, TIMEOUT_MS);
        pending = { stream, resolve, reject, timer };
        try { session.invokeExtension(extension('request_file_contents', { stream_id: stream, file_index: file.index, flags, position, size, clip_data_id: file.clipDataId })); }
        catch (error) { clearTimeout(timer); pending = null; reject(error); }
      });
    }
    // A future OS clipboard provider can expose these descriptors immediately
    // and call read only when a destination requests bytes. Each offer is tied
    // to its original clipboard generation; stale handles must never read the
    // newly copied remote files by accident.
    function virtualOffer() {
      const revision = remoteRevision;
      const selected = remoteFiles.slice();
      function assertCurrent() {
        if (revision !== remoteRevision || !getSession()) throw new Error('Удалённый буфер или сессия изменились.');
      }
      async function read(index, position, size) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= selected.length || selected[index].isDirectory ||
            !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024) {
          throw new Error('Некорректный запрос виртуального файла.');
        }
        const operation = virtualReadQueue.then(async () => {
          assertCurrent();
          const bytes = await request(selected[index], 2, position, size);
          assertCurrent();
          if (bytes.length > size) throw new Error('Некорректный ответ на запрос файла.');
          return bytes;
        });
        virtualReadQueue = operation.catch(() => {});
        return operation;
      }
      return { files: selected.map((file) => ({ ...file })), read };
    }
    function offer(files) {
      const session = getSession();
      if (!session) throw new Error('Сначала подключитесь к RDP.');
      const selected = Array.from(files || []);
      if (!selected.length) throw new Error('Выберите файлы для передачи.');
      if (selected.some((file) => !Number.isSafeInteger(file.size) || file.size < 0)) throw new Error('Не удалось определить размер файла.');
      localFiles = selected;
      try { session.invokeExtension(extension('initiate_file_copy', selected.map((file) => ({ name: file.name, path: file.path, size: file.size, lastModified: file.lastModified, isDirectory: Boolean(file.isDirectory) })))); }
      catch (error) { localFiles = []; throw error; }
      status('Файлы готовы. Вставьте их на удалённом компьютере (Ctrl+V).');
    }
    async function copyToClipboard(selected, revision) {
      const check = () => {
        if (revision !== remoteRevision || !getSession()) throw new Error('Содержимое буфера или сессия изменились.');
      };
      check();
      let receiverId;
      let success = false;
      try {
        receiverId = await clipboardReceiver.begin(selected.map(({ name, path, isDirectory }) => ({ name, path, isDirectory })));
        check();
        for (let index = 0; index < selected.length; index++) {
          check();
          const file = selected[index];
          if (file.isDirectory) { await clipboardReceiver.open(receiverId, index); continue; }
          const sizeBytes = await request(file, 1, 0, 8);
          if (sizeBytes.length !== 8) throw new Error('Некорректный размер файла.');
          const sizeBig = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 8).getBigUint64(0, true);
          if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Размер файла превышает точность JavaScript.');
          const size = Number(sizeBig);
          await clipboardReceiver.open(receiverId, index);
          let position = 0;
          while (position < size) {
            check();
            const count = Math.min(CHUNK_SIZE, size - position);
            const chunk = await request(file, 2, position, count);
            if (!chunk.length || chunk.length > count) throw new Error('Неполный или некорректный ответ на запрос файла.');
            await clipboardReceiver.write(receiverId, index, chunk);
            position += chunk.length;
            status(`Получение файла ${file.name}: ${Math.round(position / size * 100)}%.`);
          }
          check();
          await clipboardReceiver.close(receiverId, index);
        }
        check();
        await clipboardReceiver.commit(receiverId);
        receiverId = null;
        success = true;
        status('Файлы готовы в системном буфере обмена. Вставьте их с помощью Ctrl+V.');
      } finally {
        if (receiverId) await clipboardReceiver.cancel(receiverId).catch(() => {});
        if (revision === remoteRevision) await onClipboardFinished(success);
      }
    }
    async function download() {
      if (!remoteFiles.length) throw new Error('Скопируйте файлы на удалённом компьютере.');
      if (remoteFiles.some((file) => file.isDirectory || file.path)) throw new Error('Получение папок пока не поддерживается. Скопируйте отдельные файлы.');
      if (pending) throw new Error('Передача файла уже выполняется.');
      const myGeneration = generation;
      for (const file of remoteFiles.slice()) {
        const sizeBytes = await request(file, 1, 0, 8);
        if (sizeBytes.length !== 8) throw new Error('Некорректный размер файла.');
        const sizeBig = new DataView(sizeBytes.buffer, sizeBytes.byteOffset, 8).getBigUint64(0, true);
        if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Размер файла превышает точность JavaScript.');
        const size = Number(sizeBig);
        const safeName = String(file.name || 'file').split(/[\\/]/).pop().replace(/[\x00-\x1f<>:"|?*]/g, '_') || 'file';
        const output = await openFile(safeName);
        try {
          let position = 0;
          while (position < size) {
            if (generation !== myGeneration) throw new Error('Сессия RDP завершена.');
            const count = Math.min(CHUNK_SIZE, size - position);
            const chunk = await request(file, 2, position, count);
            if (!chunk.length || chunk.length > count) throw new Error('Неполный или некорректный ответ на запрос файла.');
            await output.write(chunk);
            position += chunk.length;
            status(`Получение файла ${safeName}: ${Math.round(position / size * 100)}%.`);
          }
          if (generation !== myGeneration) throw new Error('Сессия RDP завершена.');
          await output.close();
        } catch (error) {
          await output.abort().catch(() => {});
          throw error;
        }
      }
      status('Файлы получены.');
    }
    return { setup, offer, download, reset, virtualOffer };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createRdpFileTransfer };
  else root.createRdpFileTransfer = createRdpFileTransfer;
})(typeof window === 'undefined' ? globalThis : window);
