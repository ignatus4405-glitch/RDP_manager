'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  let conn = null, id = null, generation = 0, terminal = null, fit = null, directory = '.', localDirectory = null, localParent = null, pending = false, earlyEvents = [], passwordTouched = false;
  let localSelection = null, remoteSelection = null, transferring = false, localRequest = 0, remoteRequest = 0;
  let folderTarget = null, activeSide = 'remote', editState = null, editGeneration = 0, propertiesState = null, propertiesGeneration = 0, operationState = null;
  function status(text, error = false) { $('sshStatus').textContent = text; $('sshStatus').dataset.kind = error ? 'error' : 'idle'; }
  function close() {
    generation++; hideContextMenu(); forceCloseEditor(); forceCloseProperties(); if ($('sftpOperationDialog').open) $('sftpOperationDialog').close(); operationState = null; if ($('sftpNewFolderDialog').open) $('sftpNewFolderDialog').close(); folderTarget = null;
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
  $('sshClose').addEventListener('click', () => { if (canCloseEditor()) close(); });
  $('sshDisconnect').addEventListener('click', () => { if (canCloseEditor()) close(); });
  $('sshPassword').addEventListener('input', () => { passwordTouched = true; });
  function updateActions() {
    $('sftpUpload').disabled = transferring || !id || !localDirectory || !directory.startsWith('/') || !localSelection?.file;
    $('sftpDownload').disabled = transferring || !id || !localDirectory || !directory.startsWith('/') || !remoteSelection?.file;
    $('sftpProperties').disabled = transferring || !id || !(activeSide === 'local' ? localSelection : remoteSelection);
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
      const enter = () => { if (transferring) return; if (file.file) { void openEditor(side, file); return; } if (!file.directory && !file.link) return; if (local) void showLocal(`${localDirectory}${localDirectory.endsWith('\\') || localDirectory.endsWith('/') ? '' : (localDirectory.includes('\\') ? '\\' : '/')}${file.name}`); else void showDirectory(`${directory.replace(/\/$/, '')}/${file.name}`); };
      row.addEventListener('click', () => { activeSide = side; select(); }); row.addEventListener('dblclick', enter);
      row.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); activeSide = side; select(); showContextMenu(event.clientX, event.clientY, side, file, enter); });
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); enter(); } else if (event.key === ' ') { event.preventDefault(); select(); } });
      body.appendChild(row);
    }
  }
  async function showDirectory(target) {
    if (!id || transferring) return; hideContextMenu();
    const active = id, request = ++remoteRequest;
    try {
      const result = await window.rdpManager.ssh.list(active, target);
      if (id !== active || request !== remoteRequest) return;
      directory = result.path; $('sftpPath').value = directory; remoteSelection = null; renderFiles('remote', result.files); updateActions();
    } catch (error) { if (id === active && request === remoteRequest) message(`Сервер: ${error.message}`, true); }
  }
  async function showLocal(target) {
    if (!id || transferring) return; hideContextMenu();
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
  function hideContextMenu() { $('sftpContextMenu').classList.add('hidden'); }
  function localJoin(parent, name) { return parent + (parent.endsWith('\\') || parent.endsWith('/') ? '' : (parent.includes('\\') ? '\\' : '/')) + name; }
  function currentPath(side) { return side === 'local' ? localDirectory : directory; }
  function selectedPath(side, file) {
    const parent = currentPath(side);
    return !file ? parent : side === 'local' ? localJoin(parent, file.name) : `${parent.replace(/\/$/, '')}/${file.name}`;
  }
  function showContextMenu(x, y, side, file = null, enter = null) {
    if (!id || !currentPath(side) || (side === 'remote' && !directory.startsWith('/'))) return;
    const menu = $('sftpContextMenu'); menu.replaceChildren();
    const add = (icon, label, shortcut, handler, disabled = false) => {
      const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.disabled = disabled;
      for (const [cls, value] of [['sftp-menu-icon', icon], ['sftp-menu-label', label], ['sftp-menu-key', shortcut]]) { const span = document.createElement('span'); span.className = cls; span.textContent = value; button.appendChild(span); }
      button.addEventListener('click', () => { hideContextMenu(); handler(); }); menu.appendChild(button);
    };
    const separator = () => menu.appendChild(document.createElement('hr'));
    if (file) add('↗', 'Открыть', 'Enter', () => enter?.(), transferring);
    if (file?.file) add('✎', 'Изменить файл', 'F4', () => void openEditor(side, file), transferring);
    if (file?.file) add(side === 'local' ? '→' : '←', side === 'local' ? 'Отправить на сервер' : 'Получить на компьютер', 'F5', () => void transfer(side === 'local' ? 'upload' : 'download'), transferring || !localDirectory || !directory.startsWith('/'));
    if (file) {
      add('⧉', 'Дублировать…', 'Shift+F5', () => openOperationDialog(side, file, 'duplicate'), transferring || !(file.file || (side === 'remote' && file.directory)));
      add('⇥', 'Перенести…', 'Shift+F6', () => openOperationDialog(side, file, 'move'), transferring);
      add('✕', 'Удалить', 'F8', () => void runOperation(side, file, 'delete'), transferring);
      add('✎', 'Переименовать…', 'F2', () => openOperationDialog(side, file, 'rename'), transferring);
      add('▣', 'Скопировать в буфер обмена', 'Ctrl+C', () => void runOperation(side, file, 'clipboard'), transferring || (side === 'remote' && !(file.file || file.directory)));
      const names = document.createElement('div'); names.className = 'sftp-submenu-wrap';
      const namesTrigger = document.createElement('button'); namesTrigger.type = 'button'; namesTrigger.setAttribute('role', 'menuitem'); namesTrigger.setAttribute('aria-haspopup', 'menu'); namesTrigger.setAttribute('aria-expanded', 'false');
      for (const [cls, value] of [['sftp-menu-icon', '▤'], ['sftp-menu-label', 'Имена файлов'], ['sftp-menu-key', '▶']]) { const span = document.createElement('span'); span.className = cls; span.textContent = value; namesTrigger.appendChild(span); }
      const namesMenu = document.createElement('div'); namesMenu.className = 'sftp-submenu hidden'; namesMenu.setAttribute('role', 'menu');
      const showNames = () => { namesMenu.classList.remove('hidden'); namesTrigger.setAttribute('aria-expanded', 'true'); };
      const hideNames = () => { namesMenu.classList.add('hidden'); namesTrigger.setAttribute('aria-expanded', 'false'); };
      const dot = file.name.lastIndexOf('.');
      for (const [title, value] of [['Скопировать имя', file.name], ['Скопировать путь', selectedPath(side, file)], ['Имя без расширения', dot > 0 ? file.name.slice(0, dot) : file.name]]) {
        const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem');
        for (const [cls, text] of [['sftp-menu-icon', '▤'], ['sftp-menu-label', title], ['sftp-menu-key', '']]) { const span = document.createElement('span'); span.className = cls; span.textContent = text; item.appendChild(span); }
        item.addEventListener('click', () => { hideContextMenu(); void window.rdpManager.writeClipboard(value).then(() => message('Скопировано в буфер обмена')).catch((error) => message(error.message, true)); }); namesMenu.appendChild(item);
      }
      namesTrigger.addEventListener('click', () => { if (namesMenu.classList.contains('hidden')) showNames(); else hideNames(); });
      namesTrigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') { event.preventDefault(); showNames(); namesMenu.querySelector('button:not(:disabled)')?.focus(); } });
      namesMenu.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); hideNames(); namesTrigger.focus(); } });
      names.addEventListener('mouseenter', showNames); names.addEventListener('mouseleave', hideNames); names.append(namesTrigger, namesMenu); menu.appendChild(names);

      add('ⓘ', 'Свойства', 'F9', () => void openProperties(side, file), transferring); separator();
    }
    add('↑', 'На уровень вверх', '', () => side === 'local' ? void showLocal(localParent) : $('sftpUp').click(), transferring || (side === 'local' && !localParent));
    add('↻', 'Обновить', 'Ctrl+R', () => side === 'local' ? void showLocal(localDirectory) : void showDirectory(directory), transferring);
    add('▤', file ? 'Скопировать путь объекта' : 'Скопировать путь', '', () => {
      const value = selectedPath(side, file);
      void window.rdpManager.writeClipboard(value).then(() => message('Путь скопирован в буфер обмена')).catch((error) => message(error.message, true));
    });
    separator();
    const group = document.createElement('div'); group.className = 'sftp-submenu-wrap';
    const trigger = document.createElement('button'); trigger.type = 'button'; trigger.disabled = transferring; trigger.setAttribute('role', 'menuitem'); trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false');
    for (const [cls, value] of [['sftp-menu-icon', '＋'], ['sftp-menu-label', 'Новый'], ['sftp-menu-key', '▶']]) { const span = document.createElement('span'); span.className = cls; span.textContent = value; trigger.appendChild(span); }
    const submenu = document.createElement('div'); submenu.className = 'sftp-submenu hidden'; submenu.setAttribute('role', 'menu');
    const showSubmenu = () => { if (!trigger.disabled) { submenu.classList.remove('hidden'); trigger.setAttribute('aria-expanded', 'true'); } };
    const hideSubmenu = () => { submenu.classList.add('hidden'); trigger.setAttribute('aria-expanded', 'false'); };
    for (const [kind, icon, title, key] of [['file', '📄', 'Файл…', 'Shift+F4'], ['directory', '📁', 'Каталог…', 'F7'], ['link', '↗', 'Ярлык…', '']]) {
      const item = document.createElement('button'); item.type = 'button'; item.setAttribute('role', 'menuitem'); item.disabled = kind === 'link' && side !== 'remote';
      if (item.disabled) item.title = 'Символические ссылки можно создавать только на сервере SFTP.';
      for (const [cls, value] of [['sftp-menu-icon', icon], ['sftp-menu-label', title], ['sftp-menu-key', key]]) { const span = document.createElement('span'); span.className = cls; span.textContent = value; item.appendChild(span); }
      item.addEventListener('click', () => { hideContextMenu(); openCreateDialog(side, kind); }); submenu.appendChild(item);
    }
    trigger.addEventListener('click', () => { if (submenu.classList.contains('hidden')) showSubmenu(); else hideSubmenu(); });
    trigger.addEventListener('keydown', (event) => { if (event.key === 'ArrowRight') { event.preventDefault(); showSubmenu(); submenu.querySelector('button:not(:disabled)')?.focus(); } });
    submenu.addEventListener('keydown', (event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); hideSubmenu(); trigger.focus(); } });
    group.addEventListener('mouseenter', showSubmenu); group.addEventListener('mouseleave', hideSubmenu); group.append(trigger, submenu); menu.appendChild(group);
    if (side === 'remote') add('▣', 'Вставить файлы из буфера', 'Ctrl+V', () => void pasteClipboardFiles(), transferring);
    menu.classList.remove('hidden');
    menu.style.left = '0px'; menu.style.top = '0px';
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;
    for (const wrapper of menu.children) if (wrapper.classList.contains('sftp-submenu-wrap')) wrapper.classList.toggle('opens-left', parseFloat(menu.style.left) + rect.width + 240 > window.innerWidth);
    menu.querySelector('button:not(:disabled)')?.focus();
  }
  for (const [element, side] of [['sftpLocalList', 'local'], ['sftpRemoteList', 'remote']]) {
    const list = $(element);
    list.addEventListener('focusin', () => { activeSide = side; updateActions(); });
    list.addEventListener('contextmenu', (event) => { event.preventDefault(); activeSide = side; showContextMenu(event.clientX, event.clientY, side); });
    list.addEventListener('scroll', hideContextMenu);
  }
  document.addEventListener('pointerdown', (event) => { if (!$('sftpContextMenu').contains(event.target)) hideContextMenu(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { hideContextMenu(); return; }
    if ($('sftpPanel').classList.contains('hidden') || $('sftpNewFolderDialog').open || $('sftpPropertiesDialog').open || $('sftpEditorDialog').open || $('sftpOperationDialog').open || event.target.matches('input, textarea, [contenteditable="true"]')) return;
    const selected = activeSide === 'local' ? localSelection : remoteSelection;
    if (selected && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F2') { event.preventDefault(); hideContextMenu(); openOperationDialog(activeSide, selected, 'rename'); return; }
    if (selected && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F8') { event.preventDefault(); hideContextMenu(); void runOperation(activeSide, selected, 'delete'); return; }
    if (selected && !event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && event.key === 'F5') { event.preventDefault(); hideContextMenu(); if (selected.file || (activeSide === 'remote' && selected.directory)) openOperationDialog(activeSide, selected, 'duplicate'); return; }
    if (selected && !event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && event.key === 'F6') { event.preventDefault(); hideContextMenu(); openOperationDialog(activeSide, selected, 'move'); return; }
    if (selected?.file && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F5') { event.preventDefault(); hideContextMenu(); void transfer(activeSide === 'local' ? 'upload' : 'download'); return; }
    if (selected && event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'c' && (activeSide === 'local' || selected.file || selected.directory)) { event.preventDefault(); hideContextMenu(); void runOperation(activeSide, selected, 'clipboard'); return; }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F9') { const file = activeSide === 'local' ? localSelection : remoteSelection; if (file) { event.preventDefault(); hideContextMenu(); void openProperties(activeSide, file); } return; }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F4') { const file = activeSide === 'local' ? localSelection : remoteSelection; if (file?.file) { event.preventDefault(); hideContextMenu(); void openEditor(activeSide, file); } return; }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key === 'F7') { event.preventDefault(); hideContextMenu(); openCreateDialog(activeSide, 'directory'); return; }
    if (!event.ctrlKey && !event.altKey && !event.metaKey && event.shiftKey && event.key === 'F4') { event.preventDefault(); hideContextMenu(); openCreateDialog(activeSide, 'file'); return; }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'r') { event.preventDefault(); hideContextMenu(); if (activeSide === 'local') void showLocal(localDirectory); else void showDirectory(directory); }
    if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'v' && activeSide === 'remote') { event.preventDefault(); hideContextMenu(); void pasteClipboardFiles(); }
  });
  function openOperationDialog(side, file, action) {
    if (!id || transferring || !currentPath(side) || !file || !['rename', 'move', 'duplicate'].includes(action) || (action === 'duplicate' && !(file.file || (side === 'remote' && file.directory)))) return;
    operationState = { id, side, directory: currentPath(side), file, action };
    $('sftpOperationTitle').textContent = action === 'rename' ? 'Переименовать' : action === 'move' ? 'Перенести' : 'Дублировать';
    $('sftpOperationLocation').textContent = selectedPath(side, file);
    $('sftpOperationLabel').textContent = action === 'move' ? 'Абсолютный путь каталога назначения' : 'Новое имя';
    $('sftpOperationValue').value = action === 'move' ? currentPath(side) : action === 'duplicate' ? `${file.name}.copy` : file.name;
    $('sftpOperationHint').textContent = action === 'move' ? 'Перемещение выполняется в пределах той же панели. При совпадении имени операция отклоняется; параллельные изменения могут создать конфликт.' : 'При совпадении имени операция отклоняется; параллельные изменения могут создать конфликт.';
    $('sftpOperationError').textContent = ''; $('sftpOperationSubmit').disabled = false; $('sftpOperationDialog').showModal(); $('sftpOperationValue').focus();
  }
  $('sftpOperationCancel').addEventListener('click', () => { if (!transferring) $('sftpOperationDialog').close(); });
  $('sftpOperationDialog').addEventListener('cancel', (event) => { if (transferring) event.preventDefault(); });
  $('sftpOperationDialog').addEventListener('close', () => { operationState = null; });
  $('sftpOperationForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const op = operationState; if (!op || transferring || op.id !== id) return;
    $('sftpOperationSubmit').disabled = true; $('sftpOperationError').textContent = '';
    await runOperation(op.side, op.file, op.action, $('sftpOperationValue').value, op);
  });
  async function runOperation(side, file, action, value, dialogState = null) {
    if (!id || transferring || !file || !currentPath(side)) return;
    const active = id, dir = currentPath(side); transferring = true; updateActions();
    if (action === 'clipboard' && side === 'remote') { $('sftpProgress').classList.remove('hidden'); $('sftpProgress').value = 0; message('Скачивание временной копии для буфера (прогресс текущего файла)…'); }
    else message('Выполнение операции…');
    try {
      const result = await window.rdpManager.ssh.operate(active, side, dir, file.name, action, value);
      if (id !== active) return;
      if (dialogState && operationState === dialogState) $('sftpOperationDialog').close();
      transferring = false; updateActions();
      message(result.cancelled ? 'Операция отменена' : action === 'clipboard' ? (result.staged ? 'Файл скопирован в буфер как временная копия до выхода из приложения' : 'Файл скопирован в системный буфер') : 'Операция выполнена');
      if (result.ok && action !== 'clipboard' && currentPath(side) === dir) await (side === 'local' ? showLocal(dir) : showDirectory(dir));
    } catch (error) {
      if (id === active) { if (dialogState && operationState === dialogState) $('sftpOperationError').textContent = error.message; message(`Ошибка: ${error.message}`, true); }
    } finally { if (id === active) { transferring = false; updateActions(); $('sftpProgress').classList.add('hidden'); if (dialogState && operationState === dialogState) $('sftpOperationSubmit').disabled = false; } }
  }
  function openCreateDialog(side, kind) {
    if (!id || transferring || !currentPath(side) || !['file', 'directory', 'link'].includes(kind) || (kind === 'link' && side !== 'remote')) return;
    folderTarget = { side, kind, directory: currentPath(side), id };
    $('sftpNewFolderTitle').textContent = kind === 'file' ? 'Новый файл' : kind === 'directory' ? 'Новая папка' : 'Новая символическая ссылка';
    $('sftpNewObjectNameLabel').textContent = kind === 'file' ? 'Имя файла' : kind === 'directory' ? 'Имя папки' : 'Имя ссылки';
    $('sftpNewFolderLocation').textContent = folderTarget.directory;
    $('sftpNewFolderName').value = ''; $('sftpNewLinkTarget').value = '';
    $('sftpNewLinkTargetWrap').classList.toggle('hidden', kind !== 'link'); $('sftpNewLinkTarget').required = kind === 'link';
    $('sftpNewFolderError').textContent = ''; $('sftpNewFolderCreate').disabled = false;
    $('sftpNewFolderDialog').showModal(); $('sftpNewFolderName').focus();
  }
  $('sftpNewFolderCancel').addEventListener('click', () => $('sftpNewFolderDialog').close());
  $('sftpNewFolderDialog').addEventListener('close', () => { folderTarget = null; });
  $('sftpNewFolderForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const target = folderTarget; if (!target || target.id !== id || transferring || $('sftpNewFolderCreate').disabled) return;
    const name = $('sftpNewFolderName').value; $('sftpNewFolderCreate').disabled = true; $('sftpNewFolderError').textContent = '';
    try {
      if (target.kind === 'directory') await window.rdpManager.ssh.createDirectory(target.id, target.side, target.directory, name);
      else if (target.kind === 'file') await window.rdpManager.ssh.createFile(target.id, target.side, target.directory, name);
      else await window.rdpManager.ssh.createLink(target.id, target.side, target.directory, name, $('sftpNewLinkTarget').value);
      if (id !== target.id || folderTarget !== target) return;
      $('sftpNewFolderDialog').close(); message(target.kind === 'directory' ? 'Папка создана' : target.kind === 'file' ? 'Пустой файл создан' : 'Символическая ссылка создана');
      if (currentPath(target.side) === target.directory) await (target.side === 'local' ? showLocal(target.directory) : showDirectory(target.directory));
    } catch (error) { if (id === target.id && folderTarget === target) $('sftpNewFolderError').textContent = error.message; }
    finally { if (folderTarget === target) $('sftpNewFolderCreate').disabled = false; }
  });
  $('sftpProperties').addEventListener('click', () => { const file = activeSide === 'local' ? localSelection : remoteSelection; if (file) void openProperties(activeSide, file); });
  function editorDirty() { return editState && editState.loaded && $('sftpEditorText').value !== editState.original; }
  function canCloseEditor() {
    if (!editState) return true;
    if (editState.saving) return false;
    return !editorDirty() || window.confirm('Есть несохранённые изменения. Закрыть редактор и потерять их?');
  }
  function forceCloseEditor() {
    const old = editState; editState = null; editGeneration++;
    if (old?.id) void window.rdpManager?.ssh?.editorReset(old.id).catch(() => {});
    if ($('sftpEditorDialog').open) $('sftpEditorDialog').close();
    $('sftpEditorText').value = '';
  }
  function requestCloseEditor() { if (canCloseEditor()) forceCloseEditor(); }
  $('sftpEditorClose').addEventListener('click', requestCloseEditor);
  $('sftpEditorCancel').addEventListener('click', requestCloseEditor);
  $('sftpEditorDialog').addEventListener('cancel', (event) => { event.preventDefault(); requestCloseEditor(); });
  $('sftpEditorText').addEventListener('input', () => { if (editState?.loaded && !editState.saving) $('sftpEditorStatus').textContent = editorDirty() ? 'Есть несохранённые изменения' : 'Без изменений'; });
  $('sftpEditorDialog').addEventListener('keydown', (event) => { if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void saveEditor(); } });
  async function openEditor(side, file) {
    if (!id || transferring || !file?.file || !currentPath(side) || editState) return;
    const active = id, dir = currentPath(side), revision = ++editGeneration;
    editState = { id: active, side, dir, name: file.name, loaded: false, saving: false, original: '' };
    $('sftpEditorTitle').textContent = `Изменение · ${file.name}`; $('sftpEditorPath').textContent = selectedPath(side, file);
    $('sftpEditorText').value = ''; $('sftpEditorText').disabled = true; $('sftpEditorSave').disabled = true; $('sftpEditorError').textContent = ''; $('sftpEditorStatus').textContent = 'Загрузка…';
    $('sftpEditorDialog').showModal();
    try {
      const result = await window.rdpManager.ssh.editorOpen(active, side, dir, file.name);
      if (revision !== editGeneration || !editState || id !== active) return;
      editState.token = result.token; editState.original = result.text; editState.loaded = true;
      $('sftpEditorText').value = result.text; $('sftpEditorText').disabled = false; $('sftpEditorSave').disabled = false; $('sftpEditorStatus').textContent = 'Без изменений'; $('sftpEditorText').focus();
    } catch (error) { if (revision === editGeneration && editState) { $('sftpEditorError').textContent = error.message; $('sftpEditorStatus').textContent = 'Не удалось открыть файл'; } }
  }
  async function saveEditor() {
    const state = editState; if (!state?.loaded || state.saving || !state.token) return;
    state.saving = true; $('sftpEditorSave').disabled = true; $('sftpEditorText').disabled = true; $('sftpEditorError').textContent = ''; $('sftpEditorStatus').textContent = 'Сохранение…';
    try {
      await window.rdpManager.ssh.editorSave(state.id, state.token, $('sftpEditorText').value);
      if (editState !== state) return;
      state.original = $('sftpEditorText').value; state.saving = false; forceCloseEditor(); message('Файл сохранён');
      if (id === state.id && currentPath(state.side) === state.dir) await (state.side === 'local' ? showLocal(state.dir) : showDirectory(state.dir));
    } catch (error) { if (editState === state) { if (error.message.includes('Запись прервалась')) state.token = null; $('sftpEditorError').textContent = error.message; $('sftpEditorStatus').textContent = 'Не сохранено — скопируйте текст при необходимости'; } }
    finally { if (editState === state) { state.saving = false; $('sftpEditorText').disabled = false; $('sftpEditorSave').disabled = !state.token; } }
  }
  $('sftpEditorSave').addEventListener('click', () => void saveEditor());
  const permissionBits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1, 0o4000, 0o2000, 0o1000];
  const permissionInput = (bit) => $(`sftpPerm${bit.toString(8)}`);
  function renderPermissions(mode) { for (const bit of permissionBits) permissionInput(bit).checked = Boolean(mode & bit); }
  function validOctal(text) { return /^[0-7]{3,4}$/.test(text) ? parseInt(text, 8) : null; }
  for (const bit of permissionBits) permissionInput(bit).addEventListener('change', () => {
    let mode = 0; for (const flag of permissionBits) if (permissionInput(flag).checked) mode |= flag;
    $('sftpPropOctal').value = mode.toString(8).padStart(4, '0');
  });
  $('sftpPropOctal').addEventListener('input', () => { const mode = validOctal($('sftpPropOctal').value); if (mode !== null) renderPermissions(mode); });
  function forceCloseProperties() {
    const old = propertiesState; propertiesState = null; propertiesGeneration++;
    if (old?.id) void window.rdpManager?.ssh?.propertiesReset(old.id).catch(() => {});
    if ($('sftpPropertiesDialog').open) $('sftpPropertiesDialog').close();
  }
  function closeProperties() { if (!propertiesState?.saving) forceCloseProperties(); }
  $('sftpPropertiesCancel').addEventListener('click', closeProperties);
  $('sftpPropertiesDialog').addEventListener('cancel', (event) => { event.preventDefault(); closeProperties(); });
  async function openProperties(side, file) {
    if (!id || transferring || !file || !currentPath(side) || propertiesState) return;
    const active = id, dir = currentPath(side), revision = ++propertiesGeneration;
    propertiesState = { id: active, side, dir, name: file.name, saving: false };
    $('sftpPropertiesTitle').textContent = `Свойства · ${file.name}`;
    $('sftpPropName').textContent = file.name; $('sftpPropDirectory').textContent = dir;
    $('sftpPropType').textContent = 'Загрузка…'; $('sftpPropSize').textContent = '—'; $('sftpPropDate').textContent = '—';
    $('sftpPropUid').value = ''; $('sftpPropGid').value = ''; $('sftpPropOctal').value = ''; renderPermissions(0);
    $('sftpPropUid').disabled = true; $('sftpPropGid').disabled = true; $('sftpPropOctal').disabled = true; $('sftpPropPermissions').disabled = true;
    $('sftpPropertiesSave').disabled = true; $('sftpPropertiesError').textContent = ''; $('sftpPropertiesNote').textContent = 'Загрузка свойств…';
    $('sftpPropertiesDialog').showModal();
    try {
      const data = await window.rdpManager.ssh.propertiesOpen(active, side, dir, file.name);
      if (revision !== propertiesGeneration || !propertiesState || id !== active) return;
      propertiesState.data = data; propertiesState.token = data.token;
      $('sftpPropType').textContent = ({ file: 'Файл', directory: 'Каталог', link: 'Символическая ссылка', other: 'Другой объект' })[data.type] || 'Неизвестно';
      $('sftpPropSize').textContent = Number.isSafeInteger(data.size) ? `${formatSize(data.size)} (${data.size.toLocaleString('ru-RU')} байт)` : 'Неизвестно';
      const date = new Date(Number(data.mtime) * 1000); $('sftpPropDate').textContent = data.mtime != null && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU') : 'Неизвестно';
      $('sftpPropUid').value = data.uid == null ? '' : String(data.uid); $('sftpPropGid').value = data.gid == null ? '' : String(data.gid);
      if (data.mode != null) { const mode = data.mode & 0o7777; $('sftpPropOctal').value = mode.toString(8).padStart(4, '0'); renderPermissions(mode); }
      const editable = side === 'remote' && (data.type === 'file' || data.type === 'directory');
      $('sftpPropUid').disabled = $('sftpPropGid').disabled = !editable || data.uid == null || data.gid == null;
      $('sftpPropOctal').disabled = $('sftpPropPermissions').disabled = !editable || data.mode == null;
      $('sftpPropertiesSave').disabled = !editable || (data.mode == null && (data.uid == null || data.gid == null));
      $('sftpPropertiesNote').textContent = side === 'local' ? 'Локальные свойства доступны только для просмотра.' : data.type === 'link' ? 'Символическая ссылка: изменение свойств отключено, чтобы не менять её цель.' : 'UID/GID указаны численно. Изменения зависят от прав учётной записи и поддержки сервера.';
    } catch (error) { if (revision === propertiesGeneration && propertiesState) { $('sftpPropertiesError').textContent = error.message; $('sftpPropertiesNote').textContent = 'Не удалось прочитать свойства.'; } }
  }
  $('sftpPropertiesForm').addEventListener('submit', async (event) => {
    event.preventDefault(); const state = propertiesState; if (!state?.token || state.saving || $('sftpPropertiesSave').disabled) return;
    const mode = $('sftpPropOctal').disabled ? null : validOctal($('sftpPropOctal').value);
    if (!$('sftpPropOctal').disabled && mode === null) { $('sftpPropertiesError').textContent = 'Введите права от 0000 до 7777.'; return; }
    const parseId = (input) => input.disabled ? null : /^\d+$/.test(input.value) && Number.isSafeInteger(Number(input.value)) && Number(input.value) <= 0xffffffff ? Number(input.value) : NaN;
    const uid = parseId($('sftpPropUid')), gid = parseId($('sftpPropGid'));
    if (Number.isNaN(uid) || Number.isNaN(gid)) { $('sftpPropertiesError').textContent = 'UID и GID должны быть целыми числами от 0 до 4294967295.'; return; }
    if (((uid !== null && uid !== state.data.uid) || (gid !== null && gid !== state.data.gid)) && !window.confirm('Изменение владельца или группы может ограничить доступ к объекту. Продолжить?')) return;
    state.saving = true; $('sftpPropertiesSave').disabled = true; $('sftpPropertiesError').textContent = '';
    try {
      await window.rdpManager.ssh.propertiesSave(state.id, state.token, { mode, uid, gid });
      if (propertiesState !== state) return;
      state.saving = false; forceCloseProperties(); message('Свойства применены');
      if (id === state.id && currentPath(state.side) === state.dir) await showDirectory(state.dir);
    } catch (error) { if (propertiesState === state) $('sftpPropertiesError').textContent = error.message; }
    finally { if (propertiesState === state) { state.saving = false; $('sftpPropertiesSave').disabled = false; } }
  });
  async function pasteClipboardFiles() {
    if (!id || transferring || !directory.startsWith('/')) return;
    const active = id, target = directory; transferring = true; updateActions(); $('sftpProgress').classList.remove('hidden'); $('sftpProgress').value = 0; message('Вставка файлов из буфера…');
    try {
      const result = await window.rdpManager.ssh.pasteFiles(active, target); if (id !== active) return;
      transferring = false; updateActions(); message(result.cancelled ? `Вставка отменена, передано: ${result.count}` : `Передано файлов: ${result.count}`); await showDirectory(target);
    } catch (error) { if (id === active) { transferring = false; await showDirectory(target); message(`Ошибка вставки: ${error.message}`, true); } }
    finally { if (id === active) { transferring = false; updateActions(); $('sftpProgress').classList.add('hidden'); } }
  }
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
      hideContextMenu(); if ($('sftpOperationDialog').open) $('sftpOperationDialog').close(); operationState = null; if (propertiesState) { propertiesState.token = null; propertiesState.saving = false; $('sftpPropertiesSave').disabled = true; $('sftpPropertiesError').textContent = 'Соединение закрыто.'; } if (editState) { editState.token = null; editState.saving = false; $('sftpEditorText').disabled = !editState.loaded; $('sftpEditorSave').disabled = true; $('sftpEditorError').textContent = 'Соединение закрыто. Скопируйте несохранённый текст перед закрытием.'; } if ($('sftpNewFolderDialog').open) $('sftpNewFolderDialog').close(); folderTarget = null; id = null; transferring = false; updateActions(); if (terminal) terminal.dispose(); terminal = null; fit = null;
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
