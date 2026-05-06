# MAXIM: подробное описание проекта

## 1) Назначение

`MAXIM` — это монорепозиторий для модерации чатов в MAX и управления правилами через Mini App.
Проект состоит из:

- backend API (прием webhook, модерация, действия в MAX API, админ-методы),
- frontend miniapp (панель управления чатами и правилами),
- общей контрактной библиотеки типов/схем.

Ключевая продуктовая идея: события из MAX принимаются быстро, складываются в outbox, асинхронно обрабатываются и приводят к модерационным действиям (удаление сообщений, warn/kick/ban, сервисные сообщения бота).

## 2) Структура монорепо

- `apps/api` — NestJS + Fastify + Prisma + BullMQ.
- `apps/miniapp` — React + Vite + TypeScript.
- `packages/contracts` — общие Zod-схемы и типы для API/miniapp.
- `infra` — compose-файлы, nginx-конфиг, deploy-скрипты.
- `docs` — эксплуатационные и архитектурные заметки.

## 3) Backend (API)

### 3.1 Технологии и рантайм

- NestJS на Fastify (`/api` global prefix).
- Prisma + Postgres.
- BullMQ + Redis:
  - очередь `moderation` для обработки webhook-событий,
  - очередь `moderation-actions` для действий в MAX API.
- Ролевой режим процесса через `APP_ROLE`:
  - `all`, `ingress`, `enqueue`, `moderation`, `action`.

### 3.2 Основные модули

- `WebhookModule`:
  - `POST /api/webhook/max/:botId/:secretPath`,
  - проверка route signature + header secret,
  - rate limit,
  - парсинг payload в нормализованный формат,
  - запись в `webhook_events` со статусом `RECEIVED`.
- `WebhookOutboxService`:
  - периодически забирает `RECEIVED/FAILED/stale QUEUED`,
  - ставит задачи в `moderation` queue,
  - меняет статус на `QUEUED`,
  - делает retention cleanup старых записей.
- `ModerationModule` / `ModerationService`:
  - загружает контекст чата и настройки,
  - применяет rule engine,
  - выполняет санкции и пишет `moderation_events`/`violations`.
- `MaxModule` / `MaxClientService`:
  - обертка над MAX API (`/messages`, `/chats/.../members`, `/uploads`, `/chats`),
  - per-chat/global rate limit,
  - circuit breaker,
  - dispatch в очередь действий или immediate execution.
- `AdminModule`:
  - `v1` endpoints для miniapp: чаты, настройки, события, allowlist, blacklist, автопостинг.
- `AuthModule`:
  - `InitData` guard валидации подписи miniapp-авторизации.
- `SystemModule`:
  - queue metrics,
  - режимы `normal/degrade` (auto/manual).
- `HealthModule`:
  - `GET /api/health/live`,
  - `GET /api/health/ready` (db + redis + queue lag threshold).

### 3.3 Поток webhook -> модерация

1. MAX шлет webhook в `WebhookController`.
2. Проверяются:
   - URL-подпись (`botId`, `secretPath`),
   - заголовок `x-max-bot-api-secret` / `x-max-secret`.
3. `WebhookParser` нормализует payload.
4. `WebhookService` сохраняет событие в `webhook_events`.
5. `WebhookOutboxService` enqueue-ит событие в очередь `moderation`.
6. `ModerationProcessor` вызывает `ModerationService.processWebhookEvent`.
7. В зависимости от правил и контекста:
   - удаление сообщения,
   - предупреждение,
   - kick/ban,
   - служебные сообщения бота (объяснение/приветствие и т.п.).

### 3.4 Важная логика по `bot_started`

Сейчас реализовано:

- `bot_started` нормализуется в synthetic message (`messageId = bot_started:<updateId>`),
- в `ModerationService` есть отдельная ранняя ветка:
  - для личного чата отправляется инструкция:
    `Перед запуском mini app нажмите кнопку open_app в чате с ботом.`
  - для группового чата инструкция не отправляется.

## 4) Miniapp

### 4.1 Авторизация и запуск

- Miniapp ожидает `init_data` и отправляет его в API как:
  - `Authorization: InitData <...>`.
- При отсутствии `init_data` показывается состояние с подсказкой запускать из MAX через `open_app`.
- Дополнительно есть fallback-чтение `init_data`:
  - query/hash/bridge (`window.WebApp`, `window.MAX.WebApp`).

### 4.2 Экраны

- `Чаты`:
  - список доступных чатов, поиск, быстрые переходы.
- `Настройки`:
  - модерация ссылок + allowlist доменов,
  - приветствие,
  - фильтры (нецензурная лексика, коммерция),
  - дубли сообщений,
  - ограничения сообщений (анти-спам, длина, медиа),
  - ночной режим,
  - автопостинг (текст/кнопка/фото/таймер/цикл),
  - дополнительные опции (удаление сообщений бота, remove bots, global blacklist).
- `Логи`:
  - последние модерационные события с фильтрами.

### 4.3 Кнопка `open_app`

В вашем проекте текст кнопки `open_app` в UX/шаблонах используется как:

- `Открыть` (дефолтное имя кнопки в настройках и шаблонах сообщений).

Это зафиксировано в:

- Prisma defaults для `*_bot_button_text`,
- `packages/contracts` (`botButtonTextSchema` default),
- miniapp placeholders/состояниях формы.

## 5) Контракты и валидация

- `packages/contracts` содержит Zod-схемы:
  - `chatSettingsSchema`,
  - запросы/ответы admin API,
  - `maxUpdateSchema`.
- Backend и miniapp используют общий контракт, чтобы снизить рассинхрон.

## 6) Данные (Postgres)

Ключевые таблицы:

- `chats` + `chat_settings`,
- `chat_admin_allowlist`,
- `domain_allowlist` (с `remove_after_at`),
- `global_user_blacklist`,
- `webhook_events` (state machine для ingestion/outbox),
- `moderation_events` и `violations`,
- `audit_logs`.

## 7) Инфраструктура и деплой

### 7.1 Compose-режимы

- Базовый контур: `infra/docker-compose.yml`
  - `api`, `miniapp-static`, `postgres`, `redis`.
- Локальный оверлей: `infra/docker-compose.local.yml`
  - host-порты для `postgres/redis`.
- Scale-контур: `infra/docker-compose.scale.yml`
  - `api-ingress`, `api-enqueue`, `api-moderation`, `api-action`.

### 7.2 Nginx

- `:80` -> redirect на HTTPS.
- На HTTPS:
  - `/api/` -> `127.0.0.1:3001`,
  - `/app/` -> `127.0.0.1:3000`.

### 7.3 Деплой-скрипты

- `infra/scripts/local-commit-push.sh`:
  - commit/push,
  - проверка, что при изменении Prisma schema добавлена migration.
- `infra/scripts/vps-pull-build-up.sh`:
  - `git pull`,
  - подъем `postgres/redis`,
  - ожидание `pg_isready`,
  - `prisma migrate deploy`,
  - rebuild/recreate выбранных сервисов,
  - health-check локально и через домен.

## 8) Безопасность и эксплуатационные правила

- Не хранить реальные токены в репозитории.
- Webhook endpoint защищен route secret + header secret.
- Miniapp auth валидируется по подписи `init_data` через `MAX_BOT_TOKEN`.
- Для стабильности под нагрузкой:
  - outbox + queue,
  - rate limit MAX API,
  - circuit breaker,
  - auto degrade mode по lag/error-rate.

## 9) Практический итог

Проект уже построен как production-oriented модерационный контур:

- быстрый прием webhook,
- асинхронная обработка,
- масштабирование по ролям,
- единые контракты API/UI,
- админский miniapp для оперативного управления правилами.

И отдельно важно для UX в MAX:

- запуск miniapp должен идти через кнопку `open_app`,
- отображаемое имя этой кнопки у вас: `Открыть`.
