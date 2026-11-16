# AGENTS.md — инструкция для любого агента, продолжающего проект

Прочитайте это ПЕРЕД внесением изменений. Здесь — карта проекта, команды, релизный цикл и грабли.

## Что это за проект
RDP Manager — система единого доступа к инфраструктуре для компании:
- **server/** — отдельная серверная программа: REST API + SQLite, база подключений RDP/AnyDesk/RustDesk, документация, учётные записи (admin/employee). Встроенная веб-панель (`/`) и веб-режим клиента (`/app/`).
- **client/** — десктоп-приложение сотрудника (Electron): вход под своей учётной записью, поиск/фильтр подключений, запуск в один клик, чтение документации.

Стек: Node.js ≥ 22.5, Express 4, встроенный `node:sqlite` (без нативных модулей), Electron + electron-builder + electron-updater. Внешних сервисов нет — всё самодельное, работает в закрытой сети (кроме проверки обновлений GitHub).

## Команды
| Команда | Что делает |
|---|---|
| `npm install` | установка (workspaces server+client). **В sandbox без доступа к `objects.githubusercontent.com`** ставьте `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — иначе postinstall electron упадёт TLS-ошибкой; на обычной машине ставить НЕ нужно |
| `npm run server` | запуск сервера :8720. При первом старте создаёт `server/data/rdp-manager.db` и `admin/admin123` (смена обязательна) |
| `npm run client` | Electron-клиент |
| `npm run check` | `node --check` для всех JS |
| `npm test` | смоук-тест сервера (`server/test/smoke.test.js`, node:test) |
| `npm run dist` | сборка установщиков в `client/dist/` |
| `npm run dist` | сборка установщиков в `client/dist/` |
| `node client/scripts/make-latest-yml.js` | генерация `latest(-linux).yml` для автообновления (CI делает сам на тегах) |

## Карта файлов
```
server/src/index.js   — HTTP-сервер, статика панели (/) и веб-клиента (/app/), логирование
server/src/api.js     — все маршруты /api: login, change-password, users CRUD, connections CRUD + /meta, documents CRUD, stats
server/src/db.js      — схема SQLite, seed admin, scrypt hash/verify, секрет токенов (data/secret.key)
server/src/auth.js    — HMAC-JWT (sign/verify), requireAuth, requireAdmin (12 ч TTL, env RDP_MANAGER_TOKEN_TTL)
server/web/index.html — веб-панель администратора (vanilla JS, те же /api/*)
server/test/          — смоук-тесты
client/main.js        — окно Electron; запуск mstsc/xfreerdp/anydesk/rustdesk (spawn, без shell); electron-updater (только packaged)
client/preload.js     — contextBridge: rdpManager.{launch,version,openExternal,platform,updates.*}
client/renderer/*.js  — UI (vanilla, без фреймворка); md.js — безопасный Markdown→HTML
client/renderer/index.html — CSP: script-src 'self' (никаких inline-скриптов и on*-атрибутов!)
.github/workflows/    — ci.yml (check+test на каждый push/PR), build.yml (установщики, publish на тегах v*), release.yml (release-please)
release-please-config.json / .release-please-manifest.json — авто-версионирование (тег vX.Y.Z, CHANGELOG.md)
```

## Релизный цикл (автоматический)
1. Коммит по Conventional Commits (`feat:`, `fix:`, …) → push/PR в `main`.
2. CI проверяет код; Build собирает установщики (артефакты).
3. release-please обновляет Release PR (версия + CHANGELOG).
4. Мерж Release PR → тег `vX.Y.Z` → Build публикует NSIS/AppImage + `latest.yml` в Release.
5. Клиенты получают уведомление (электрон-апдейтер при старте и раз в 6 ч; баннер в приложении; кнопка «Проверить обновления» в Профиле).
Подробности и приватный репозиторий: CONTRIBUTING.md.

## Подводные камни
1. **`node:sqlite` experimental** в Node 22 → везде используются `--disable-warning=ExperimentalWarning` (скрипты `server`); API стабилен в рамках нашей схемы. Если переходите на <22.5 — нужен `better-sqlite3` (нативная сборка).
2. **CSP клиента**: только внешние скрипты, `connect-src http: https:` (адрес сервера вводится пользователем — любой http(s) хост). Не добавляйте inline-обработчики.
3. **Теги подключений** хранятся через `tags` колонку `"a,b,c"` (без пробелов) — фильтр `tag=` требует точного совпадения элемента; нормализация на сервере (`normalizeTags`).
4. **Запуск программ**: адреса валидируются на управляющие символы; `spawn` без `shell` — не собирайте командную строку строкой. AnyDesk ID чистится от пробелов (`123 456 789` → `123456789`).
5. **Токены**: секрет подписи лежит в `server/data/secret.key` (создаётся при первом старте, НЕ коммитится; можно переопределить env `RDP_MANAGER_SECRET`). Если ключ удалить — все выданные токены перестанут быть валидными, пользователи просто войдут заново.
6. **БД и `must_change_password`**: свежий сервер всегда создаёт `admin/admin123` с обязательной сменой. Не коммитьте `server/data/`.
7. **Версии**: руками не бампить (release-please), кроме синхронной подготовки `chore: release`.
8. **Публикация релиза** — `softprops/action-gh-release` на теге `v*` (НЕ `electron-builder --publish`): матрица Windows/Linux пишет в один Release без гонок; `latest.yml`/`latest-linux.yml` генерирует `client/scripts/make-latest-yml.js` (sha512 + size, формат electron-updater).
9. **Приватный репозиторий**: автообновление клиентов не скачает установщик анонимно — см. CONTRIBUTING.md.
10. **Аудит**: `npm audit` показывает moderate (minimatch, build-time цепочка electron-builder) — осознанно не блокируем CI; новые high+ уязвимости чините.

## После внесения изменений (чеклист агента)
1. `npm run check && npm test` — зелёные.
2. Conventional Commit (`feat(server): …` / `fix(client): …`).
3. Запись в `CHANGELOG.md` **не нужна**, если коммит в формате Conventional Commits и попадает в Release PR release-please; иначе добавьте вручную.
4. Обновите этот файл и `README.md`, если менялась архитектура/команды/релизный процесс.
5. Push → GitHub Actions (ci + build) отработает автоматически; для релиза версии — через Release PR (или ручной тег `v*`).
6. Никогда не пушьте в `main` напрямую без ревью (кроме экстренных случаев), не коммитьте `server/data/`, не ломайте CSP.
