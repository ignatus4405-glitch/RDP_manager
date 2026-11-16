# Участие в разработке

## Требования
- Node.js **≥ 22.5** (нужен встроенный `node:sqlite`).
- Зависимости: `npm install` в корне (npm workspaces: `server` + `client`).

## Локальный запуск
```bash
npm run server   # сервер на http://0.0.0.0:8720 (веб-панель: /, веб-клиент: /app/)
npm run client   # Electron-клиент (в sandbox без доступа к github.com бинарник Electron не скачается — см. AGENTS.md)
npm run check    # синтаксическая проверка всех JS
npm test         # смоук-тесты сервера
```

## Conventional Commits — ОБЯЗАТЕЛЬНО
Версионирование (release-please) и changelog строятся из сообщений коммитов:

| Префикс | Пример | Влияние на версию |
|---------|--------|-------------------|
| `feat:` | `feat(client): кнопка копирования ID AnyDesk` | minor (1.1.0 → 1.2.0) |
| `fix:` | `fix(server): теги нормализуются при сохранении` | patch (1.1.0 → 1.1.1) |
| `feat!:` / `BREAKING CHANGE:` | `feat!: новый формат адреса RustDesk` | major (1.1.0 → 2.0.0) |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | `docs: обновлён README` | без релиза |

Scopes: `server`, `client`, `ci`, `docs` — придерживаться существующих.

## Как выходит релиз (автоматически)
1. Коммиты попадают в `main` (через PR).
2. **release-please** (`.github/workflows/release.yml`) открывает/обновляет **Release PR**: bump версий в `package.json` (root, `client`, `server`) и `CHANGELOG.md`.
3. Мерж Release PR → создаётся тег `vX.Y.Z` и GitHub Release.
4. Тег запускает **Build** (`.github/workflows/build.yml`): Windows NSIS + Linux AppImage собираются, генерируются `latest(-linux).yml`, всё это публикуется в тот же Release (softprops/action-gh-release).
5. Клиенты на предыдущей версии при старте / раз в 6 ч видят баннер «Доступна новая версия…»; в собранном приложении обновление скачивается тихо и ставится по кнопке или при выходе.

Ручной релиз (если автоматика недоступна):
```bash
# 1. Поднять версии синхронно (root, client, server) и lockfile:
npm version 1.2.0 --no-git-tag-version
npm version 1.2.0 --workspace client --no-git-tag-version
npm version 1.2.0 --workspace server --no-git-tag-version
npm install               # синхронизирует package-lock.json
git commit -am "chore: release v1.2.0" && git push
# 2. Тег запускает сборку и публикацию:
git tag v1.2.0 && git push origin v1.2.0
```

## Приватный репозиторий
- `electron-updater` и кнопка «Установить обновление» не смогут анонимно скачать релиз из приватного репозитория: либо сделайте репозиторий публичным (тогда Releases API и установщики доступны всем), либо выдайте клиентам токен с правом `repo:releases` и настройте скачивание через свой механизм. Бандл и «Узнать о новой версии» через Releases API анонимно из приватного репо не работают (404/403) — баннер просто не появится, приложение продолжит работать.

## Правила для агентов/контрибьюторов
1. **Каждое изменение документируйте**: запись в `CHANGELOG.md` (или пишите conventional-commit — release-please добавит её сам) и, если менялось поведение/архитектура, — правку `AGENTS.md` / `README.md`.
2. Не правьте вручную версии в `package.json` при обычных `feat/fix`-коммитах — это делает release-please. Вручную версии поднимают только при подготовке `chore: release` или вне релизного цикла.
3. `server/data/` никогда не коммитится (там живая БД и `secret.key`).
4. Перед пушем: `npm run check && npm test`.
5. Не добавляйте inline `<script>` и `on*-атрибуты` в `client/renderer/index.html` — CSP запрещает их.
6. Подробная карта проекта и подводные камни — в `AGENTS.md`.
