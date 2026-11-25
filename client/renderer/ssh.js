'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let conn = null, id = null, generation = 0, terminal = null, fit = null, directory = '.', localDirectory = null, localParent = null, pending = false, earlyEvents = [], passwordTouched = false;
  let localSelection = null, remoteSelection = null, transferring = false, localRequest = 0, remoteRequest = 0;
  function status(text, error = false) { $('sshStatus').textContent = text; $('sshStatus').dataset.kind = error ? 'error' : 'idle'; }
  function close() {
    generation++;
    const old = id; id = null; conn = null; pending = false; earlyEvents = []; localRequest++; remoteRequest++; transferring = false; localDirectory = null; localParent = null; directory = '.'; localSelection = remoteSelection = null; updateActions();
    if (old) void window.rdpManager?.ssh?.close(old).catch(() => {});
    if (terminal) terminal.dispose(); terminal = null; fit = null;
    $('sshPassword').value = ''; $('sshOverlay').classList.add('hidden');
  }
  window.closeEmbeddedSsh = close;
  window.openEmbeddedSsh = (connection, loadSecret) => {
    close(); const revision = ++generation; conn = connection;
    $('sshName').textContent = `${connection.type === 'ssh' ? 'SSH' : 'SFTP'} · ${connection.name}`;
    $('sshUsername').value = connection.username || ''; $('sshPassword').value = ''; passwordTouched = false;
    $('sshError').textContent = ''; $('sshConnect').disabled = false; $('sshForm').classList.remove('hidden'); $('sshTerminal').classList.add('hidden'); $('sftpPanel').classList.add('hidden');
    $('sshOverlay').classList.remove('hidden'); status('Не подключено'); $('sshPassword').focus();
    if (connection.has_secret && loadSecret) loadSecret().then((password) => {
      if (generation === revision && conn === connection && !passwordTouched && typeof password === 'string') $('sshPassword').value = password;
    }).catch(() => { if (generation === revision) $('sshError').textContent = 'Не удалось получить сохранённый пароль. Введите его вручную.'; });
  };
  $('sshClose').addEventListener('click', close);
  $('sshDisconnect').addEventListener('click', close);
  $('sshPassword').addEventListener('input', () => { passwordTouched = true; });
  function updateActions() {
    $('sftpUpload').disabled = transferring || !id || !localDirectory || !directory.startsWith('/') || !localSelection?.file;
    $('sftpDownload').disabled = transferring || !id || !localDirectory || !directory.startsWith('/') || !remoteSelection?.file;
  }
  function message(text, error = false) { $('sftpMessage').textContent = text; status(text, error); }
  function formatSize(value) {
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} Б`;
    const units = ['КБ', 'МБ', 'ГБ', 'ТБ']; let size = value / 1024, unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
    return `${size.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${units[unit]}`;
  }
  function renderFiles(side, files) {
    const local = side === 'local';
    const body = $(local ? 'sftpLocalEntries' : 'sftpEntries'); body.replaceChildren();
    const entries = files.filter((file) => typeof file.name === 'string' && file.name && !/[\\/\x00-\x1f\x7f]/.test(file.name) && file.name !== '.' && file.name !== '..').sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'ru', { numeric: true }));
    $(local ? 'sftpLocalEmpty' : 'sftpRemoteEmpty').classList.toggle('hidden', entries.length !== 0);
    $(local ? 'sftpLocalSummary' : 'sftpRemoteSummary').textContent = `${entries.length} объектов · двойной щелчок для открытия папки`;
    for (const file of entries) {
      const row = document.createElement('tr'); row.tabIndex = 0;
      const name = document.createElement('td'), size = document.createElement('td'), modified = document.createElement('td');
      const icon = document.createElement('span'); icon.className = 'sftp-entry-icon'; icon.textContent = file.directory ? '📁' : file.file ? '📄' : '↗';
      name.append(icon, document.createTextNode(file.name)); name.title = file.name;
      size.textContent = file.directory ? '—' : formatSize(file.size);
      const date = new Date(Number(file.modified) * 1000); modified.textContent = file.modified && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—';
      row.append(name, size, modified);
      const select = () => { for (const item of body.children) item.classList.remove('selected'); row.classList.add('selected'); if (local) localSelection = file; else remoteSelection = file; updateActions(); };
      const enter = () => { if ((!file.directory && !file.link) || transferring) return; if (local) void showLocal(`${localDirectory}${localDirectory.endsWith('\\') || localDirectory.endsWith('/') ? '' : (localDirectory.includes('\\') ? '\\' : '/')}${file.name}`); else void showDirectory(`${directory.replace(/\/$/, '')}/${file.name}`); };
      row.addEventListener('click', select); row.addEventListener('dblclick', enter);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); enter(); } else if (event.key === ' ') { event.preventDefault(); select(); } });
      body.appendChild(row);
    }
  }
  async function showDirectory(target) {
    if (!id || transferring) return;
    const active = id, request = ++remoteRequest;
    try {
      const result = await window.rdpManager.ssh.list(active, target);
      if (id !== active || request !== remoteRequest) return;
      directory = result.path; $('sftpPath').value = directory; remoteSelection = null; renderFiles('remote', result.files); updateActions();
    } catch (error) { if (id === active && request === remoteRequest) message(`Сервер: ${error.message}`, true); }
  }
  async function showLocal(target) {
    if (!id || transferring) return;
    const active = id, request = ++localRequest;
    try {
      const result = await window.rdpManager.ssh.localList(active, target);
      if (id !== active || request !== localRequest) return;
      localDirectory = result.path; localParent = result.parent; $('sftpLocalPath').value = localDirectory; localSelection = null; renderFiles('local', result.files); updateActions();
    } catch (error) { if (id === active && request === localRequest) message(`Компьютер: ${error.message}`, true); }
  }
  async function transfer(direction) {
    const selected = direction === 'upload' ? localSelection : remoteSelection;
    if (!id || transferring || !selected?.file || !localDirectory || !directory.startsWith('/')) return;
    const active = id, local = localDirectory, remote = directory; transferring = true; updateActions();
    $('sftpProgress').classList.remove('hidden'); $('sftpProgress').value = 0; message(`Передача: ${selected.name}`);
    try {
      const result = await window.rdpManager.ssh.transferBetween(active, local, remote, selected.name, direction);
      if (id !== active) return;
      message(result.cancelled ? 'Передача отменена' : `Передача завершена: ${selected.name}`);
      transferring = false; updateActions();
      if (result.ok) await (direction === 'upload' ? showDirectory(remote) : showLocal(local));
    } catch (error) { if (id === active) message(`Ошибка передачи: ${error.message}`, true); }
    finally { if (id === active) { transferring = false; updateActions(); $('sftpProgress').classList.add('hidden'); } }
  }
  $('sftpGo').addEventListener('click', () => void showDirectory($('sftpPath').value));
  $('sftpPath').addEventListener('keydown', (event) => { if (event.key === 'Enter') void showDirectory($('sftpPath').value); });
  $('sftpUp').addEventListener('click', () => void showDirectory(directory === '/' ? '/' : directory.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/'));
  $('sftpRefresh').addEventListener('click', () => void showDirectory(directory));
  $('sftpLocalGo').addEventListener('click', () => void showLocal($('sftpLocalPath').value));
  $('sftpLocalPath').addEventListener('keydown', (event) => { if (event.key === 'Enter') void showLocal($('sftpLocalPath').value); });
  $('sftpLocalUp').addEventListener('click', () => { if (localParent) void showLocal(localParent); });
  $('sftpLocalRefresh').addEventListener('click', () => { if (localDirectory) void showLocal(localDirectory); });
  $('sftpUpload').addEventListener('click', () => void transfer('upload'));
  $('sftpDownload').addEventListener('click', () => void transfer('download'));
  function onEvent(event) {
    if (pending && !id) { earlyEvents.push(event); return; }
    if (!id || event.id !== id) return;
    if (event.type === 'ready') {
      $('sshForm').classList.add('hidden'); $('sshPassword').value = ''; status('Подключено');
      if (conn.type === 'ssh') {
        if (!window.SshTerminal) { status('Терминал не собран.', true); return; }
        $('sshTerminal').classList.remove('hidden'); terminal = new window.SshTerminal.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000 });
        fit = new window.SshTerminal.FitAddon(); terminal.loadAddon(fit); terminal.open($('sshTerminal')); fit.fit();
        terminal.onData((data) => { if (id) void window.rdpManager.ssh.write(id, data).catch((error) => status(error.message, true)); });
        void window.rdpManager.ssh.resize(id, terminal.cols, terminal.rows).catch(() => {}); terminal.focus();
      } else { $('sftpPanel').classList.remove('hidden'); $('sftpRemoteHost').textContent = `${conn.address}:${conn.port || 22}`; $('sftpProgress').classList.add('hidden'); message('Подключено'); void showLocal(null); void showDirectory('.'); }
    } else if (event.type === 'data') terminal?.write(new Uint8Array(event.bytes));
    else if (event.type === 'progress') { const text = `Передача: ${formatSize(event.done)} / ${formatSize(event.total)}`; message(text); $('sftpProgress').value = event.total > 0 ? Math.min(100, event.done / event.total * 100) : 0; }
    else if (event.type === 'error' || event.type === 'close') {
      id = null; transferring = false; updateActions(); if (terminal) terminal.dispose(); terminal = null; fit = null;
      $('sshTerminal').classList.add('hidden'); $('sftpPanel').classList.add('hidden'); $('sshForm').classList.remove('hidden'); $('sshConnect').disabled = false;
      const message = event.type === 'error' ? event.message : 'Соединение закрыто'; $('sshError').textContent = message; status(message, event.type === 'error');
    }
  }
  window.rdpManager?.ssh?.onEvent(onEvent);
  window.addEventListener('resize', () => { if (!terminal || !fit || !id) return; fit.fit(); void window.rdpManager.ssh.resize(id, terminal.cols, terminal.rows).catch(() => {}); });
  $('sshForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!conn || !window.rdpManager?.ssh) { $('sshError').textContent = 'SSH/SFTP доступен только в десктоп-клиенте.'; return; }
    const revision = ++generation; $('sshError').textContent = ''; $('sshConnect').disabled = true; status('Подключение…');
    const selected = conn; const options = { host: conn.address, port: conn.port || 22, username: $('sshUsername').value.trim(), password: $('sshPassword').value, mode: conn.type };
    pending = true; earlyEvents = [];
    try {
      const result = await window.rdpManager.ssh.open(options);
      if (generation !== revision || conn !== selected) { await window.rdpManager.ssh.close(result.id); return; }
      id = result.id; pending = false; const events = earlyEvents; earlyEvents = []; for (const item of events) onEvent(item);
    } catch (error) { pending = false; if (generation === revision) { $('sshError').textContent = error.message; status('Ошибка подключения', true); $('sshConnect').disabled = false; } }
  });
})();
