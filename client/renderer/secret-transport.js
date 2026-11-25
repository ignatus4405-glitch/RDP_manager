'use strict';
(function (root) {
  // Never send a password to a remote HTTP endpoint even if it promises to reject it.
  function canSendConnectionSecret(serverUrl) {
    let url;
    try { url = new URL(serverUrl); } catch { return false; }
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { canSendConnectionSecret };
  if (root) root.canSendConnectionSecret = canSendConnectionSecret;
})(typeof window === 'undefined' ? null : window);
