'use strict';
(function (root) {
  // Single-session clipboard synchronization. Never treat files as text, and do
  // not echo remotely written text back to the peer.
  function createRustDeskClipboardSync({ read, write, send, canSend, setTimer = setInterval, clearTimer = clearInterval, onError = console.warn }) {
    let active = false;
    let generation = 0;
    let lastText = null;
    let writing = false;
    let polling = false;
    let timer = null;
    let writes = Promise.resolve();
    async function poll() {
      if (!active || writing || polling || !canSend()) return;
      const revision = generation;
      polling = true;
      try {
        const text = await read();
        if (!active || revision !== generation || writing || !canSend() || typeof text !== 'string') return;
        if (text !== lastText && new TextEncoder().encode(text).length <= 4 * 1024 * 1024) {
          send(text);
          lastText = text;
        }
      } catch (error) { if (active && revision === generation) onError(error); }
      finally { if (revision === generation) polling = false; }
    }
    function remote(text) {
      if (!active || typeof text !== 'string') return;
      const revision = ++generation;
      polling = false;
      writing = true;
      writes = writes.catch(() => {}).then(async () => {
        if (!active || revision !== generation) return;
        await write(text);
        if (active && revision === generation) lastText = text;
      }).catch((error) => { if (active && revision === generation) onError(error); }).finally(() => {
        if (active && revision === generation) { writing = false; void poll(); }
      });
    }
    function invalidate() { generation++; polling = false; writing = false; lastText = null; }
    function start() {
      if (active) return;
      active = true;
      generation++;
      void poll();
      timer = setTimer(() => { void poll(); }, 1000);
    }
    function stop() {
      active = false; generation++; writing = false; polling = false; lastText = null;
      if (timer !== null) clearTimer(timer);
      timer = null;
    }
    return { start, stop, poll, remote, invalidate };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createRustDeskClipboardSync };
  if (root) root.createRustDeskClipboardSync = createRustDeskClipboardSync;
})(typeof window === 'undefined' ? null : window);
