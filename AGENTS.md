# AGENTS.md — инструкция для любого агента, продолжающего проект

Прочитайте это ПЕРЕД внесением изменений. Здесь — карта проекта, команды, релизный цикл и грабли.

## Что это за проект
RDP Manager — система единого доступа к инфраструктуре для компании:
- **server/** — отдельная серверная программа: REST API + SQLite, база подключений RDP/AnyDesk/RustDesk, документация, учётные записи (admin/employee). Встроенная веб-панель (`/`) и веб-режим клиента (`/app/`).
- **client/** — десктоп-приложение сотрудника (Electron): вход под своей учётной записью, поиск/фильтр подключений, запуск в один клик, чтение документации.

Стек: Node.js ≥ 22.5, Express 4, встроенный `node:sqlite` (без нативных модулей), Electron + electron-builder + electron-updater. Для встроенного RDP — IronRDP (WebAssembly) + RDCleanPath поверх WebSocket (шлюз на сервере, без нативных модулей). Внешних сервисов нет — всё самодельное, работает в закрытой сети (кроме проверки обновлений GitHub).

## Команды
| Команда | Что делает |
|---|---|
| `npm install` | установка (workspaces server+client). **В sandbox без доступа к `objects.githubusercontent.com`** ставьте `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — иначе postinstall electron упадёт TLS-ошибкой; на обычной машине ставить НЕ нужно |
| `npm run server` | запуск сервера :8720. При первом старте создаёт `server/data/rdp-manager.db` и `admin/admin123` (смена обязательна) |
| `npm run client` | Electron-клиент |
| `npm run check` | `node --check` для всех JS |
| `npm test` | все тесты сервера (`node --test test/*.test.js`): смоук + unit rdp-gateway |
| `npm run dist` | сборка установщиков клиента в `client/dist/` (сначала `build:ironrdp`) |
| `npm run build:ironrdp --workspace client` | сборка `client/renderer/vendor/ironrdp/bundle.js` (esbuild) — обязательна перед запуском/сборкой клиента |
| `npm run build:sea --workspace server` | сборка однофайлового сервера (esbuild → SEA) в `server/dist/rdp-manager-server[.exe]` |
| `node client/scripts/make-latest-yml.js` | генерация `latest(-linux).yml` для автообновления (CI делает сам на тегах) |
| `server/installer/linux/install.sh` | установка сервера в `/opt/rdp-manager-server` + systemd (внутри tar.gz) |
| `server/installer/windows/installer.nsi` | NSIS-установщик сервера для Windows (makensis в CI через choco) |

## Карта файлов
```
server/src/index.js   — HTTP-сервер, статика панели (/) и веб-клиента (/app/), WebSocket-upgrade, логирование
server/src/api.js     — все маршруты /api: login, change-password, users CRUD, connections CRUD + /meta, documents CRUD, stats
server/src/db.js      — схема SQLite, seed admin, scrypt hash/verify, секрет токенов (data/secret.key)
server/src/auth.js    — HMAC-JWT (sign/verify), requireAuth, requireAdmin (12 ч TTL, env RDP_MANAGER_TOKEN_TTL)
server/src/rdp-gateway.js — RDCleanPath-шлюз: WS `/ws/rdp` → TCP/TLS → RDP; JWT (?token=) + allowlist целей по таблице connections (type='rdp'); ASN.1 DER, адаптировано из electerm/ironrdp-wasm (MIT)
server/web/index.html — веб-панель администратора (vanilla JS, те же /api/*)
server/test/          — смоук + unit-тесты (smoke.test.js, rdp-gateway.test.js)
server/src/paths.js   — «домашний» каталог приложения (env → web/ рядом с exe (SEA) → dev из репозитория)
server/scripts/build-sea.js — esbuild-бандл + инъекция в node-бинарник (SEA)
server/installer/     — installer.nsi (Windows), install.sh/uninstall.sh + systemd-юнит (Linux), README
client/main.js        — окно Electron; внешний запуск (mstsc/remmina/xfreerdp/anydesk/rustdesk, spawn без shell); electron-updater
client/preload.js     — contextBridge: rdpManager.{launch,version,openExternal,platform,updates.*}
client/renderer/*.js  — UI (vanilla, без фреймворка); md.js — безопасный Markdown→HTML
client/renderer/ironrdp-entry.mjs — вход IIFE-бандла встроенного RDP (IronRDP WASM, wasm как data:URL)
client/renderer/vendor/ — генерируется scripts/build-ironrdp.js (в .gitignore, НЕ коммитить; нужен для RDP-в-окне)
client/renderer/index.html — CSP: script-src 'self' 'wasm-unsafe-eval'; connect-src http: https: ws: wss:
.github/workflows/    — ci.yml (check+test на каждый push/PR), build.yml (установщики, publish на тегах v*), release.yml (release-please)
release-please-config.json / .release-please-manifest.json — авто-версионирование (тег vX.Y.Z, CHANGELOG.md)
```

## Релизный цикл (автоматический)
1. Коммит по Conventional Commits (`feat:`, `fix:`, …) → push/PR в `main`.
2. CI проверяет код; Build собирает установщики (артефакты).
3. release-please обновляет Release PR (версия + CHANGELOG).
4. Мерж Release PR → тег `vX.Y.Z` → Build собирает и публикует в Release: клиент (NSIS/AppImage + `latest*.yml`) И сервер (`RDPManager-Server-Setup-*.exe` NSIS / `RDPManager-Server-*-linux-x64.tar.gz`).
5. Клиенты получают уведомление (электрон-апдейтер при старте и раз в 6 ч; баннер в приложении; кнопка «Проверить обновления» в Профиле).
Подробности и приватный репозиторий: CONTRIBUTING.md.

## Встроенный RDP (как в RDM) — как устроено
- Клиент рендерит RDP на `<canvas>` через **IronRDP WASM** (`client/renderer/vendor/ironrdp/bundle.js`, собирается esbuild'ом из `renderer/ironrdp-entry.mjs`; WASM декодируется из data:URL в байты и передаётся в `WebAssembly.instantiate` напрямую — НИКАКОГО `fetch(data:)`: `connect-src` его блокирует).
- Между WASM и RDP-узлом — **RDCleanPath** (ASN.1 DER поверх WebSocket). Шлюз на сервере: `server/src/rdp-gateway.js` (`/ws/rdp`, зависимость `ws`), адаптирован из electerm/ironrdp-wasm (MIT) + аутентификация и allowlist.
- Аутентификация шлюза: `?token=<JWT>` из `sessionStorage`; цели сверяются с таблицей `connections` (`type='rdp'`, host case-insensitive, порт по умолчанию 3389) — open relay исключён. Пароль RDP через шлюз не логируется (CredSSP выполняет WASM-клиент).
- Рендерер: полноэкранный `#rdpOverlay`, форма (username из карточки + пароль каждый раз), `desktopSize` по доступному пространству `.rdp-body` (чётные, до 4096×2160; расширение `display_control` + живой `session.resize()` при изменении окна через 250 мс debounce), ввод — PS/2-сканкоды (раскладка не влияет), буфер обмена — текст, двусторонний: remote→local через `remoteClipboardChangedCallback` → `clipboard.writeText` главного процесса (IPC `clipboard-read`/`clipboard-write` в `client/main.js` + `readClipboard`/`writeClipboard` в preload), local→remote — поллинг системного буфера раз в 800 мс во время сессии (API `navigator.clipboard` в renderer ненадёжен без жестов/разрешений), `Esc` уходит в сессию (закрыть окно можно с формы).
- Сборка: `npm run build:ironrdp --workspace client` (входит в `npm run dist`; CI собирать ничего отдельно не нужно). Unit-тесты шлюза: `server/test/rdp-gateway.test.js`.
- Ограничения: экзотика (RD Gateway, RemoteFX, smartcard, редиректы дисков) не поддерживается — для таких узлов есть кнопка «Во внешнем клиенте». Графическую часть проверяйте на реальной машине: в sandbox GUI нет.

## SEA (однофайловый сервер) — как устроено
- `esbuild` собирает весь сервер в один `dist/server.cjs`; встроенные модули (`node:sqlite`, `crypto`) внешние.
- `node --experimental-sea-config` → blob; чистый node-бинарник копируется в `dist/rdp-manager-server[.exe]`; `postject` внедряет blob (sentinel `NODE_SEA_FUSE_...`).
- Пути к `web/` и `data/` определяются в `src/paths.js` ЧЕРЕЗ `process.execPath` (а не `__dirname`!) — поэтому в бандле `__dirname` себя не спасёт: порядок — env `RDP_MANAGER_HOME` → `web/` рядом с исполняемым файлом → dev из репозитория.
- `web/` — обязательно рядом с бинарником (веб-панель); без неё статика просто не раздастся (не падает).
- SEA-бинарник ≈ 120 МБ (внутри рантайм Node); в релизе — как есть, сжимается самим GitHub.
- Локально SEA собирается и проверяется только на той же ОС; в CI — матрица `Server · Windows|Linux` в `build.yml`, на тегах обе сборки публикуются в релиз.
- Версия в баннере/`/api/health` берётся из `server/package.json` (инлайнится esbuild'ом).

## Подводные камни
1. **`node:sqlite` experimental** в Node 22 → везде используются `--disable-warning=ExperimentalWarning` (скрипты `server`); API стабилен в рамках нашей схемы. Если переходите на <22.5 — нужен `better-sqlite3` (нативная сборка).
2. **CSP клиента**: только внешние скрипты; `script-src 'self' 'wasm-unsafe-eval'` (нужен для WebAssembly), `connect-src http: https: ws: wss:` (адрес сервера вводится пользователем + WebSocket шлюза). Не добавляйте inline-обработчики.
2a. **`client/renderer/vendor/` НЕ коммитить** — бандл собирается `npm run build:ironrdp --workspace client` (автоматически из `npm run dist` и в CI перед electron-builder). Без него встроенный RDP не работает (форма покажет подсказку), остальное работает; «Во внешнем клиенте» на карточке/в панели — запасной путь.
3. **Теги подключений** хранятся через `tags` колонку `"a,b,c"` (без пробелов) — фильтр `tag=` требует точного совпадения элемента; нормализация на сервере (`normalizeTags`).
4. **Запуск программ**: адреса валидируются на управляющие символы; `spawn` без `shell` — не собирайте командную строку строкой. AnyDesk ID чистится от пробелов (`123 456 789` → `123456789`).
5. **Токены**: секрет подписи лежит в `server/data/secret.key` (создаётся при первом старте, НЕ коммитится; можно переопределить env `RDP_MANAGER_SECRET`). Если ключ удалить — все выданные токены перестанут быть валидными, пользователи просто войдут заново.
6. **БД и `must_change_password`**: свежий сервер всегда создаёт `admin/admin123` с обязательной сменой. Не коммитьте `server/data/`.
7. **Версии**: руками не бампить (release-please), кроме синхронной подготовки `chore: release`.
8. **Публикация релиза** — `softprops/action-gh-release` на теге `v*` (НЕ `electron-builder --publish`): матрица Windows/Linux пишет в один Release без гонок; `latest.yml`/`latest-linux.yml` генерирует `client/scripts/make-latest-yml.js` (sha512 + size, формат electron-updater). **Секция `publish` в `build` клиента отсутствует намеренно** — при её наличии electron-builder требует GH_TOKEN даже при `--publish never`.
9. **Приватный репозиторий**: автообновление клиентов не скачает установщик анонимно — см. CONTRIBUTING.md.
10. **Аудит**: `npm audit` показывает moderate (minimatch, build-time цепочка electron-builder) — осознанно не блокируем CI; новые high+ уязвимости чините.
11. **electron — только в devDependencies и ТОЧНАЯ версия** (без `^`): иначе electron-builder мгновенно падает («only allowed in devDependencies» / «version is a range»). Версия electron должна совпадать с той, что скачана в node_modules.
12. **electron-updater в dependencies** клиента (не dev) — он нужен в собранном приложении. `electron-builder` и `electron` — devDependencies.

## После внесения изменений (чеклист агента)
1. `npm run check && npm test` — зелёные.
2. Conventional Commit (`feat(server): …` / `fix(client): …`).
3. Запись в `CHANGELOG.md` **не нужна**, если коммит в формате Conventional Commits и попадает в Release PR release-please; иначе добавьте вручную.
4. Обновите этот файл и `README.md`, если менялась архитектура/команды/релизный процесс.
5. Push → GitHub Actions (ci + build) отработает автоматически; для релиза версии — через Release PR (или ручной тег `v*`).
6. Никогда не пушьте в `main` напрямую без ревью (кроме экстренных случаев), не коммитьте `server/data/`, не ломайте CSP.
