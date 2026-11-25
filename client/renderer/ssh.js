'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let conn = null, id = null, generation = 0, terminal = null, fit = null, directory = '.', pending = false, earlyEvents = [], passwordTouched = false;
  function status(text, error = false) { $('sshStatus').textContent = text; $('sshStatus').dataset.kind = error ? 'error' : 'idle'; }
  function close() {
    generation++;
    const old = id; id = null; conn = null; pending = false; earlyEvents = [];
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
  async function showDirectory(target) {
    if (!id || !window.rdpManager?.ssh) return;
    const active = id;
    try {
      const result = await window.rdpManager.ssh.list(active, target);
      if (id !== active) return;
      directory = result.path; $('sftpPath').value = directory;
      const body = $('sftpEntries'); body.replaceChildren();
      const files = result.files.slice().sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      for (const file of files) {
        if (typeof file.name !== 'string' || !file.name || /[\/\x00-\x1f\x7f]/.test(file.name) || file.name === '.' || file.name === '..') continue;
        const row = document.createElement('tr'); const name = document.createElement('td'); const size = document.createElement('td'); const action = document.createElement('td');
        name.textContent = `${file.directory ? '📁' : '📄'} ${file.name}`; size.textContent = file.directory ? '—' : String(file.size);
        const button = document.createElement('button'); button.className = 'btn-ghost'; button.textContent = file.directory ? 'Открыть' : 'Скачать';
        button.addEventListener('click', () => { const remote = `${directory.replace(/\/$/, '')}/${file.name}`; if (file.directory) void showDirectory(remote); else void transfer(remote, 'download'); });
        action.appendChild(button); row.append(name, size, action); body.appendChild(row);
      }
      status('Подключено');
    } catch (error) { if (id === active) status(error.message, true); }
  }
  async function transfer(remote, direction) {
    if (!id) return; const active = id;
    try { const result = await window.rdpManager.ssh.transfer(active, remote, direction); if (id !== active) return; status(result.cancelled ? 'Передача отменена' : 'Передача завершена'); if (result.ok && direction === 'upload') await showDirectory(directory); }
    catch (error) { if (id === active) status(error.message, true); }
  }
  $('sftpGo').addEventListener('click', () => void showDirectory($('sftpPath').value));
  $('sftpUp').addEventListener('click', () => void showDirectory(directory === '/' ? '/' : directory.replace(/\/$/, '').replace(/\/[^/]*$/, '') || '/'));
  $('sftpUpload').addEventListener('click', () => void transfer(directory, 'upload'));
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
      } else { $('sftpPanel').classList.remove('hidden'); void showDirectory('.'); }
    } else if (event.type === 'data') terminal?.write(new Uint8Array(event.bytes));
    else if (event.type === 'progress') status(`Передача: ${event.done} / ${event.total} байт`);
    else if (event.type === 'error' || event.type === 'close') {
      id = null; if (terminal) terminal.dispose(); terminal = null; fit = null;
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
