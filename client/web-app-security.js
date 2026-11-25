'use strict';
function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\x00-\x20\x7f]/.test(value)) throw new Error('Укажите полный HTTPS-адрес.');
  let url; try { url = new URL(value); } catch { throw new Error('Укажите полный HTTPS-адрес.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Разрешён только HTTPS-адрес без встроенных учётных данных.');
  return url;
}
// Executed inside the guest's isolated world, never in the manager renderer.
// Only one unambiguous ordinary login form is eligible; no submit is performed.
function fillLogin(origin, username, password) {
  if (location.origin !== origin || location.protocol !== 'https:') return false;
  const candidates = [];
  for (const form of document.forms) {
    let action; try { action = new URL(form.action || location.href, location.href); } catch { continue; }
    if (action.origin !== origin || action.protocol !== 'https:') continue;
    const usable = (input) => !input.disabled && !input.readOnly && input.type !== 'hidden' && input.getClientRects().length > 0;
    const passwords = Array.from(form.querySelectorAll('input[type="password"]')).filter(usable);
    const users = Array.from(form.querySelectorAll('input')).filter((input) => usable(input) && ['text', 'email'].includes(input.type) && !/search/i.test(input.name || ''));
    if (passwords.length === 1 && users.length === 1 && !passwords[0].value && !users[0].value && passwords[0].autocomplete !== 'new-password') candidates.push({ user: users[0], password: passwords[0] });
  }
  if (candidates.length !== 1) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  for (const [element, value] of [[candidates[0].user, username], [candidates[0].password, password]]) {
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return true;
}
module.exports = { parseWebUrl, fillLogin };
