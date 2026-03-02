# Agent Notes (MAXIM)

## Язык и стиль
- Предпочтительный язык общения пользователя: русский.
- Ответы и инструкции давать коротко и по делу, без воды.

## Проект и окружения
- Локальный путь проекта: `/home/yourname/projects/MAXIM`.
- VPS путь проекта: `/var/www/Chat_bot`.
- GitHub репозиторий: `https://github.com/GameclubPro/MAXIM.git`.
- Прод-домен: `https://maxim.play-team.ru`.
- Локальная машина пользователя (`yourname@sex`) на текущий момент без Docker CLI (`docker: command not found`).

## Правило исполнения изменений (обязательно)
- Для задач, где агент вносит изменения в код, работа считается завершённой только после подключения к VPS и применения изменений в прод-контуре (`/var/www/Chat_bot`), если пользователь явно не попросил ограничиться локальными правками.
- После выката на VPS обязательно выполнить проверки `api/health/live` и `api/health/ready` локально на VPS и через домен.
- Если после выката есть зависшие `QUEUED/FAILED` webhook-события, агент обязан явно показать их статус и выполнить согласованную операционную процедуру (карантин/переобработка).
- Если пользователь даёт прямое поручение на выполнение (внедрить/выкатить/проверить), агент должен сразу выполнять его без запроса дополнительного подтверждения. Исключение: явно разрушительные или опасные действия (`rm -rf`, `reset --hard`, массовые удаляющие SQL без условия и т.п.) — их нельзя запускать без отдельного подтверждения.

## Стек и сервисы
- API: NestJS + Fastify + Prisma + BullMQ.
- Miniapp: React + Vite + TypeScript.
- База: Postgres.
- Очереди/кэш: Redis.
- Docker compose services: `api`, `miniapp-static`, `postgres`, `redis`.
- Docker compose scale-services (нагрузочный/разделённый контур): `api-ingress`, `api-enqueue`, `api-moderation`, `api-action`, `miniapp-static`, `postgres`, `redis`.
- Порты (внутри VPS): `api -> 3001`, `miniapp-static -> 3000`.

## UI/UX стандарт (обязательно)
- Для всех новых экранов/редизайна miniapp агент по умолчанию делает **mobile-first UI уровня нативного приложения 2026**.
- Избегать вида “обычная веб-форма/админка”; приоритет: карточки, нативные отступы/типографика, крупные tap-target (>=44px), понятные состояния загрузки/ошибок/пустоты.
- Сохранять визуальную консистентность текущего продукта, но при этом делать интерфейс современным и “app-like”.
- Если пользователь явно не просит минимализм/старый стиль, не предлагать устаревшие или слишком простые шаблонные UI-решения.

## Важные факты из этого чата
- Webhook MAX успешно доходит до API (`201`), события пишутся в `webhook_events`.
- Ошибка `401 Invalid init data signature` была исправлена:
  - валидация init_data должна использовать `secretKey = HMAC_SHA256("WebAppData", MAX_BOT_TOKEN)` как raw bytes (`digest()`), а не hex-строку.
- Miniapp должен открываться через кнопку `open_app` в MAX.
- Для MAX WebApp важно не терять query-параметры (`init_data`) при редиректе на `/app/`.
- Проблема `404 Chat settings not found` решена логикой автосоздания настроек чата в API при чтении настроек.
- Прямой `curl` с фейковым `Authorization: InitData ...` без корректного `hash` всегда даст `401` (`Missing hash`/`Invalid signature`) и не подходит для проверки auth-флоу.
- В miniapp уже добавлялся bridge-скрипт MAX и fallback-чтение `init_data` из query/hash/bridge-источника.
- Для `message_created` в MAX реальные поля часто такие:
  - `message.body.mid` (ID сообщения),
  - `message.recipient.chat_id` (ID чата),
  - `message.sender.user_id` (ID автора),
  - `message.body.text` (текст).
- Модерация должна удалять целиком сообщение, если в тексте есть ссылка (а не “вырезать” часть текста).
- Исправлен вызов удаления через MAX API: `DELETE /messages` с query `message_id` + `chat_id`.
- Исправлен вызов отправки сообщения через MAX API: `POST /messages` должен передавать `chat_id` в query, а `text` в body.
- Модерация дублей обновлена: при включённом `duplicateBotMessageEnabled` первый дубль удаляется и бот отправляет объяснение; предупреждение начинается со следующего повтора, дальше `KICK/BAN` по ступеням настроек.
- Модерация игнорирует сообщения, отправленные ботом/сервисом (`sender.type=bot/service` или `is_bot=true`), чтобы бот не удалял собственные служебные сообщения.
- Экран `Настройки` в miniapp обновлён:
  - убран верхний блок в `Settings`,
  - удалены заглушки (оставлена только рабочая логика по ссылкам),
  - в режиме `ALLOWLIST_ONLY` есть реальный ввод/список разрешённых доменов,
  - в `Настройках` показывается название чата, а не только `chat_id`.
- В API добавлен endpoint чтения allowlist доменов:
  - `GET /api/v1/chats/:chatId/domain-allowlist` -> `string[]`.
- После `docker compose ... up -d --no-deps --force-recreate ...` возможен кратковременный `502` до старта upstream; это может быть нормой на коротком интервале.
- Актуализированы deploy-скрипты:
  - `infra/scripts/local-commit-push.sh` проверяет, что при изменении `apps/api/prisma/schema.prisma` в commit добавлена migration (`apps/api/prisma/migrations/*/migration.sql`).
  - `infra/scripts/vps-pull-build-up.sh` поднимает `postgres/redis`, ждёт готовность Postgres через `pg_isready`, применяет миграции и только потом пересоздаёт `api/miniapp-static`.
- Актуализирован Docker Compose:
  - `infra/docker-compose.yml` (базовый, для VPS) **без** host-портов `postgres/redis`.
  - `infra/docker-compose.local.yml` добавляет host-порты `5432/6379` только для локальной разработки (если Docker установлен локально).
  - `infra/docker-compose.vps.yml` удалён и больше не используется.
- Поддерживается scale-контур `infra/docker-compose.scale.yml` с ролями:
  - `APP_ROLE=ingress` (`api-ingress`) — приём webhook и запись события;
  - `APP_ROLE=enqueue` (`api-enqueue`) — outbox enqueue;
  - `APP_ROLE=moderation` (`api-moderation`) — вычисление нарушений;
  - `APP_ROLE=action` (`api-action`) — внешние MAX API действия.
- Нагрузочные факты (март 2026, VPS 2 vCPU / 2 GB RAM):
  - при `100 rps` 10 минут: HTTP `0% failed`, `~60001` запросов, обработка `p95 ~0.5s`, `p99 ~0.55s`;
  - при `~250-270 rps`: появились `EOF/timeouts`, сильный backlog и деградация задержек (вплоть до сотен секунд).
- На слабом VPS фиксировались ошибки Prisma в `api-enqueue` (`P1017`, pool timeout / DB connection closed); использовался workaround:
  - `DATABASE_URL=...&connection_limit=2&pool_timeout=30`.
- Добавлена миграция удаления неуправляемых через miniapp полей настроек:
  - `apps/api/prisma/migrations/20260302012000_remove_unmanaged_chat_settings_fields/migration.sql`.
- Из `chat_settings`/контракта удалены поля, которые не настраиваются в miniapp UI:
  - `profanityLevel`, `capsThreshold`, `floodWindowSec`, `floodMaxMessages`, `duplicateWindowSec`, `duplicateMaxCount`,
  - `commercialAdsRepeatWindowSec`, `commercialAdsLowConfidenceLogEnabled`, `commercialAdsWarnFirstEnabled`,
  - `repeatBanWindowDays`, `logRetentionDays`.
- Исправлено поведение банов за ссылки/текст-фильтры:
  - теперь используется `banDurationHours` из настроек чата, а не захардкоженные `6h`.
- Приветствие новых участников в чате исправлено и работает:
  - причина №1: MAX может присылать вход участника отдельным событием `update_type=user_added`/`bot_added`, а не только `message_created`.
  - причина №2: webhook-подписка бота была без `user_added`/`bot_added`, поэтому в `webhook_events` были только `message_created`.
  - в API добавлена нормализация membership-событий (`user_added`/`bot_added`) в `normalized_payload.message`, даже если в payload нет `message` и/или `sender_id`.
  - в модерации добавлен fallback: обработка вступлений идёт по факту участников (`new_members`/membership payload), даже без маркера `sender.type=service`.
  - быстрый индикатор проблемы: `greetingEnabled=true`, но в `moderation_events` нет `GREETING_MESSAGE`, а в `webhook_events` за период видны только `message_created`.
- В miniapp добавлен блок `Рассылка`:
  - текст + опциональная кнопка + опциональное фото + тумблер `применить во всех чатах`,
  - таймер `через N дней и время` (максимум `14` дней).
- API `POST /api/v1/chats/:chatId/broadcast` расширен:
  - поддержка `imageEnabled/imageBase64/imageMimeType/imageFileName/sendAt`,
  - лимит фото для рассылки: `1 MB`,
  - `sendAt` поддерживается до `14` дней.
- Для фото в рассылке используется поток MAX Upload:
  - сначала `POST /uploads?type=image`,
  - затем multipart upload на `upload.url`,
  - в `attachments` сообщения передаётся payload upload-ответа.
- Ложный успех рассылки исправлен:
  - для рассылки без таймера отправка идёт синхронно (`immediate`), а не только постановкой в очередь,
  - если отправка не удалась во все целевые чаты, API возвращает ошибку `400`.
- Для фото добавлены ретраи при временной ошибке MAX `attachment.not.ready` (`1.5s`, `3s`, `6s`).
- Увеличен default `JSON_BODY_LIMIT` в API до `6291456` (~6 MB), чтобы проходил JSON payload с base64 фото.

## Nginx и роутинг miniapp (критично)
- HTTP (`:80`) должен редиректить на HTTPS.
- На HTTPS:
  - `/api/` проксируется на `127.0.0.1:3001`.
  - `/app/` проксируется на `127.0.0.1:3000`.
  - `/` редиректит на `/app/` с сохранением query (`$is_args$args`), иначе теряется `init_data`.
  - для webhook должен прокидываться заголовок `X-Max-Bot-Api-Secret` в API.
- Если открывается не из `open_app`, `init_data` может отсутствовать даже при правильном прокси.

## Docker Compose на VPS (актуально)
- VPS переведён на Docker CE + Compose v2 plugin (`docker compose`).
- Не использовать `docker-compose` v1.
- Для обычного прод-режима использовать базовый файл: `infra/docker-compose.yml`.
- Для разделённого/нагрузочного режима использовать `infra/docker-compose.scale.yml`.
- Нельзя одновременно держать поднятыми оба контура (`docker-compose.yml` и `docker-compose.scale.yml`) из-за конфликта порта `3001`.
- При переключении контура сначала делать `down --remove-orphans` у текущего контура.
- В базовом compose на VPS не пробрасываются host-порты `postgres/redis`, чтобы не конфликтовать с уже занятыми `5432/6379` на хосте.
- Историческая ошибка `KeyError: 'ContainerConfig'` относилась к v1; при v2 стандартный путь:
  - `docker compose ... build`
  - `docker compose ... up -d --no-deps --force-recreate <service>`

## Локальная среда (февраль 2026)
- По умолчанию локально выполнять:
  - разработку кода,
  - тесты/сборку через `npm`,
  - git-операции.
- Контейнерные действия (build/recreate/logs через Docker Compose) считать VPS-задачей, пока Docker не установлен локально.
- Если нужен именно локальный Docker-сценарий, сначала предлагать проверить:
  - `docker --version`
  - `docker compose version`
  и только после этого давать локальные docker-команды как основной путь.
- Для локального запуска `postgres/redis` (если Docker появился локально) использовать два файла:
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml ...`

## Актуальность MAX (2026)
- Для вопросов по MAX Bot API / Mini Apps / `init_data` / webhook / `open_app` агент должен сверяться с актуальными официальными источниками MAX, а не с памятью.
- Для приветствий/модерации вступлений обязательно проверять webhook subscriptions (`GET /subscriptions`): в `update_types` должны быть минимум `message_created`, `user_added`, `bot_added` (обычно также `bot_started`).
- Приоритет источников:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- Сторонние сайты использовать только как вторичный контекст; в спорных местах опираться на `dev.max.ru`.
- Если есть риск устаревания, в ответе явно указывать, что информация сверена с актуальной документацией MAX на момент запроса.

## Обязательные шаги после `git pull` на VPS
1. Применить миграции Prisma.
2. Пересобрать только измененные сервисы (`api` и/или `miniapp-static`).
3. Пересоздать контейнеры c `--force-recreate`.
4. Проверить готовность API:
   - сначала локально на VPS: `http://127.0.0.1:3001/api/health/live`,
   - затем через домен: `https://maxim.play-team.ru/api/health/live`.
5. Если задача про модерацию ссылок: проверить `webhook_events` (`status`, `normalized_payload`) и `moderation_events`.

## Правило для команд (обязательно)
- Если действие можно выполнять и локально, и на VPS, агент должен давать **оба варианта**:
  - блок `Локально`
  - блок `VPS`
- Если отличается только путь, показывать обе версии с корректными путями.
- Если команда одинаковая, всё равно явно отмечать, что она применима в обоих окружениях.
- Для docker-команд:
  - первичным считать `VPS`-блок,
  - в `Локально` обязательно предупреждать, что на текущей машине Docker не установлен (если статус не изменился).
- Команды давать как “чистый shell”: не дописывать в конце `✅`/эмодзи/лишние токены, иначе CLI может падать (пример: `TS5042` у `tsc`).

## Git flow для деплоя (обязательно)
- Для задач вида «выкатить изменения» агент должен давать порядок **строго так**:
  1. `Локально`: `git add` -> `git commit` -> `git push`.
  2. `VPS`: `git pull` той же ветки -> обязательные post-pull шаги (миграции, build, recreate, проверки).
- В командах с шаблоном `git push origin <BRANCH>`/`git pull origin <BRANCH>` нужно подставлять реальную ветку (например `main`), не копировать `<BRANCH>` буквально.
- Если пользователь просит «только команды», агент отвечает только командами без длинных пояснений.

## Рекомендуемый короткий сценарий деплоя (основной)
- Локально:
  - `cd /home/yourname/projects/MAXIM && ./infra/scripts/local-commit-push.sh "<COMMIT_MESSAGE>" main`
- VPS:
  - `cd /var/www/Chat_bot && git pull origin main && ./infra/scripts/vps-pull-build-up.sh main`

## Шаблоны команд

### Локально commit/push + VPS pull/deploy (основной сценарий)
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `./infra/scripts/local-commit-push.sh "<COMMIT_MESSAGE>" main`
- VPS:
  - `cd /var/www/Chat_bot`
  - `git pull origin main`
  - `./infra/scripts/vps-pull-build-up.sh main`

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

### Логи API
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `docker compose -f infra/docker-compose.yml logs -f api`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml logs -f api`
  - если нужен фильтр и на VPS нет `rg`: `docker compose -f infra/docker-compose.yml logs -f api | grep --line-buffered -En "<PATTERN>"`

### Проверка webhook subscriptions MAX (вступления/приветствия)
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `set -a; source .env; set +a`
  - `curl -sS -H "Authorization: ${MAX_BOT_TOKEN}" "https://platform-api.max.ru/subscriptions"`
  - `BASE_URL="${APP_BASE_URL%/}"; WEBHOOK_URL="${BASE_URL}/api/webhook/max/${MAX_BOT_ID}/${MAX_WEBHOOK_SECRET_PATH}"; curl -sS -X POST "https://platform-api.max.ru/subscriptions" -H "Authorization: ${MAX_BOT_TOKEN}" -H "Content-Type: application/json" -d "{\"url\":\"${WEBHOOK_URL}\",\"update_types\":[\"message_created\",\"user_added\",\"bot_added\",\"bot_started\"],\"secret\":\"${MAX_WEBHOOK_HEADER_SECRET}\"}"`
- VPS:
  - `cd /var/www/Chat_bot`
  - `set -a; source .env; set +a`
  - `curl -sS -H "Authorization: ${MAX_BOT_TOKEN}" "https://platform-api.max.ru/subscriptions"`
  - `BASE_URL="${APP_BASE_URL%/}"; WEBHOOK_URL="${BASE_URL}/api/webhook/max/${MAX_BOT_ID}/${MAX_WEBHOOK_SECRET_PATH}"; curl -sS -X POST "https://platform-api.max.ru/subscriptions" -H "Authorization: ${MAX_BOT_TOKEN}" -H "Content-Type: application/json" -d "{\"url\":\"${WEBHOOK_URL}\",\"update_types\":[\"message_created\",\"user_added\",\"bot_added\",\"bot_started\"],\"secret\":\"${MAX_WEBHOOK_HEADER_SECRET}\"}"`

### Prisma миграции
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `npm run prisma:migrate:deploy --workspace @maxim/api`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml exec -T api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`

### Полный порядок деплоя (после `git pull`)
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `npm run prisma:migrate:deploy --workspace @maxim/api`
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml build api miniapp-static`
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d --no-deps api miniapp-static`
  - `curl -i http://127.0.0.1:3001/api/health/live`
- VPS:
  - `cd /var/www/Chat_bot`
  - `git pull origin main`
  - `./infra/scripts/vps-pull-build-up.sh main`

### Переключение scale -> base на VPS (если порт `3001` занят)
- `cd /var/www/Chat_bot`
- `docker compose -f infra/docker-compose.scale.yml down --remove-orphans`
- `docker compose -f infra/docker-compose.yml up -d --build --force-recreate api miniapp-static`
- `curl -i http://127.0.0.1:3001/api/health/live`
- `curl -i https://maxim.play-team.ru/api/health/live`

## GitHub авторизация (локально)
- Если при `git push` ошибка `ECONNREFUSED ... vscode-git-*.sock`/`Missing or invalid credentials`:
  - очистить переменные askpass:
    - `unset GIT_ASKPASS SSH_ASKPASS VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_IPC_HANDLE`
- Если SSH даёт `Permission denied ... deploy key`:
  - использовать `HTTPS + PAT` для push, или
  - использовать user SSH key (не deploy key).
- Если нужна авторизация через браузер:
  - установить `gh` и выполнить `gh auth login --web` + `gh auth setup-git`.

## SQL шпаргалка (из этого чата)

### Достать реальные chat_id / user_id из webhook payload
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml exec -T postgres psql -U maxim -d maxim -c "select created_at, coalesce(raw_payload->'message'->'recipient'->>'chat_id', raw_payload->'message'->>'chat_id', jsonb_path_query_first(raw_payload, '$.**.chat_id') #>> '{}') as chat_id, coalesce(raw_payload->'message'->'sender'->>'user_id', raw_payload->'message'->>'sender_id', jsonb_path_query_first(raw_payload, '$.**.user_id') #>> '{}') as user_id, raw_payload->>'update_type' as update_type from webhook_events order by created_at desc limit 20;"`

### Добавить админа в allowlist (после появления чата в `chats`)
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml exec -T postgres psql -U maxim -d maxim -c "insert into chat_admin_allowlist (chat_id,user_id) values ('<CHAT_ID>','<USER_ID>') on conflict do nothing;"`

### Заполнить отсутствующие chat_settings
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml exec -T postgres psql -U maxim -d maxim -c "insert into chat_settings (id, chat_id, updated_at) select md5(random()::text || clock_timestamp()::text), c.id, now() from chats c left join chat_settings s on s.chat_id = c.id where s.chat_id is null;"`

## Чеклист после деплоя
- `api/health/live` отвечает `200` локально и через домен.
- В логах webhook для MAX: `POST /api/webhook/max/...` возвращает `201`.
- Запросы miniapp к `/api/v1/chats` не возвращают `401`.
- Для новых чатов экран `Настройки` не возвращает `404`.

## ENV-синхронизация (критично)
- Значения должны быть корректны и согласованы между MAX Bot и API:
  - `MAX_BOT_TOKEN`
  - `MAX_WEBHOOK_SECRET_PATH`
  - `MAX_WEBHOOK_HEADER_SECRET`
  - `APP_BASE_URL`
- После изменения `.env` обязательно пересоздавать контейнер `api`.

## Диагностика типовых ошибок
- `401 Missing hash in init data`: miniapp открыт без корректного `init_data` (обычно не через `open_app` или потеря query на редиректе).
- `401 Invalid init data signature`: неверная подпись (часто неправильный `MAX_BOT_TOKEN` в API или ошибка алгоритма HMAC).
- `404 Chat settings not found`: старый API без автосоздания настроек или отсутствует bootstrap `chat_settings`.
- `P2021 table does not exist`: не применены миграции Prisma.
- `P1001 Can't reach database server at postgres:5432` при `migrate deploy`: не готов Postgres/не запущен сервис; сначала поднять `postgres`, дождаться `pg_isready`, затем повторить миграции (или использовать `./infra/scripts/vps-pull-build-up.sh main`).
- `webhook_events.status = FAILED` при ссылках: сначала смотреть `error_message` и `docker compose ... logs api`; частая причина — ошибка вызова MAX API удаления сообщения.
- `Failed to send duplicate explanation message` / `Failed to send link explanation message` + `Request failed with status code 400`: обычно неверный формат запроса в MAX API или на VPS запущен старый `api`-контейнер; для `POST /messages` проверить, что `chat_id` идёт в query.
- `Validation Error: Directory .../apps/api/test in the roots[1] option was not found`: старый `jest.config.cjs` с жёстким `roots` на `<rootDir>/test`; обновить конфиг или временно создать каталог `apps/api/test`.
- `TS5042: Option 'project' cannot be mixed with source files`: в команду попал лишний токен (часто `✅` в конце); запускать команду без декоративных символов.
- `rg: command not found` на VPS: использовать `grep -En` или установить `ripgrep` (`apt install -y ripgrep`).
- `502 Bad Gateway` сразу после recreate: часто кратковременно до старта `api`/`miniapp-static`; сначала проверять `curl http://127.0.0.1:3001/api/health/live`, потом домен.
- `curl: (56) Recv failure: Connection reset by peer` на `127.0.0.1:3001`: обычно `api` падает/рестартит, смотреть `docker compose ... logs api` и обязательные ENV.
- `Bind for 0.0.0.0:3001 failed: port is already allocated`: обычно одновременно запущены base и scale контуры; остановить один из них (`down --remove-orphans`) и поднять только нужный.
- `api/health/ready = 503` с `queueLag.ok=false`: накопился старый backlog (`RECEIVED/QUEUED`), часто после нагрузочных прогонов; проверить `webhook_events` и очистить/закрыть stale-события по операционной процедуре.
- `api-enqueue` с `P1017`/`connection pool timeout`: на слабом VPS уменьшить prisma pool (`connection_limit`) и проверить стабильность Postgres.
- `greetingEnabled=true`, но приветствий нет: почти всегда в subscriptions отсутствуют `user_added`/`bot_added`; проверить `GET /subscriptions` и убедиться, что эти `update_types` реально подписаны.
- `POST /api/v1/chats/:chatId/broadcast` возвращает `201`, но сообщение не приходит: вероятно на VPS запущен старый `api` без синхронной отправки/ретраев; обновить контейнер `api` и повторить тест.
- Рассылка с фото не доходит, а в логах MAX есть `attachment.not.ready`: кратковременная готовность upload-вложения; рабочее поведение — автоповтор с задержками.
- Ошибка `413` при рассылке с фото: payload слишком большой; уменьшить фото (ориентир до `1 MB`) и/или проверить `JSON_BODY_LIMIT` в API/Nginx.

## Rollback
### Откат на предыдущий коммит
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `git log --oneline -n 5`
  - `git checkout <COMMIT_SHA>`
  - `docker compose -f infra/docker-compose.yml build api`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps api`
- VPS:
  - `cd /var/www/Chat_bot`
  - `git log --oneline -n 5`
  - `git checkout <COMMIT_SHA>`
  - `docker compose -f infra/docker-compose.yml build api`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate api`

## Нештатные, но не блокирующие логи
- Предупреждение `LegacyRouteConverter` про путь `/api/*` уже наблюдалось; это warning маршрутизации, не причина падения авторизации miniapp.

## Безопасность
- Никогда не вставлять в ответы реальные токены, секреты и init_data целиком.
- В логах/примерах маскировать `Authorization`, `MAX_BOT_TOKEN`, webhook secret path/header secret.
- Если секрет/токен уже утёк в чат/логи, считать скомпрометированным:
  - немедленно ротировать в MAX/GitHub,
  - обновить `.env`,
  - пересоздать затронутые контейнеры (`api` минимум).
