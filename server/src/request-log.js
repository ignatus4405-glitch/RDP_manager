'use strict';
// Do not retain query strings: they may contain tokens, secrets or user input
// even when the parameter name is unexpected. Escape controls to prevent forged log lines.
function safeRequestPath(originalUrl) {
  return String(originalUrl || '').split('?', 1)[0].replace(/[\x00-\x1f\x7f]/g, '?').slice(0, 2048);
}
module.exports = { safeRequestPath };
