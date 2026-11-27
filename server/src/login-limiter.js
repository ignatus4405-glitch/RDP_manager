'use strict';
// Process-local protection. Reverse proxies are not trusted for client IPs.
function createLoginLimiter({ now = Date.now, windowMs = 15 * 60 * 1000, maxEntries = 20000 } = {}) {
  const entries = new Map();
  let nextSweep = 0;
  function reserve(ip, username) {
    const time = now();
    if (time >= nextSweep) {
      for (const [key, item] of entries) if (!item.pending && item.until <= time) entries.delete(key);
      nextSweep = time + 60000;
    }
    const keys = [`ip:${ip}`, `user:${username.toLowerCase()}`];
    const limits = [30, 5];
    for (const key of keys) { const item = entries.get(key); if (item && !item.pending && item.until <= time) entries.delete(key); }
    if (keys.some((key) => !entries.has(key)) && entries.size + keys.filter((key) => !entries.has(key)).length > maxEntries) return null;
    const items = keys.map((key) => entries.get(key) || { failures: 0, pending: 0, until: time + windowMs });
    if (items.some((item, i) => item.failures + item.pending >= limits[i])) return null;
    keys.forEach((key, i) => { items[i].pending++; entries.set(key, items[i]); });
    let finished = false;
    return (success) => {
      if (finished) return; finished = true;
      items.forEach((item, i) => {
        item.pending--;
        if (success === false) { item.failures++; if (item.failures === limits[i]) item.until = now() + windowMs; }
        // A successful login clears only its username, not a shared IP bucket.
        else if (success === true && i === 1) item.failures = 0;
        if (!item.pending && item.failures === 0) entries.delete(keys[i]);
      });
    };
  }
  return { reserve };
}
module.exports = { createLoginLimiter };
