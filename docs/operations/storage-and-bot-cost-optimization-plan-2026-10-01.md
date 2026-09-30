# MAXIM: сокращение расходов на хранение и ускорение ботов

Дата: 1 октября 2026, Москва. Замеры: 30 сентября 21:36–21:42 UTC,
то есть 1 октября 00:36–00:42 MSK. Статус: исследование и план;
изменения production, удаление данных и новые облачные расходы не выполнялись.

## Вывод

Есть две разные причины расхода: постоянный рост событий PostgreSQL и
накопление независимых слоёв релизных Docker-образов. Основная группа данных —
webhook receipts/execution claims, а не новые видео. Отдельная проблема
производительности — многократные UPDATE служебного состояния: WAL, индексы,
vacuum и временные сортировки потребляют I/O даже при небольшом росте файлов.

Лучший порядок: ограничить стоимость релизов → уменьшить новые записи и
повторную работу → восстановить резервирование → разделить доказательства,
активную работу и тяжёлые тела → управлять историей → физически освободить место.
Сокращение облачного счёта требует последующего уменьшения выбранной мощности
или миграции на меньший диск; сама очистка SSD на 330 ГиБ его тариф не меняет.

## Что измерено

Все цифры размеров далее — ГиБ, если явно не указано «ГБ Docker».
PostgreSQL audit читает каталог/статистику, не сообщения. Ограниченные queue/activity
audit, Docker inventory и низкоприоритетные проверки файловой метадаты были
только читающими. Тексты SQL, сообщений, ошибок заданий, токены и полный env
не сохранялись. Контент медиа не выгружался.

| Объект                                |               Текущий размер | Значение для плана                                                |
| ------------------------------------- | ---------------------------: | ----------------------------------------------------------------- |
| Root filesystem                       | 319,01; доступно около 25,47 | После увеличения диска до 330; запас всё ещё ниже цели 40         |
| Public relations PostgreSQL           |                       250,41 | Основной потребитель, включая индексы и TOAST                     |
| `webhook_events`                      |                       118,74 | Receipt/outbox и полное normalized body, главный приоритет        |
| `webhook_execution_claims`            |                        20,18 | Доказательства semantic execution, не произвольный мусор          |
| `audit_logs`                          |    19,64, из них TOAST 19,10 | Исторический product/media payload; нужны классификация и перенос |
| `moderation_events`                   |                        11,58 | События и индексы; lifecycle отличается от лент                   |
| `max_action_ledger`                   |                         9,16 | Fences повторных/неоднозначных внешних действий                   |
| Ленты moderation + membership         |                        15,49 | Производная история без общего согласованного TTL                 |
| `publication_assets`                  |                         6,44 | Реальные материалы; новый видео-путь уже `bytes=null`             |
| `managed_entity_local_activities`     |                         6,25 | 5,54 приходится на индексы, частые refresh timestamps             |
| `vk_parsing_posts`                    |                         2,37 | Размер почти стабилен, но UPDATE-нагрузка высокая                 |
| Public indexes без TOAST indexes      |                       104,27 | Уже включены в 250,41, не прибавлять второй раз                   |
| Public TOAST с собственными индексами |                        45,95 | Тоже уже включён в общий размер                                   |
| Docker images                         |   30,29 ГБ Docker, 43 образа | До новых релизов: 23,07 ГБ и 32 образа                            |
| BuildKit directory, физически         |                         1,48 | Видимые 14,13 ГБ cache разделяют данные с образами                |
| WAL directory                         |                         1,00 | Сгенерированный WAL за окно не равен этому размеру                |
| Redis volume                          |                         1,23 | RDB/persistence и временная вторая копия требуют резерва          |
| Все Docker log files                  |                   около 0,09 | Rotation уже настроен, не главный источник роста                  |
| `/var/log`                            |                         1,09 | Ограниченная дополнительная экономия                              |
| `/var/www`                            |                         0,78 | Старые source releases уже убраны, не основной объём              |
| Cold available                        |                       210,01 | Полный restore текущей базы сюда не помещается с запасом          |

Проверка PG `base` измерила 2 945 обычных файлов, около 250,48 ГиБ allocated;
лимит 10 000 не превышен. Это метадата файлов, не scan данных.
PostgreSQL temp в момент проверки — 0; открытые удалённые обычные файлы —
только 4 КиБ. Больших новых core dumps не найдено. `du` всего containerd
не успел в 20 секунд и остановлен; полная физическая сверка root не заявляется.
Docker, BuildKit, compressed blobs и unpacked snapshots пересекаются:
их суммы нельзя складывать как независимые потребители.

### Рост и работоспособность

- За 24,66 часа public relations выросли на **5,61 ГиБ**. Линейный пересчёт
  этого единственного окна — около 5,46 ГиБ/сутки, это наблюдаемое среднее,
  не доказанный устойчивый темп и не прогноз заполнения.
- Из прироста: webhook events +3,59 ГиБ; claims +0,56; publication assets +0,17.
  Исторический audit log почти не вырос: +0,006 ГиБ. Он большой, но текущий
  рост расхода не следует объяснять только медиа.
- После расширения root с 33,03 до около 25,47 ГиБ свободно примерно за девять
  часов. В интервале были релизы и очистка: это не чистый рост данных БД.
- В Docker появились пять API образов, созданных 30 сентября между 14:08 и
  20:33 UTC. Каждый занимает около 1,54 ГБ в verbose inventory, из них около
  1,36 ГБ unique. Рост inventory образов около 7,22 ГБ показывает отдельный
  источник расхода, но точного разложения каждого байта потери root пока нет.
- В сопоставимом DB/WAL окне 14:50–21:36 UTC: temp writes +34,78 ГиБ,
  WAL generated +55,70 ГиБ. Это объём записи, не накопившиеся файлы. WAL —
  cluster-wide; одному writer нельзя приписывать весь объём.
- PostgreSQL restart 30 сентября 11:57 UTC разорвал прежние счётчики. DB reset
  timestamp остаётся NULL, WAL reset изменился. Старые и новые operation rates
  не смешиваются. Сбросы отдельных отношений отдельно не аттестованы;
  приведённые ниже cumulative UPDATE служат сигналом, не точным счётчиком
  конкретной функции. Небольшие `n_live_tup` после сбоя не дают размера строки
  или доказанного процента bloat.
- Сейчас оба ready успешны, ingress queue lag 0, все 14 API roles на точном
  образе, без duplicate/unexpected roles и pause owner. В минутном action
  snapshot 1 111 successes, 0 failures. Это короткое окно, не недельный SLO.
  Fixed queue audit: RECEIVED=1, QUEUED=0, FAILED≥2 000 с saturation; oldest
  failed около 30 дней. Не считать этот lower bound точным total или стирать
  timeout quarantine для улучшения счётчика.
- VM: 8 CPU, около 23,47 ГиБ RAM, доступно около 12,81. Короткий sample:
  I/O utilization 87%, CPU iowait 10,8%, load 4,05. Диск заслуживает внимания;
  по одному sample нельзя утверждать постоянное насыщение или выбирать новый
  размер VM.

## Что уже выполнено

Повторно не включать в обещанный выигрыш:

1. Одинаковый prepared webhook JSON не переписывается;
   [webhook-payload-write.ts](../../apps/api/src/webhook/webhook-payload-write.ts).
2. VK upsert переиспользует существующие TOAST значения при равном payload.
3. Новые Major/Pub suggestion images хранятся в media relation, не в audit JSON.
4. Новые Publisher видео идут browser → MAX и сохраняют exact-bot token,
   `bytes=null`; новые envelopes ссылаются на content revision, не клонируют фото.
5. Client photos уже reencode/resize; asset dedupe по actor+SHA256 уже есть.
6. Docker rotation, limited pool/concurrency/governor и split roles уже существуют.
7. Оба age-only receipt cleaner выключены; это сохраняет доказательства и
   увеличивает удержание, но не ошибка, которую нужно исправить одним флагом.

Runtime inspection: completed cleanup=false; failed cleanup отсутствует в env
и false по schema default. Отсутствующее значение не выдаётся за override.

## Приоритетный план

### P0. Восстановить резерв и измерить стоимость релиза — 1–2 дня

**Низкорисковый выигрыш в ближайшее время — images, не DELETE БД.**

Read-only manifest-aware preview с cutoff 24h нашёл семь незащищённых refs:
четыре API, два miniapp и один admin. Шесть current/retained manifests защищают
12 image IDs. Сумма displayed unique для кандидатов ориентировочно 5,6 ГБ
Docker; физический `df` выигрыш измеряется после apply, не обещается заранее.
Стандартный cutoff остаётся 7 дней. Переход к 24h — выбранная maintenance
политика после review, с сохранением минимум пяти manifests и всех container
refs. В этой работе только preview, ничего не удалялось.

Даже ориентировочная экономия кандидатов дала бы около 31 ГиБ root, ниже
цели 40. Поэтому она не считается достаточной ёмкостью для большого rewrite.
Недостающий резерв и временная restore площадка должны получить отдельный
измеренный бюджет; рост рабочей БД нельзя компенсировать только image GC.

Для дальнейших релизов:

- После green smokes формировать protected inventory и освобождать только
  подтверждённые старые MAXIM refs вне этого множества. Reclaim/apply держит
  shared deploy lock, повторно проверяет inventory. Другие проекты имеют своих
  владельцев/locks; blanket Docker GC не вводится.
- Публиковать счётчики `root before/load/after/reclaim`, bytes по immutable
  image и shared/unique слоям. Делить рост DB, релизные пики, RDB временную
  копию и обычное использование. Сохранять enum operation, не secret/env.
- Сохранять локально пять подтверждённых rollback releases; не снижать этот
  минимум ради экономии. Более ранние релизы восстанавливать только при
  наличии проверенного off-host artifact и полной release provenance.
- Большие сборки выполнять на CI. Exact-SHA preload уже есть; он снижает пик
  build на VPS, но импорт нового полного слоя всё равно занимает место.

**P0b: reuse dependency layers.** CI сейчас использует чистый runner и
`buildx --load` без `cache-from/cache-to`
([ci.yml](../../.github/workflows/ci.yml), build step). `npm ci` и COPY production
node_modules выполняются вновь, хотя lock неизменен
([Dockerfile](../../apps/api/Dockerfile), prod-deps/COPY). Наблюдаемые unique
1,36 ГБ на API release согласуются с отсутствием reuse, но layer DiffIDs надо
сверить до утверждения точной причины.

Добавить доверенный BuildKit cache per component/dependency inputs на CI;
ключ включает lock, manifest, pinned base/platform и trust scope. Fork/PR cache
не должен заменять cache, используемый для main production. Проверить, что
два source-only API изменения при одинаковых dependencies получают одинаковые
dependency layer DiffIDs. Не удалять OCR native libraries из общего образа:
его attestation и rollback contracts действуют для всей fleet.

Приёмка: неизменность exact-SHA CI/image labels/manifest checks; меньшие unique
байты двух следующих релизов, green OCR/14-role smokes. Цель эксперимента:
source-only прирост image storage хотя бы вдвое ниже текущего; это не прогноз.
Rollback — отключить cache reuse, сохранив immutable refs и защиту releases.

### P1. Сократить повторную работу и UPDATE — 3–5 дней

Начать с fixed operation counters, иначе невозможно доказать, какой writer
создаёт WAL. Метрики: inserts/changed updates/skipped updates, lease
check/renew, posts fetched/unchanged, bytes prepared/cache, source/lane/class,
duration buckets. Никаких raw SQL, payload, user/chat/token labels.

**1. Conditional lease renewal — высокий приоритет.**

`assertLeaseForExternalCall()` всегда renew; timer делает то же каждые lease/3.
`renewLease()` меняет indexed expiry
([moderation-delete-intent.service.ts](../../apps/api/src/moderation/moderation-delete-intent.service.ts),
методы около 5321–5378). С restart intents получили около 1,56 млн UPDATE,
из них HOT только 166. Это не доказательство, что все UPDATE — heartbeat.

Сохранять DB-authoritative token/status/deadline check перед каждым внешним
вызовом; renewal budget учитывает admission/rate-limiter wait, подготовку,
предшествующие guards и bounded transport timeout + margin. На финальной
границе реального dispatch повторно проверить владение/срок и при
необходимости продлить: ожидание слота не должно израсходовать lease.
Случай «владеем, продление не нужно» должен возвращаться read result, без
self-assignment UPDATE. Coalesce timer/external checks; не заменять SQL fence
локальным кешем. Тестировать steal, expiry, pause, crash, DB latency, долгий
MAX call и двусмысленный timeout. Rollback — старый renewal protocol.

**2. VK: head sync и content-change writes.**

`fetchLatestPosts()` проходит минимум три страницы по 100 даже при найденном
cursor на первой странице
([vk-sync.service.ts](../../apps/api/src/admin/vk-sync.service.ts), около 304–343).
Upsert снова меняет `last_seen_at` и `updated_at`; первый индексирован
([vk-parsing-post-import.repository.ts](../../apps/api/src/admin/vk-parsing-post-import.repository.ts),
около 469–490). После restart: 2,35 млн UPDATE, HOT около 3,1%, 310 autovacuum,
при почти неизменном размере таблицы. TOAST reuse решает не все записи.

Разделить source freshness и изменение post content. Быстрый head page для
новых постов + более редкая bounded глубокая проверка старых правок/удалений;
период выбирать из продуктового edit-discovery SLO. Не пропускать pending
schedule fingerprint, receipt finalization и manual edits. Freshness,
потребляемую cleanup/discovery, перенести на источник/компактное состояние
либо обновлять по проверенному watermark, а не потерять простым skip UPDATE.
Метрики: updates на один реально изменившийся post, VK calls/sync, edit
discovery delay, source recovery. Цель: ≥50% меньше unchanged post updates на
пилоте без пропущенных новых/edited posts; окончательный результат измерить.

**Граница первого выпуска.** В реализуемую сейчас часть P1 входят точный
no-op guard в upsert и обезличенные счётчики. Guard пропускает только повтор
того же наблюдения с теми же эффективными назначениями, включая `seenAt`;
обычный следующий sync сохраняет новую свежесть поста и продолжает UPDATE.
Равный content hash не позволяет пропустить изменившиеся raw counters или
CDN URLs. Ручные правки, сброс missing/error состояния, активные publication
fences и прежний охват минимум трёх страниц сохранены. Выигрыш сейчас
ограничен долей точных повторов; цель ≥50% меньше обычных unchanged updates
относится к следующему этапу. `rowsWritten` считает строки успешных SQL
statements; последующий rollback транзакции этот счётчик не отменяет.
`rowsSkippedOrFenced` объединяет no-op и publication fences. Доли и скорости
сравнивать только в сопоставимых окнах процесса.

Следующий этап требует компактного observation state и совместимого выпуска
readers для feed/import lag, сверки доступности и читателей `updatedAt`.
Сначала добавить projection и dual read/write без изменения прежних
freshness semantics, проверить parity и rollback на isolated restore после
P3. Прекращать обновление legacy freshness можно лишь после перехода всех
потребителей и установки проверенного rollback floor: выбранные rollback
releases должны понимать projection либо иметь проверенный путь возврата
legacy freshness. Наличие пяти старых образов само по себе такую
совместимость не обеспечивает. Migration, cutover и head/deep sync в первый
выпуск не входят; head/deep отдельно требует тестов старых правок/удалений,
bounded recovery и измеренного edit-discovery SLO.

**3. Убрать лишний rollup массив пользователей.**

Trigger одновременно пересобирает `affected_user_ids` через concat/DISTINCT
и пишет нормализованные user/hour rows
([migration](../../apps/api/prisma/migrations/20260524120000_optimize_stats_read_models/migration.sql),
около 168–193). Текущий dashboard читает hours
([logs-dashboard-rollups.ts](../../apps/api/src/admin/logs-dashboard-rollups.ts)).
После проверки внешних consumers новая миграция прекращает обслуживание
старого массива; колонка пока остаётся. Повторный user/hour conflict может
использовать DO NOTHING, если freshness не имеет читателя. Не редактировать
старую migration. Проверить exact users/hour/counters/replay на PG16.

**4. Coalesce local activity и display-name refresh.**

Activity writer уже отбрасывает одинаковое/старое event time, но записывает
каждый следующий event; три индекса затрагивают `last_event_at`
([webhook.service.ts](../../apps/api/src/webhook/webhook.service.ts), около 1964–1998).
Coalesce maximum event timestamp в коротком bounded окне, immediate flush
metadata/lifecycle changes, durable recovery при crash. Это read-model
freshness, не право доступа: membership/access epochs обновлять по прежнему
авторитетному протоколу. Display-name сохраняет самый свежий verified event,
не допускает older overwrite. Метрики: perceived cabinet freshness и
updates/event, а не только число SQL calls.

**5. Независимые recovery cadences и idle backoff.** Outbox tick каждые 200 ms,
reconciler запускает несколько recovery sweeps каждую секунду
([webhook-outbox.service.ts](../../apps/api/src/webhook/webhook-outbox.service.ts),
[moderation-delete-intent-reconciler.service.ts](../../apps/api/src/moderation/moderation-delete-intent-reconciler.service.ts)).
Пустым recovery классам дать bounded backoff с jitter; due/interactive work
имеет быстрый wakeup и периодический safety poll. Отдельные class cadence,
fairness/aged reserve, persisted due time и cursor исключают starvation и
потерю wakeup после crash. Приёмка: scan calls/empty tick, bounded worst-case
recovery delay, crash/resume/ordering tests. Замедлять все очереди одним
таймером нельзя. Active/delayed jobs и quarantine не сокращать ради размера.

Приёмка P1: сравнимый workload по типам событий минимум сутки после каждого
canary; новые no-op counters, WAL/event, I/O, temp writes и настоящая latency
API/действий. Queue lag не выдаётся за request latency. Rollback каждой
ветки независимый; отсутствие новых повторных sends/sanctions обязательно.

### P2. Меньше памяти, Redis bytes и повторных uploads — 3–5 дней

**Compact chat context.** Полный `settings:true`, включая base64 bot media,
уходит в Redis и local Map; Map не имеет byte cap и чистит истёкшие entries
только при повторном обращении
([chat-context-cache.service.ts](../../apps/api/src/chat-context/chat-context-cache.service.ts),
около 2267–2322, 2688–2762).

Runtime context оставить компактным, медиа загрузить по immutable reference
при отправке; byte-budget LRU и bounded expiration sweep. Revision/CAS,
in-flight loads и access epoch сохранить, epoch map не чистить произвольно.
Для producer/consumer раскатки нужен dual reader; миграция historical media
не требуется для первого compact projection. Метрики: cache weight/RSS/GC,
Redis transfer bytes, RDB size, settings freshness, misses на hot workload.

Первая безопасная раскатка сохраняет полный Redis `chat:context:v3` и все
поля settings/media: текущие consumers используют inline images для notices.
Добавлены byte-budget LRU и независимый от hot LRU updates bounded expiry
sweep. Начальные defaults — 128 МиБ estimated retained bytes на процесс,
128 МиБ на запись, 2048 entries, sweep 128 entries каждые 5 секунд. Это proxy
удерживаемых данных, не RSS. Максимальное стандартное изображение
6 000 000 binary bytes (8 000 000 base64 characters) вместе с settings
остаётся кешируемым, включая контекст с тремя такими notice images
(около 48 МБ estimated bytes). Общий бюджет процесса остаётся 128 МиБ;
лимит записи не превышает его, а пользовательский меньший cap сохраняется.
Oversized context возвращается полностью через Redis/DB. Снижать caps после
canary только по hit/miss, oversized skips,
capacity evictions и RSS/GC при сопоставимых окнах. Compact reference
projection остаётся отдельным шагом с совместимыми readers.

**Durable upload cache по asset+точному боту.** Notice images повторно upload;
Publication кеширует только внутри occurrence. Применить существующий протокол
Publisher auto-reply upload cache: lease/CAS, exact-bot marker, fallback
reupload после token rejection
([bot-speech-media.service.ts](../../apps/api/src/moderation/bot-speech-media.service.ts),
[publisher-auto-reply-delivery.service.ts](../../apps/api/src/publisher/publisher-auto-reply-delivery.service.ts)).
Оригинальные bytes пока сохранить. Выигрыш — MAX requests/трафик/latency,
не обещание удаления ГиБ. Нельзя переиспользовать tokens между ботами.

Notice upload cache в первой раскатке **не активирован**. Его blocker —
`BotSpeechMediaService` возвращает только opaque `imagePayload` до durable
send handoff; queued notice не сохраняет immutable asset owner/reference
и не возвращает attachment rejection в upload service. Для следующего
шага нужен immutable asset с точным владельцем, исходными bytes и checksum,
плюс exact-bot key/marker, lease/CAS/TTL, короткое ожидание с fallback fresh
upload. Выполняющий send компонент должен после однозначного attachment
400/422 атомарно снять собственный dispatch fence, инвалидировать только
использованную версию upload cache и один раз повторно подготовить те же
bytes для того же бота. Timeout, 408, 5xx и неопределённый результат сохраняют
AMBIGUOUS и запрещают автоматический resend. Route failover требует
повторной подготовки для нового exact bot; исходные bytes пока сохраняются.
Одного checksum+bot без owner недостаточно: token не разделяется между
владельцами. Образец протокола — Publisher auto-reply durable assets и его
`clearDefinitiveSendFence`; добавление Redis token cache только в upload
service не обеспечивает этот recovery gate.

**Binary path и byte admission.** Убрать внутри backend цепочку
bytea → base64 → Buffer; использовать typed binary/reference adapter,
ограничить общий размер одновременной media preparation
([admin-managed-broadcast-media-runtime.ts](../../apps/api/src/admin/admin-managed-broadcast-media-runtime.ts)).
Сохранить external contracts, порядок images и legacy video cap.
Orphan direct-upload token cleanup делать ниже приоритетом: `sizeBytes` —
размер удалённого видео, при `bytes=null` он не является расходом PostgreSQL.

**Pools по роли.** Primary caps в Compose суммарно 52. Однако AdminModule
imported во всех ролях, constructor AdminService создаёт дополнительный read
client: по умолчанию 2, у admin 6
([app.module.ts](../../apps/api/src/app.module.ts),
[admin.service.legacy.ts](../../apps/api/src/admin/admin.service.legacy.ts), около 983–1042).
Теоретическая сумма при использовании всех клиентов — до 84, это не число
фактически открытых connections. Сначала instrument/role-scope lazy read
client, затем решать о pool size. Не поднимать concurrency для скрытия I/O.

### P3. Свежий backup и isolated restore — обязательный gate

**Результат первого attended запуска.** Штатный watched stream от 30 сентября
22:09 UTC автоматически остановлен примерно через 48 минут: readiness/queue
watchdog отклонил состояние, задержка достигала около 13 секунд. Временный
зашифрованный файл удалён штатно; завершённой новой копии и restore нет.
После остановки bounded audit не показал backup backend, ready вернулся,
наблюдаемая задержка снизилась примерно до 0,3 секунды. Это не устанавливает
единственную причину задержки. Автоматического повторного dump нет;
historical mutation/rewrite по-прежнему закрыты. Следующая попытка требует
здорового окна и повторного capacity/queue preflight после снижения write load.

В осмотренном `/mnt/maxim-cold/backups/maxim` четыре dump за 24–27 августа;
последний 27 августа. Не исключены другие внешние копии, но доказательств
свежей проверенной полной копии в доступной цепочке нет. Backup/restore
services inactive; прежний watched backup был отменён при росте lag и не
создал полноценного backup. Старый local restore проверяет лишь старый архив.

Перед historical UPDATE/DELETE/DROP/rewrite:

1. Выбрать проверенное отдельное место backup и disposable restore. Свободных
   210 ГиБ cold меньше current DB около 250 ГиБ; штатный restore floor
   `125% DB + 2 GiB` требует примерно 315 ГиБ даже до размещения нового dump.
   Это нижняя оценка по public size, точный gate использует database size.
2. Attended, rate-limited backup с shared lock, unique application cleanup,
   независимым queue/space watchdog. Не запускать полный dump автоматически
   на единственном primary под I/O pressure. Сам план бэкап не запускает.
3. Проверить checksum, полноценный restore и приложение с отключёнными
   outbound dispatch; оценить RPO/RTO и recovery старых queues/ledgers.
4. После backup согласовать recovery intents с фактическими внешними
   receipts: restore БД не должен автоматически повторить старые sends.

Для этого можно использовать ранее проверенный локальный host либо временную
изолированную площадку. Это вариант отдельной стоимости, не обязательный
постоянный кластер. Старые backups не удалять до новой проверенной цепочки.

### P4. Разделить active state, body и proof — 1–2 недели

**Сначала совместимость, затем expiry.** Normalized webhook содержит полное
`raw` для практически каждого события; sampling относится только ко второй
raw-колонке
([webhook.parser.ts](../../apps/api/src/webhook/webhook.parser.ts), около 76;
[webhook.service.ts](../../apps/api/src/webhook/webhook.service.ts), около 834).

Матрица `field → reader/SQL predicate → required stage → retention hold`:
callbacks, nested forward, markup/mentions, photo/package identity, Publisher
receipt import, display names, reports, access/discovery, retry/repair.
Dual reader old/new; compact envelope содержит индексируемые поля, versioned
body — исходные данные без повторных полноразмерных копий. Эквивалентность
подтвердить fixtures и bounded in-memory shadow compare. Opaque compression
без замены SQL raw readers недопустима. TOAST LZ4 тестировать на restore;
policy для новых значений не переписывает старые автоматически.

Архитектура следующего этапа:

- Компактная долговечная dedup/semantic identity, неизменяемое terminal proof.
- Малая таблица активного outbox/lease/quarantine, token CAS/DB transactions.
- Тяжёлое versioned body с независимым lifecycle.
- Продуктовые feeds/assets с отдельными ownership/retention rules.

Изменение индексов только после паспорта `query → plan → invariant` и
representative clone plans. Active partial indexes могут уменьшить стоимость
изменений, но due/recovery/deadline predicates обязаны их использовать.
Не удалять индекс из-за одного нулевого scan count после restart.

Body expiry требует terminal status плюс отсутствие durable holds от
незавершённых/ambiguous/pending задач и replacements исторических readers.
Горизонт dedup включает retry, late delivery, replay, backup/restore;
7/14/30 дней для body и 90/180/365 для history — только варианты для решения,
не включённые TTL. Старый receipt DELETE каскадирует claims и не проверяет
эти условия: включать его ради свободного места нельзя.

Runner: indexed keyset, small sequential batches, fixed source budget,
dry-run counts/reasons → canary → apply, eligibility/CAS recheck in transaction;
pause on readiness/lag/I/O/space thresholds. Expired-body marker должен быть
понятен всем readers; missing proof нельзя трактовать как новое событие.
Сначала новые записи, затем historical backfill, без общей UPDATE всей БД.

### P5. Продуктовая история и старые медиа — 1–2 недели после P3/P4

**Feeds и агрегаты.** Event cleanup не удаляет независимые feed rows; INSERT
triggers не обслуживают DELETE. Отдельная policy: короткая online детализация,
долгие compact aggregates и необходимые sanction/report/access proofs.
Последний BAN/UNBAN, active report и membership canonical replay keys сохранять.
Удаление membership feed key может дать повторный rollup increment при replay.
Current sanction-history cleaner уже умеет special superseded cases; не
подменять его generic TTL. Измерить доли по возрасту на restore, а не по
неполным top lists или сброшенной статистике.

**Historical audit media.** Классифицировать fixed product actions и consumers,
backfill old JSON → существующая media relation через checksum/ownership/CAS.
Atomic reference + bytes, parity legacy reader, hold active claims. Audit
19,64 ГиБ — верхний размер всей таблицы, не объём гарантированно удаляемых фото;
base64→bytea не обещает 25% из-за TOAST. Физический выигрыш измерить отдельно.

**Settings/polls и orphan assets.** Сначала не переписывать равные большие
JSON/media на text-only edits, затем общий typed reference format. GC asset
делает reverse-reference/owner/claim checks, finite authoring grace, race test
bind-versus-delete. Dedupe bytes по допустимому ownership; metadata caption,
filename/order belongs to link, MAX token belongs to exact bot.

Вынос originals на cold — только если clone measurement докажет существенную
выгоду. Требуется immutable content addressing, fsync/atomic publish, CAS
reference, path validation, checksum и совместный restore DB+assets. Это
перенос между оплачиваемыми дисками, не автоматическое уменьшение общей платы.
CDN/Object Storage/app2 paused и не включаются в базовый вариант.

### P6. Физическое освобождение и настройка PostgreSQL

DELETE/UPDATE делают место переиспользуемым, но обычно не увеличивают `df`.
Обычный VACUUM не заменяет rewrite. После P3 и измерения clone: выбрать
маленькие объекты для staged index rebuild/repack, бюджет новой копии + WAL

- concurrent growth + reserve; одна операция, bounded locks, health watchdog,
  tested rollback/recovery. Для webhook ~119 ГиБ имеющихся 25 ГиБ недостаточно
  для обычной полной копии. `VACUUM FULL` на единственном primary не первый шаг.

Equivalent membership index group — около 313 МиБ один объект, не 100 ГиБ.
Можно убрать только после dependency/recovery review и свежего restore.
Снижение 104 ГиБ индексов не обещается целиком: многие обслуживают safety и
статистику. Логический restore создаёт компактные объекты и даёт ориентир
минимального размера, но не сохраняет исходный bloat. Его фактическая оценка
требует отдельно разрешённого ограниченного измерения исходных страниц либо
физической копии; dead-row estimates не переводятся в reclaimable bytes.

**Memory/checkpoints — отдельный эксперимент.** `shared_buffers` действительно
128 MB, `max_wal_size` 1 GB, shm 512 MB; stateful containers не имеют memory cap.
Audit `work_mem=1MB`/parallelism=0 forced только для audit session: это не
effective app setting. Сначала инструментировать временные операции/планы на
clone, проверить фактические session settings и общие memory budgets.
Предметный вариант: тестировать buffers 1–2 ГиБ с большим shm, checkpoint/WAL
budget и адресным session work_mem для измеренных операций. Это гипотеза,
не готовые production values; buffers/recreation требуют maintenance/recovery.
Не умножать work_mem только на число connections и не увеличивать глобально
для всех queries/parallel workers. После снижения write load повторить sizing.

**Partitions — поздний этап.** Начинать с отделённого append-only body/feed,
когда measured retention оправдывает detach/drop. PostgreSQL uniqueness на
partitioned table зависит от partition key; receipt/claim global identities
оставить отдельно. Partitioning текущих keys без этой модели ломает dedup.

## Экономика и критерии завершения

Точные рубли не вычислялись: фактические тарифы billing account не получены.
Для решения фиксировать текущую стоимость и применить:

| Изменение                                | Что уменьшает                          | Когда влияет на счёт                                                                 |
| ---------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| Reuse layers + bounded releases          | Рост/пики root, repeated image pulls   | Сразу снижает потребность в следующих расширениях                                    |
| Fewer lease/VK/rollup writes             | WAL, I/O, CPU, queries и backup writes | Позволяет позже пересмотреть VM/disk performance                                     |
| Compact context + exact-bot upload cache | RAM/Redis/RDB, MAX uploads/traffic     | После проверки peaks и повторного sizing                                             |
| Body/history lifecycle                   | Рост DB, backup/restore duration       | После reclaim можно мигрировать на меньшую ёмкость                                   |
| Уменьшение существующего диска           | Оплачиваемые GiB                       | Только через поддержанный провайдером путь; обычно новая меньшая VM/disk и migration |

Savings/month = removed paid GiB × фактический GiB-month тариф + изменение
VM/traffic тарифа − стоимость временной migration/backup площадки и новых
операций. Не считать физическую очистку уже выделенного диска снижением тарифа.
Сначала остановить рост; уменьшать RAM/CPU или disk performance при текущем
I/O сигнале без peak data нельзя. Single VM/cold disk не заменяют HA/независимый
backup; новый постоянный кластер ради этой задачи не предлагается.

Целевые gates, выбираемые для программы, а не утверждение текущего результата:

- ≥40 ГиБ root после нормального release/RDB цикла; floor для новой API build
  остаётся 20 ГиБ, static 6 ГиБ. Эти floors не являются steady-state целью.
- Не менее семи суток точечных/непрерывных наблюдений с явно указанным покрытием,
  peak и release cycle; post-maintenance comparable windows отдельно.
- Основной queue lag p95 ≤1 с, p99 ≤5 с по continuous samples — предлагаемые
  критерии; отдельные real operation/request p95/p99 обязательны.
- Ни одной новой duplicate/ambiguous dispatch regression; pending work,
  user history и privacy/bot ownership не потеряны.
- P1 canary показывает хотя бы 30% уменьшения измеренных лишних write/call
  операций, normalized by equivalent workload. Нет обещания 30% всей БД.
- Проверенная свежая backup/restore цепочка и измеренные RPO/RTO; GC не
  включается без этого и доказанного retention/replay horizon.

## Выполнение и проверка

Предлагаемые независимые PR: (1) operation metrics + release layer reuse;
(2) conditional renewal; (3) incremental VK; (4) rollup trigger compatibility;
(5) compact context/upload cache; (6) body/proof readers/projections;
(7) holds/expiry runner; (8) history/media backfill и physical maintenance.
Ранние PR можно вести параллельно, destructive этапы зависят от P3/P4.

Runtime/API changes: focused tests, PG16 races/query plans на clone,
`check:api`/`check:prisma`/infra по scope, exact-SHA CI, image preload/deploy всех
14 shared roles, protected queue fence и scoped smokes. Stateful service
перезапуск не входит в обычный API deploy. Никаких массовых live тестовых
отправок или повторов ambiguous jobs. Docs-only план deploy не требует.

P7 продолжается до 6 октября 21:00 UTC в прежнем режиме только диагностики.
Новая постоянная cleanup automation сама этим документом не разрешается.

**Поправки после проверки исполнения.** Due-intent polling нельзя замедлять
одним общим idle backoff: future `nextAttemptAt` не получает немедленный
wakeup, а sweeper обеспечивает deadline/lease и Redis-loss recovery.
Outbox delivery сохраняет прежние 200 мс; ноль recovered rows сам по себе
не доказывает отсутствие работы, потому что включает skips/errors.
Coalescing activity/display-name требует durable watermark и crash recovery:
максимальная метка события без metadata ordering может перезаписать более
свежее название старым. Эти изменения не включаются без доказательства
эквивалентности и recovery bound. Создание Admin read client не равно
открытому pool: соединения уже ленивые. Его используют также worker/private
bot paths; ограничение только ролью admin может перенести нагрузку в
moderation primary pool и не является безопасной экономией.

Источник текущих метрик: локальные обезличенные JSON в
`outputs/maxim-deep-storage-2026-10-01/` этого чата. Исторические окна —
`outputs/maxim-capacity-week/`. Эти одноразовые operational artifacts не
коммитить в репозиторий. План дополняет предыдущий
[storage plan](vps-storage-optimization-plan-2026-09-29.md) и учитывает уже
[внедрённую первую стадию](storage-implementation-stage1-2026-09-29.md).
