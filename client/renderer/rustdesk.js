'use strict';
// Experimental direct RustDesk viewer for the desktop client. No passwords are stored.
(function () {
  const $r = (id) => document.getElementById(id);
  let attempt = 0;
  let peerId = '';
  let session = null;
  let viewer = null;
  let credential = null;
  let prompted = false;
  let initialPassword = '';

  function status(text, kind = 'idle') {
    $r('rustdeskStatus').textContent = text;
    $r('rustdeskStatus').dataset.kind = kind;
  }
  function dispose() {
    attempt++;
    credential = null;
    initialPassword = '';
    $r('rustdeskPassword').value = '';
    const oldSession = session;
    const oldViewer = viewer;
    session = null;
    viewer = null;
    if (oldViewer) oldViewer.destroy();
    if (oldSession) oldSession.close();
    $r('rustdeskConnect').disabled = false;
    $r('rustdeskDisconnect').disabled = true;
    $r('rustdeskForm').classList.remove('hidden');
    $r('rustdeskViewer').classList.add('hidden');
  }
  function close() {
    dispose();
    $r('rustdeskOverlay').classList.add('hidden');
    status('Отключено');
  }
  function showCredential(kind, wrong = false) {
    credential = kind;
    prompted = true;
    $r('rustdeskForm').classList.remove('hidden');
    $r('rustdeskViewer').classList.add('hidden');
    $r('rustdeskServer').disabled = true;
    $r('rustdeskKey').disabled = true;
    $r('rustdeskPassword').value = '';
    $r('rustdeskPassword').placeholder = kind === 'twoFactor' ? 'Код двухфакторной проверки' : 'Пароль удалённого устройства';
    $r('rustdeskError').textContent = wrong ? 'Неверные данные, попробуйте снова.' : (kind === 'twoFactor' ? 'Введите код двухфакторной проверки.' : 'Введите пароль удалённого устройства.');
    $r('rustdeskConnect').disabled = false;
    $r('rustdeskConnect').textContent = 'Продолжить';
    $r('rustdeskPassword').focus();
  }
  function resetForm() {
    $r('rustdeskServer').disabled = false;
    $r('rustdeskKey').disabled = false;
    $r('rustdeskConnect').textContent = 'Подключиться';
    $r('rustdeskPassword').placeholder = '';
  }
  window.openEmbeddedRustDesk = (connection) => {
    dispose(); resetForm();
    peerId = String(connection.address || '').replace(/\s+/g, '');
    $r('rustdeskName').textContent = connection.name || 'RustDesk';
    $r('rustdeskPeer').textContent = peerId;
    $r('rustdeskServer').value = localStorage.getItem('rustdesk_server') || '';
    $r('rustdeskKey').value = localStorage.getItem('rustdesk_public_key') || '';
    $r('rustdeskError').textContent = '';
    $r('rustdeskOverlay').classList.remove('hidden');
    status('Не подключено');
    $r('rustdeskServer').focus();
  };
  window.closeEmbeddedRustDesk = close;
  $r('rustdeskClose').addEventListener('click', close);
  $r('rustdeskDisconnect').addEventListener('click', () => { dispose(); resetForm(); status('Отключено'); });
  $r('rustdeskOverlay').addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$r('rustdeskViewer').contains(event.target)) close();
  });
  $r('rustdeskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $r('rustdeskPassword');
    $r('rustdeskError').textContent = '';
    if (credential && session) {
      const active = session;
      const kind = credential;
      const value = input.value;
      input.value = '';
      if (!value) { $r('rustdeskError').textContent = 'Введите данные для подключения.'; return; }
      credential = null;
      $r('rustdeskConnect').disabled = true;
      try {
        if (kind === 'twoFactor') active.submitTwoFactor(value);
        else await active.login(value);
      } catch (error) {
        if (session === active) { showCredential(kind, true); $r('rustdeskError').textContent = error.message; }
      }
      return;
    }
    if (!window.rdpManager || window.location.protocol !== 'file:') {
      $r('rustdeskError').textContent = 'Прямое подключение без WSS доступно только в десктоп-клиенте.';
      return;
    }
    if (!window.RustDeskWeb || !window.RustDeskConfig) {
      $r('rustdeskError').textContent = 'Встроенный RustDesk-клиент не собран.';
      return;
    }
    if (!peerId) { $r('rustdeskError').textContent = 'Не указан ID удалённого устройства.'; return; }
    if (typeof VideoDecoder !== 'function' || typeof EncodedVideoChunk !== 'function') {
      $r('rustdeskError').textContent = 'В этом клиенте недоступен видеодекодер WebCodecs.';
      return;
    }
    let config;
    try { config = window.RustDeskConfig.directRustDeskConfig({ server: $r('rustdeskServer').value, publicKey: $r('rustdeskKey').value }); }
    catch (error) { $r('rustdeskError').textContent = error.message; return; }
    const serverAddress = $r('rustdeskServer').value.trim();
    localStorage.setItem('rustdesk_server', serverAddress);
    localStorage.setItem('rustdesk_public_key', config.publicKey);
    initialPassword = input.value;
    input.value = '';
    prompted = false;
    const generation = ++attempt;
    let current;
    try {
      current = new window.RustDeskWeb.Session({ peerId, server: {
        rendezvousUrl: config.idUrl,
        key: config.publicKey,
        relayUrl: (announced) => announced ? window.RustDeskConfig.directRelayUrl(announced) : config.fallbackRelayUrl,
      } });
      session = current;
      viewer = new window.RustDeskWeb.Viewer($r('rustdeskViewer'), current, { scaleMode: 'fit' });
      viewer.on('clipboardBlocked', ({ text }) => { if (session === current) window.rdpManager.writeClipboard(text).catch((error) => console.warn('RustDesk clipboard:', error)); });
      viewer.on('files', () => { if (session === current) status('Вставка файлов пока не поддерживается', 'error'); });
      current.on('state', ({ state }) => { if (session === current && state !== 'connected' && state !== 'closed') status('Подключение…', 'connecting'); });
      current.on('password', ({ wrong }) => {
        if (session !== current) return;
        if (initialPassword && !wrong && !prompted) {
          const value = initialPassword; initialPassword = ''; prompted = true;
          current.login(value).catch((error) => { if (session === current) { showCredential('password', true); $r('rustdeskError').textContent = error.message; } });
        } else { initialPassword = ''; showCredential('password', wrong); }
      });
      current.on('twoFactor', ({ wrong }) => { if (session === current) showCredential('twoFactor', wrong); });
      current.on('waitingForApproval', () => { if (session === current) status('Ожидание подтверждения', 'connecting'); });
      current.on('connected', () => {
        if (session !== current) return;
        initialPassword = ''; credential = null;
        $r('rustdeskPassword').value = '';
        $r('rustdeskForm').classList.add('hidden');
        $r('rustdeskViewer').classList.remove('hidden');
        $r('rustdeskDisconnect').disabled = false;
        status('Подключено', 'connected');
        $r('rustdeskViewer').querySelector('.rdweb-root')?.focus();
      });
      current.on('close', ({ reason }) => {
        if (session !== current) return;
        dispose(); resetForm();
        $r('rustdeskError').textContent = reason || 'Соединение завершено.';
        status('Отключено', 'error');
      });
      $r('rustdeskConnect').disabled = true;
      $r('rustdeskDisconnect').disabled = false;
      status('Подключение…', 'connecting');
      await current.connect();
    } catch (error) {
      if (generation !== attempt) return;
      dispose(); resetForm();
      $r('rustdeskError').textContent = error.message || 'Ошибка подключения.';
      status('Ошибка подключения', 'error');
    }
  });
})();
