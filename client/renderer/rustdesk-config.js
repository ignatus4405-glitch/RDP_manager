'use strict';

// Connection parameters only. This does not create a RustDesk session.
(function (root) {
  function normalizeWss(value, label) {
    let url;
    try { url = new URL(String(value).trim()); }
    catch { throw new Error(`${label}: укажите корректный адрес WSS.`); }
    if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.hash || url.search) {
      throw new Error(`${label}: нужен адрес wss:// без учётных данных, параметров и фрагмента.`);
    }
    return url.href;
  }

  function validateKey(value) {
    const key = String(value).trim();
    // id_ed25519.pub is the public 32-byte server verification key, not the private key.
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('Ожидается публичный ключ RustDesk id_ed25519.pub в формате base64.');
    let decoded;
    try { decoded = atob(key); } catch { throw new Error('Некорректный публичный ключ RustDesk.'); }
    if (decoded.length !== 32 || btoa(decoded) !== key) throw new Error('Публичный ключ RustDesk должен содержать 32 байта.');
    return key;
  }

  function validateRustDeskConfig({ idUrl, relayUrl, publicKey }) {
    return {
      idUrl: normalizeWss(idUrl, 'Сервер ID'),
      relayUrl: normalizeWss(relayUrl, 'Сервер relay'),
      publicKey: validateKey(publicKey),
    };
  }
  function directRustDeskConfig({ server, publicKey }) {
    const raw = String(server).trim();
    if (!raw || /[\/?#@\s]/.test(raw)) throw new Error('Укажите имя или IP сервера ID, при необходимости с портом.');
    let address;
    try { address = new URL(`http://${raw}`); } catch { throw new Error('Некорректный адрес сервера ID.'); }
    if (!address.hostname || address.username || address.password || address.pathname !== '/' || address.search || address.hash) throw new Error('Некорректный адрес сервера ID.');
    const port = address.port ? Number(address.port) : 21116;
    if (port < 1 || port > 65532) throw new Error('Недопустимый порт сервера ID.');
    return { idUrl: `ws://${address.hostname}:${port + 2}/`, fallbackRelayUrl: `ws://${address.hostname}:${port + 3}/`, publicKey: validateKey(publicKey) };
  }
  function directRelayUrl(server) {
    const raw = String(server).trim();
    if (!raw || /[\/?#@\s]/.test(raw)) throw new Error('Некорректный адрес relay.');
    let address;
    try { address = new URL(`http://${raw}`); } catch { throw new Error('Некорректный адрес relay.'); }
    const port = address.port ? Number(address.port) : 21117;
    if (!address.hostname || port < 1 || port > 65533) throw new Error('Некорректный порт relay.');
    return `ws://${address.hostname}:${port + 2}/`;
  }
  const api = { validateRustDeskConfig, directRustDeskConfig, directRelayUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.RustDeskConfig = api;
})(typeof window === 'undefined' ? null : window);
