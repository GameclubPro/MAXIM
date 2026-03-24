# Agent Notes

- SSH alias для VPS: `ssh maxim-vps`
- Alias `maxim-vps` должен использовать SSH multiplexing: `ControlMaster auto`, `ControlPersist 10m`, `Compression yes`.

## Правило выполнения изменений
- Если агент внёс изменения в код, задачу по умолчанию считать завершённой только после выката этих изменений на VPS.
- Исключение: пользователь явно просит ограничиться локальными изменениями, без деплоя.
- После выката на VPS обязательно выполнить post-pull шаги из этого файла: Prisma migrations, rebuild только изменённых сервисов, `--force-recreate`, проверки health.

## Docker Compose на VPS
- Использовать только Docker CE + Compose v2 plugin: `docker compose`.
- Не использовать `docker-compose` v1.
- Для обычного прод-режима использовать `infra/docker-compose.yml`.
- Для разделённого/нагрузочного режима использовать `infra/docker-compose.scale.yml`.
- Нельзя одновременно держать поднятыми оба контура из-за конфликта порта `3001`.
- При переключении контура сначала делать `down --remove-orphans` у текущего контура.
- В базовом compose на VPS не пробрасываются host-порты `postgres/redis`, чтобы не конфликтовать с уже занятыми `5432/6379` на хосте.
- Для `docker compose exec/run` на VPS нужен `/var/www/Chat_bot/.env`. Если файла нет, его нужно восстановить до post-pull шагов:
  - `cd /var/www/Chat_bot`
  - `docker inspect infra-api-1 --format "{{range .Config.Env}}{{println .}}{{end}}" | grep -v "^PATH=" | grep -v "^NODE_VERSION=" | grep -v "^YARN_VERSION=" > .env`
- Если `git pull --ff-only` блокируется из-за грязного дерева на VPS, сначала нужно проверить, совпадает ли текущее содержимое файлов с `origin/<branch>`. Если совпадает, допускается служебный путь:
  - `git stash push -m codex-sync-<date>`
  - `git pull --ff-only origin <branch>`
  - `git stash drop`
- Если рабочее дерево на VPS грязное и не совпадает с `origin/<branch>`, агент не должен молча перетирать эти изменения; нужно остановиться и явно сообщить о конфликте.

## Локальная среда
- Локально по умолчанию допустимы:
  - разработка кода,
  - тесты и сборка через `npm`,
  - git-операции,
  - Docker-сценарии через `docker compose`.
- Для локального запуска `postgres/redis` с пробросом портов использовать два файла:
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml ...`

## Актуальность MAX
- Для вопросов по MAX Bot API / Mini Apps / `init_data` / webhook / `open_app` агент должен сверяться с актуальными официальными источниками MAX, а не с памятью.
- Для приветствий, вступлений и смежной модерации обязательно проверять webhook subscriptions (`GET /subscriptions`): в `update_types` должны быть минимум `message_created`, `user_added`, `bot_added` и обычно `bot_started`.
- Приоритет источников:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- Сторонние сайты использовать только как вторичный контекст; в спорных местах опираться на `dev.max.ru`.
- Если есть риск устаревания, в ответе явно указывать, что информация сверена с актуальной документацией MAX на момент запроса.

## Правило для дизайна и верстки mini app
- Агент обязан оценивать качество верстки и дизайна mini app по внутренней шкале `0-100` перед завершением задачи.
- Оценка должна учитывать минимум: мобильную композицию первого экрана, визуальную иерархию, плотность интерфейса, качество шапки, ритм отступов, нативность ощущений в webview, состояние при скролле, читаемость текста, цельность стиля и общее ощущение premium-уровня.
- Если агент сам оценивает результат ниже `100/100`, он обязан делать следующие проходы и улучшения самостоятельно, без запроса подтверждения пользователя между итерациями.
- Агент не должен останавливаться на уровне “нормально”, “стало лучше” или “достаточно”; задача по дизайну считается незавершенной, пока агент сам не доведет результат до своей максимальной планки `100/100` или не упрется в объективный блокер.
- Допустимые блокеры: отсутствует нужный экран/контекст, нет доступа к актуальному UI, есть конфликтующие требования пользователя, изменение ломает бизнес-логику, или дальнейшие правки требуют решения по продукту, которое нельзя безопасно принять в одностороннем порядке.
- Если доступен локальный preview, моковый режим, device-frame или иной способ стабильной визуальной оценки, агент обязан использовать его как основной инструмент для доведения интерфейса до максимального качества.
- Если в проекте есть auto-screenshot flow для mini app, агент обязан прогонять его перед финальной оценкой дизайна и использовать полученные скриншоты как обязательный источник визуальной проверки.
- Для задач по mini app дизайн нельзя считать оцененным только по коду; агент обязан сверять результат по реальным auto-screenshots из mobile preview/emulation, а при возможности использовать оба профиля: `android` и `iphone`.
- При каждой существенной правке дизайна агент должен по возможности обновлять auto-screenshots заново, чтобы оценка `0-100` опиралась на актуальную версию интерфейса.
- Актуальными считаются только скриншоты из самого нового каталога `artifacts/miniapp-screenshots/<timestamp>` или из самого свежего запуска VPS flow.
- Если локальный `npm run screenshots:miniapp` падает из-за отсутствующих Playwright system libraries / browser deps, это не считается блокером: агент должен сразу переключаться на VPS flow.
- Для текущего репозитория стандартный путь такой:
  - `Локально`: `npm run screenshots:miniapp`
  - `VPS`: `cd /var/www/Chat_bot && ./infra/scripts/vps-miniapp-preview-screenshots.sh`

## Обязательные шаги после `git pull` на VPS
1. Применить миграции Prisma.
2. Пересобрать только изменённые сервисы (`api` и/или `miniapp-static`).
3. Пересоздать контейнеры c `--force-recreate`.
4. Проверить готовность API:
   - `http://127.0.0.1:3001/api/health/live`
   - `https://maxim.play-team.ru/api/health/live`
5. Если задача про модерацию ссылок: проверить `webhook_events` (`status`, `normalized_payload`) и `moderation_events`.

## Правило для команд
- Если действие можно выполнять и локально, и на VPS, агент должен давать оба варианта:
  - блок `Локально`
  - блок `VPS`
- Если отличается только путь, показывать обе версии с корректными путями.
- Если команда одинаковая, всё равно явно отмечать, что она применима в обоих окружениях.
- Для docker-команд первичным считать `VPS`-блок.
- Команды давать как чистый shell без эмодзи и лишних токенов в конце строки.

## Git flow для деплоя
- Для задач вида «выкатить изменения» агент должен давать порядок строго так:
  1. `Локально`: `git add` -> `git commit` -> `git push`
  2. `VPS`: `git pull` той же ветки -> обязательные post-pull шаги
- В командах с шаблоном `git push origin <BRANCH>` и `git pull origin <BRANCH>` нужно подставлять реальную ветку, не копировать `<BRANCH>` буквально.
- Если пользователь просит «только команды», агент отвечает только командами без длинных пояснений.

## Короткий сценарий деплоя
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `./infra/scripts/local-commit-push.sh "<COMMIT_MESSAGE>" main`
- VPS:
  - `cd /var/www/Chat_bot`
  - `./infra/scripts/vps-pull-build-up.sh main`

## Шаблоны команд

### Пересборка только API
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `docker compose -f infra/docker-compose.yml build api`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps api`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml build api`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate api`

### Пересборка только miniapp
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `docker compose -f infra/docker-compose.yml build miniapp-static`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps miniapp-static`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml build miniapp-static`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate miniapp-static`
