'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let id = null, generation = 0;
  function status(text) { $('webStatus').textContent = text; }
  function rectangle() { const r = $('webSurface').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
  function close() { generation++; const old = id; id = null; $('webOverlay').classList.add('hidden'); if (old) void window.rdpManager?.webApp?.close(old).catch(() => {}); }
  window.closeEmbeddedWeb = close;
  window.openEmbeddedWeb = async (conn, loadSecret) => {
    close(); const revision = ++generation;
    $('webName').textContent = `Веб · ${conn.name}`; $('webOverlay').classList.remove('hidden'); status('Открытие…');
    let password = '';
    if (conn.has_secret) {
      try { password = await loadSecret(); } catch { if (revision === generation) status('Пароль недоступен; войдите вручную.'); }
    }
    if (revision !== generation) return;
    try {
      const result = await window.rdpManager.webApp.open({ url: conn.address, username: conn.username || '', password: password || '', bounds: rectangle() });
      if (revision !== generation) { await window.rdpManager.webApp.close(result.id); return; }
      id = result.id;
    } catch (error) { if (revision === generation) status(error.message); }
  };
  $('webClose').addEventListener('click', close);
  $('webBack').addEventListener('click', () => { if (id) void window.rdpManager.webApp.action(id, 'back'); });
  $('webReload').addEventListener('click', () => { if (id) void window.rdpManager.webApp.action(id, 'reload'); });
  window.addEventListener('resize', () => { if (id) void window.rdpManager.webApp.bounds(id, rectangle()); });
  window.rdpManager?.webApp?.onEvent((event) => { if (event.id === id) status((event.origin ? event.origin + ' · ' : '') + event.message); });
})();
