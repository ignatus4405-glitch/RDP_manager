'use strict';
// Experimental direct RustDesk viewer for the desktop client.
(function () {
  const $r = (id) => document.getElementById(id);
  let attempt = 0;
  let peerId = '';
  let serverAddress = '';
  let publicKey = '';
  let session = null;
  let viewer = null;
  let credential = null;
  let prompted = false;
  let initialPassword = '', savedPasswordCandidate = '', credentialScope = null, inputRevision = 0;
  let clipboardSync = null;
  let fileClipboard = null;

  function status(text, kind = 'idle') {
    $r('rustdeskStatus').textContent = text;
    $r('rustdeskStatus').dataset.kind = kind;
  }
  function dispose() {
    attempt++;
    credential = null;
    initialPassword = ''; savedPasswordCandidate = ''; inputRevision++;
    $r('rustdeskPassword').value = '';
    clipboardSync?.stop();
    clipboardSync = null;
    fileClipboard?.stop();
    fileClipboard = null;
    $r('rustdeskDisplay').replaceChildren();
    $r('rustdeskDisplay').classList.add('hidden');
    $r('rustdeskDisplayLabel').classList.add('hidden');
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
  function updateDisplays(peer) {
    const select = $r('rustdeskDisplay');
    const displays = Array.isArray(peer?.displays) ? peer.displays : [];
    select.replaceChildren();
    displays.forEach((display, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `Монитор ${index + 1}${display.name ? ` · ${display.name}` : ''}`;
      option.disabled = display.online === false;
      select.appendChild(option);
    });
    select.value = String(peer?.currentDisplay ?? 0);
    select.classList.toggle('hidden', displays.length < 2);
    $r('rustdeskDisplayLabel').classList.toggle('hidden', displays.length < 2);
  }
  $r('rustdeskDisplay').addEventListener('change', (event) => {
    const index = Number(event.target.value);
    if (!session || !Number.isInteger(index) || index < 0 || index >= (session.peer?.displays?.length ?? 0)) return;
    session.switchDisplay(index);
    $r('rustdeskViewer').querySelector('.rdweb-root')?.focus();
  });
  function close() {
    dispose();
    $r('rustdeskOverlay').classList.add('hidden');
    status('Отключено');
  }
  function showCredential(kind, wrong = false) {
    credential = kind;
    prompted = true;
    if (kind === 'password' && wrong) savedPasswordCandidate = '';
    $r('rustdeskForm').classList.remove('hidden');
    $r('rustdeskViewer').classList.add('hidden');
    $r('rustdeskPassword').value = '';
    $r('rustdeskPassword').placeholder = kind === 'twoFactor' ? 'Код двухфакторной проверки' : 'Пароль удалённого устройства';
    $r('rustdeskError').textContent = wrong ? 'Неверные данные, попробуйте снова.' : (kind === 'twoFactor' ? 'Введите код двухфакторной проверки.' : 'Введите пароль удалённого устройства.');
    $r('rustdeskConnect').disabled = false;
    $r('rustdeskConnect').textContent = 'Продолжить';
    $r('rustdeskPassword').focus();
  }
  function resetForm() {
    $r('rustdeskConnect').textContent = 'Подключиться';
    $r('rustdeskPassword').placeholder = '';
  }
  window.openEmbeddedRustDesk = (connection) => {
    dispose(); resetForm();
    peerId = String(connection.address || '').replace(/\s+/g, '');
    $r('rustdeskName').textContent = connection.name || 'RustDesk';
    $r('rustdeskPeer').textContent = peerId;
    const hasSavedConfig = Boolean(connection.rustdesk_server || connection.rustdesk_key);
    serverAddress = hasSavedConfig ? (connection.rustdesk_server || '') : (localStorage.getItem('rustdesk_server') || '');
    publicKey = hasSavedConfig ? (connection.rustdesk_key || '') : (localStorage.getItem('rustdesk_public_key') || '');
    $r('rustdeskError').textContent = '';
    $r('rustdeskOverlay').classList.remove('hidden');
    status('Не подключено');
    $r('rustdeskPassword').focus();
    credentialScope = window.personalCredentialScope?.(connection) || null;
    $r('rustdeskRemember').disabled = !credentialScope; $r('rustdeskForget').disabled = !credentialScope; $r('rustdeskRemember').checked = Boolean(credentialScope);
    const revision = inputRevision, scope = credentialScope;
    if (scope) void window.rdpManager.localCredentials.get(scope).then((saved) => { if (scope === credentialScope && revision === inputRevision && !$r('rustdeskOverlay').classList.contains('hidden') && typeof saved?.password === 'string') $r('rustdeskPassword').value = saved.password; }).catch((error) => { if (scope === credentialScope && revision === inputRevision) $r('rustdeskError').textContent = `Локальный пароль недоступен: ${error.message}`; });
  };
  $r('rustdeskPassword').addEventListener('input', () => { inputRevision++; });
  $r('rustdeskForget').addEventListener('click', async () => { const scope = credentialScope; if (!scope) return; const revision = ++inputRevision; try { await window.rdpManager.localCredentials.remove(scope); if (scope === credentialScope && revision === inputRevision) { $r('rustdeskPassword').value = ''; $r('rustdeskRemember').checked = false; $r('rustdeskError').textContent = 'Локальный пароль удалён.'; } } catch (error) { $r('rustdeskError').textContent = error.message; } });
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
      if (kind === 'password') savedPasswordCandidate = value;
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
    try { config = window.RustDeskConfig.directRustDeskConfig({ server: serverAddress, publicKey }); }
    catch (error) { $r('rustdeskError').textContent = `Настройте сервер ID и публичный ключ в карточке подключения. ${error.message}`; return; }
    initialPassword = input.value; savedPasswordCandidate = initialPassword;
    inputRevision++; input.value = '';
    prompted = false;
    const generation = ++attempt;
    let current;
    try {
      const bridge = window.rdpManager.fileTransfer;
      const fileClipboardAvailable = Boolean(await bridge?.virtualAvailable?.());
      if (generation !== attempt) return;
      current = new window.RustDeskWeb.Session({ peerId, fileClipboard: fileClipboardAvailable, server: {
        rendezvousUrl: config.idUrl,
        key: config.publicKey,
        relayUrl: (announced) => announced ? window.RustDeskConfig.directRelayUrl(announced) : config.fallbackRelayUrl,
      } });
      session = current;
      viewer = new window.RustDeskWeb.Viewer($r('rustdeskViewer'), current, { scaleMode: 'fit', handleRemoteClipboard: false, ...(fileClipboardAvailable ? { prepareFilePaste: () => fileClipboard?.preparePaste() ?? Promise.resolve(false) } : {}) });
      clipboardSync = window.createRustDeskClipboardSync({
        read: () => window.rdpManager.fileTransfer.readTextOnly(),
        write: (text) => window.rdpManager.writeClipboard(text),
        send: (text) => current.sendClipboard(text),
        canSend: () => session === current && current.canControl && current.permission.clipboard && !fileClipboard?.isReceiving(),
        onError: (error) => console.warn('RustDesk clipboard:', error),
      });
      if (fileClipboardAvailable) {
        fileClipboard = window.createRustDeskFileClipboard({
          protocol: window.RustDeskFileProtocol, bridge,
          send: (data) => current.sendFileClipboard(data),
          onRemoteOffer: () => clipboardSync?.invalidate(),
          canSend: () => session === current && current.canControl && current.permission.clipboard && current.permission.file,
          onError: (error) => console.warn('RustDesk file clipboard:', error),
        });
        current.on('fileClipboard', ({ data }) => { if (session === current) fileClipboard?.receive(data); });
      }
      current.on('clipboard', ({ text }) => { if (session === current && current.permission.clipboard) { fileClipboard?.invalidateRemote(); clipboardSync?.remote(text); } });
      current.on('peer', ({ peer }) => { if (session === current) updateDisplays(peer); });
      current.on('display', () => { if (session === current) updateDisplays(current.peer); });
      current.on('permission', ({ name, enabled }) => {
        if (session !== current) return;
        if ((name === 'clipboard' || name === 'file' || name === 'keyboard') && !enabled) fileClipboard?.suspend();
        if (enabled && name === 'clipboard') void clipboardSync?.poll();
        if (enabled && (name === 'clipboard' || name === 'file' || name === 'keyboard')) void fileClipboard?.poll();
      });
      viewer.on('files', () => { if (session === current && !fileClipboardAvailable) status('Вставка файлов доступна только в Windows с OLE-буфером', 'error'); });
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
        const scope = credentialScope, password = savedPasswordCandidate; savedPasswordCandidate = '';
        if (scope && (password || !$r('rustdeskRemember').checked)) {
          const save = $r('rustdeskRemember').checked ? window.rdpManager.localCredentials.put(scope, { username: '', domain: '', password }) : window.rdpManager.localCredentials.remove(scope);
          void save.catch((error) => { if (session === current) status(`Не удалось сохранить пароль: ${error.message}`, 'error'); });
        }
        $r('rustdeskPassword').value = '';
        $r('rustdeskForm').classList.add('hidden');
        $r('rustdeskViewer').classList.remove('hidden');
        $r('rustdeskDisconnect').disabled = false;
        updateDisplays(current.peer);
        clipboardSync?.start();
        fileClipboard?.start();
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
