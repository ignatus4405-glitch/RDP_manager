'use strict';
(function (root) {
  // Preserve explicitly qualified usernames (DOMAIN\\user and user@domain).
  function rdpCredentials(username, domain) {
    const user = String(username || '').trim();
    const realm = String(domain || '').trim();
    if (/[\x00-\x1f\x7f]/.test(user) || /[\x00-\x1f\x7f\\/@]/.test(realm)) throw new Error('Недопустимое имя пользователя или домена.');
    const effectiveDomain = user && !user.includes('\\') && !user.includes('@') ? realm : '';
    return { username: user, domain: effectiveDomain, qualifiedUsername: effectiveDomain ? `${effectiveDomain}\\${user}` : user };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { rdpCredentials };
  if (root) root.rdpCredentials = rdpCredentials;
})(typeof window === 'undefined' ? null : window);
