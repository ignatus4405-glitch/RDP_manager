'use strict';
(function (root) {
  // Bridges RustDesk's Cliprdr messages to Windows OLE. File bytes are read on demand.
  function createRustDeskFileClipboard({ protocol, bridge, send, canSend, onRemoteOffer = () => {}, onError = console.warn, setTimer = setInterval, clearTimer = clearInterval }) {
    const descriptorId = 49334, contentsId = 49267;
    let active = false, revision = 0, remoteRevision = 0, localFiles = [], token = null, pollPromise = null, timer = null;
    let offeredRevision = -1, servedRevision = -1;
    const offerWaiters = new Set();
    function wakeOffers() { for (const wake of offerWaiters) wake(); offerWaiters.clear(); }
    let formatRequest = null, queuedFormat = null, formatTimedOut = false, remotePublishing = false, serving = 0, nextStream = 1, pending = new Map(), queue = Promise.resolve();
    const emit = (kind, value) => { if (active && canSend()) send(protocol.encode(kind, value)); };
    const failPending = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Удалённый буфер изменился.')); } pending.clear(); };
    const clearVirtual = async () => { const old = token; token = null; if (old) await bridge.virtualClear(old); };
    function invalidateRemote() { remoteRevision++; remotePublishing = false; remoteFiles = []; failPending(); queue = queue.catch(() => {}).then(clearVirtual); }
    const unsubscribe = bridge.onVirtualRead(async (request) => {
      if (!active || !token || request.token !== token) return;
      const p = pendingRead(request.index, request.position, request.size);
      try { const bytes = await p; await bridge.virtualRespond({ token: request.token, requestId: request.requestId, bytes }); }
      catch { await bridge.virtualRespond({ token: request.token, requestId: request.requestId, error: true }).catch(() => {}); }
    });
    let remoteFiles = [], remoteListId = 0, localListId = 0;
    function pendingRead(index, position, size) {
      const file = remoteFiles[index];
      if (!active || !canSend() || !file || file.isDirectory || !Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(size) || size < 1 || size > 65536 || position + size > file.size) return Promise.reject(new Error('Некорректный запрос файла.'));
      const streamId = nextStream++;
      if (nextStream > 0x7fffffff) nextStream = 1;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(streamId); reject(new Error('Время ожидания файла истекло.')); }, 30000);
        pending.set(streamId, { resolve, reject, timer: timeout, size });
        emit('fileContentsRequest', { streamId, index, flags: 2, positionLow: (position >>> 0) | 0, positionHigh: (Math.floor(position / 0x100000000) >>> 0) | 0, size, haveClipDataId: 1, clipDataId: remoteListId });
      });
    }
    function poll() {
      if (pollPromise) return pollPromise;
      if (!active || !canSend() || formatRequest || queuedFormat || remotePublishing) return Promise.resolve();
      const rev = revision;
      pollPromise = (async () => { try {
        if (await bridge.virtualActive()) return;
        const snapshot = await bridge.clipboardFiles();
        if (!active || rev !== revision || !canSend()) return;
        if (!snapshot) { if (localFiles.length) { localFiles = []; revision++; } return; }
        if (!snapshot.unchanged && snapshot.files.length) {
          const descriptor = protocol.encodeDescriptors(snapshot.files); // reject metadata that cannot be represented safely
          invalidateRemote(); localFiles = snapshot.files; localListId = protocol.fileListId(descriptor); revision++;
          offeredRevision = revision; servedRevision = -1; wakeOffers();
          emit('formatList', { formats: [{ id: descriptorId, name: 'FileGroupDescriptorW' }, { id: contentsId, name: 'FileContents' }] });
        }
      } catch (error) { if (active && rev === revision) onError(error); }
      finally { pollPromise = null; }
      })();
      return pollPromise;
    }
    async function preparePaste() {
      await poll();
      if (!active || !canSend() || !localFiles.length) return false;
      if (servedRevision === offeredRevision) return true;
      const rev = offeredRevision;
      await new Promise((resolve) => {
        let timeout;
        const wake = () => { clearTimeout(timeout); offerWaiters.delete(wake); resolve(); };
        timeout = setTimeout(wake, 2000); offerWaiters.add(wake);
        if (!active || offeredRevision !== rev || servedRevision === rev) wake();
      });
      return active && localFiles.length > 0 && offeredRevision === rev;
    }
    function requestFormat(id, rev, baseline) {
      if (formatTimedOut) return; // A late uncorrelated reply must not be attributed to a newer clipboard.
      if (formatRequest) { queuedFormat = { id, rev, baseline }; return; }
      formatRequest = { id, rev, baseline, timer: setTimeout(() => { formatRequest = null; queuedFormat = null; formatTimedOut = true; onError(new Error('Истекло время ожидания файлового буфера; переподключитесь.')); }, 30000) };
      emit('formatDataRequest', { formatId: id });
    }
    async function publish(files, rev, baseline) {
      remotePublishing = true;
      queue = queue.catch(() => {}).then(async () => {
        if (!active || rev !== remoteRevision || !canSend()) return;
        await clearVirtual();
        const newToken = await bridge.virtualPublish(files, baseline, true);
        if (!active || rev !== remoteRevision || !canSend()) { await bridge.virtualClear(newToken); return; }
        token = newToken; remoteFiles = files;
        try { await bridge.virtualActivate(newToken); } catch (error) { token = null; await bridge.virtualClear(newToken); throw error; }
      });
      try { await queue; } finally { if (rev === remoteRevision) remotePublishing = false; }
    }
    async function serveRequest(v) {
      const rev = revision;
      if (serving >= 32) { emit('fileContentsResponse', { flags: 2, streamId: v.streamId, data: new Uint8Array() }); return; }
      serving++;
      try {
        await poll();
        if (rev !== revision) throw new Error('Локальный буфер изменился.');
        const file = localFiles[v.index];
        const position = (v.positionLow >>> 0) + (v.positionHigh >>> 0) * 0x100000000;
        if (!file || file.isDirectory || (v.haveClipDataId && v.clipDataId !== localListId) || !Number.isSafeInteger(position) || position > file.size || !Number.isInteger(v.size) || v.size < 0 || v.size > 1024 * 1024) throw new Error('Некорректный запрос файла.');
        let data;
        if (v.flags === 1) { data = new Uint8Array(8); new DataView(data.buffer).setBigUint64(0, BigInt(file.size), true); }
        else if (v.flags === 2) data = new Uint8Array(await bridge.readClipboardFile(file.id, position, Math.min(v.size, file.size - position)));
        else throw new Error('Некорректный тип запроса.');
        if (active && rev === revision && canSend()) emit('fileContentsResponse', { flags: 1, streamId: v.streamId, data });
      } catch (error) { if (active && canSend()) emit('fileContentsResponse', { flags: 2, streamId: v.streamId, data: new Uint8Array() }); }
      finally { serving--; }
    }
    function receive(data) {
      if (!active || !canSend()) return;
      try {
        const msg = protocol.decode(data); if (!msg) return;
        const v = msg.value;
        switch (msg.kind) {
          case 'ready': if (localFiles.length) emit('formatList', { formats: [{ id: descriptorId, name: 'FileGroupDescriptorW' }, { id: contentsId, name: 'FileContents' }] }); else void poll(); break;
          case 'formatList': {
            onRemoteOffer(); revision++; localFiles = []; invalidateRemote();
            const descriptor = v.formats.find((f) => f.name === 'FileGroupDescriptorW');
            const contents = v.formats.some((f) => f.name === 'FileContents');
            emit('formatListResponse', { flags: 1 });
            if (descriptor && contents) {
              const rev = remoteRevision;
              remotePublishing = true;
              queue = queue.catch(() => {}).then(async () => {
                await bridge.resetClipboardFiles();
                const baseline = await bridge.clipboardFingerprint();
                if (active && rev === remoteRevision && canSend()) requestFormat(descriptor.id, rev, baseline);
              }).catch((error) => { if (active && rev === remoteRevision) onError(error); }).finally(() => { if (rev === remoteRevision) remotePublishing = false; });
            }
            break;
          }
          case 'formatDataRequest': {
            let data = new Uint8Array(), flags = 2;
            try { if (v.formatId === descriptorId && localFiles.length) { data = protocol.encodeDescriptors(localFiles); flags = 1; } } catch (error) { onError(error); }
            emit('formatDataResponse', { flags, data });
            if (flags === 1) { servedRevision = revision; wakeOffers(); }
            break;
          }
          case 'formatDataResponse': {
            const request = formatRequest; if (!request) break;
            clearTimeout(request.timer); formatRequest = null;
            try {
              if (request.rev === remoteRevision && v.flags === 1) {
                const files = protocol.decodeDescriptors(v.data);
                remoteListId = protocol.fileListId(v.data);
                void publish(files, request.rev, request.baseline).catch(onError);
              }
            } finally {
              const next = queuedFormat; queuedFormat = null;
              if (next && next.rev === remoteRevision) requestFormat(next.id, next.rev, next.baseline);
            }
            break;
          }
          case 'fileContentsRequest': void serveRequest(v); break;
          case 'fileContentsResponse': {
            const p = pending.get(v.streamId); if (!p) break;
            pending.delete(v.streamId); clearTimeout(p.timer);
            if (v.flags !== 1 || v.data.length !== p.size) p.reject(new Error('Ошибка чтения удалённого файла.'));
            else p.resolve(v.data);
            break;
          }
          case 'tryEmpty': revision++; localFiles = []; invalidateRemote(); break;
        }
      } catch (error) { onError(error); }
    }
    function suspend() { revision++; localFiles = []; wakeOffers(); invalidateRemote(); }
    function start() { if (active) return; active = true; emit('ready'); void poll(); timer = setTimer(() => void poll(), 800); }
    function stop() {
      if (!active) { unsubscribe(); return; }
      active = false; revision++; wakeOffers(); invalidateRemote(); localFiles = []; remoteFiles = [];
      if (timer !== null) clearTimer(timer); timer = null;
      if (formatRequest) clearTimeout(formatRequest.timer); formatRequest = null; queuedFormat = null;
      void bridge.resetClipboardFiles().catch(() => {}); unsubscribe();
    }
    return { start, stop, poll, preparePaste, receive, invalidateRemote, suspend, isReceiving: () => Boolean(formatRequest || queuedFormat || remotePublishing) };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createRustDeskFileClipboard };
  if (root) root.createRustDeskFileClipboard = createRustDeskFileClipboard;
})(typeof window === 'undefined' ? null : window);
