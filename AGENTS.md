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

## Стек и сервисы
- API: NestJS + Fastify + Prisma + BullMQ.
- Miniapp: React + Vite + TypeScript.
- База: Postgres.
- Очереди/кэш: Redis.
- Docker compose services: `api`, `miniapp-static`, `postgres`, `redis`.
- Порты (внутри VPS): `api -> 3001`, `miniapp-static -> 3000`.

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

## Актуальность MAX (2026)
- Для вопросов по MAX Bot API / Mini Apps / `init_data` / webhook / `open_app` агент должен сверяться с актуальными официальными источниками MAX, а не с памятью.
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
4. Проверить health и ключевые эндпоинты.
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

### Логи API
- Локально:
  - `cd /home/yourname/projects/MAXIM`
  - `docker compose -f infra/docker-compose.yml logs -f api`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml logs -f api`

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
  - `docker compose -f infra/docker-compose.yml build api miniapp-static`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps api miniapp-static`
  - `curl -i http://127.0.0.1:3001/api/health/live`
- VPS:
  - `cd /var/www/Chat_bot`
  - `docker compose -f infra/docker-compose.yml exec -T api npx prisma migrate deploy --schema apps/api/prisma/schema.prisma`
  - `docker compose -f infra/docker-compose.yml build api miniapp-static`
  - `docker compose -f infra/docker-compose.yml up -d --no-deps --force-recreate api miniapp-static`
  - `curl -i https://maxim.play-team.ru/api/health/live`

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
- `webhook_events.status = FAILED` при ссылках: сначала смотреть `error_message` и `docker compose ... logs api`; частая причина — ошибка вызова MAX API удаления сообщения.

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
