'use strict';
const crypto = require('node:crypto');

function createTicketStore({ now = Date.now, ttl = 30000, capacity = 4096 } = {}) {
  const tickets = new Map();
  function issue(info) {
    const time = now();
    for (const [key, value] of tickets) if (value.expires <= time) tickets.delete(key);
    if (tickets.size >= capacity) return null;
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(ticket, { ...info, expires: time + ttl });
    return ticket;
  }
  function consume(ticket, ip) {
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const value = tickets.get(ticket);
    if (!value) return null;
    tickets.delete(ticket); // Consume even if the address or expiry is wrong.
    return value.expires > now() && value.ip === ip ? value : null;
  }
  return { issue, consume };
}
module.exports = { createTicketStore, rdpTickets: createTicketStore() };
