# Участие в разработке

## Требования
- Node.js **≥ 22.5** (нужен встроенный `node:sqlite`).
- Зависимости: `npm install` в корне (npm workspaces: `server` + `client`).

## Локальный запуск
```bash
npm run server   # сервер на http://0.0.0.0:8720 (веб-панель: /, веб-клиент: /app/)
npm run client   # Electron-клиент (в sandbox без доступа к github.com бинарник Electron не скачается — см. AGENTS.md)
npm run check    # синтаксическая проверка всех JS
npm test         # тесты сервера и клиентских utilities
```

## Conventional Commits — ОБЯЗАТЕЛЬНО
Используйте Conventional Commits для истории и определения объёма релиза. Версии и `CHANGELOG.md` готовятся вручную отдельным release PR: workflow Release Please в репозитории не имеет прав создать PR.

| Префикс | Пример | Влияние на версию |
|---------|--------|-------------------|
| `feat:` | `feat(client): кнопка копирования ID AnyDesk` | minor (1.1.0 → 1.2.0) |
| `fix:` | `fix(server): теги нормализуются при сохранении` | patch (1.1.0 → 1.1.1) |
| `feat!:` / `BREAKING CHANGE:` | `feat!: новый формат адреса RustDesk` | major (1.1.0 → 2.0.0) |
| `docs:`, `chore:`, `refactor:`, `test:`, `ci:` | `docs: обновлён README` | без релиза |

Scopes: `server`, `client`, `ci`, `docs` — придерживаться существующих.

## Как выходит релиз (вручную)
1. После слияния обычных изменений в `main` подготовьте отдельный release PR: синхронно обновите версии в root/client/server `package.json`, `package-lock.json`, release manifest и `CHANGELOG.md` (например, запустите `npm install` после bump версий).
2. Дождитесь зелёных CI/Build-проверок и влейте release PR.
3. Вручную создайте и отправьте тег `vX.Y.Z` на merge-коммит release PR. Не рассчитывайте на `.github/workflows/release.yml`: workflow настроен, но `GITHUB_TOKEN` в этом репозитории не имеет прав открыть PR.
4. Тег запускает **Build** (`.github/workflows/build.yml`): публикуются единый Windows NSIS, Linux AppImage, Linux server tar.gz и `latest(-linux).yml`.
5. Проверьте assets командой `gh release view vX.Y.Z`. Клиенты на предыдущей версии при старте / раз в 6 ч проверяют обновления; приложение загружает клиентский установщик автоматически. Server Manager показывает ссылку на GitHub Release, где пользователь вручную запускает установщик и выбирает серверный компонент.

После мержа подставьте реальную версию и SHA merge-коммита release PR:
```bash
TAG=vX.Y.Z
RELEASE_COMMIT=MERGE_COMMIT_SHA
git tag "$TAG" "$RELEASE_COMMIT"
git push origin "$TAG"
gh release view "$TAG"
```

## Приватный репозиторий
- `electron-updater` и кнопка «Установить обновление» не смогут анонимно скачать релиз из приватного репозитория: либо сделайте репозиторий публичным (тогда Releases API и установщики доступны всем), либо выдайте клиентам токен с правом `repo:releases` и настройте скачивание через свой механизм. Бандл и «Узнать о новой версии» через Releases API анонимно из приватного репо не работают (404/403) — баннер просто не появится, приложение продолжит работать.

## Правила для агентов/контрибьюторов
1. **Документируйте заметные изменения** записью в `CHANGELOG.md`; при изменении поведения/архитектуры обновляйте `AGENTS.md` / `README.md`.
2. Не меняйте версии в обычных `feat/fix` PR. Bump root/client/server, release manifest и CHANGELOG делается синхронно в отдельном release PR.
3. `server/data/` никогда не коммитится (там живая БД и `secret.key`).
4. Перед пушем: `npm run check && npm test`.
5. Не добавляйте inline `<script>` и `on*-атрибуты` в `client/renderer/index.html` — CSP запрещает их.
6. Подробная карта проекта и подводные камни — в `AGENTS.md`.
