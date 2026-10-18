# MAXIM: план ускорения и повышения надёжности

Актуализация: **18 октября 2026 года, 10:06 UTC**. Это рабочий план последовательных выпусков; статус реализации, локальной проверки, точного CI и production-приёмки разделён ниже. Исторические измерения сохраняются в [профиле Публика](../../development/publisher-turn-profile.md), [runbook rollup](../runbooks/publisher-occurrence-rollup-noop-rollout.md) и [разборе старых блокировок](../incidents/2026-10-17-ordered-backlog-and-readiness.md).

Цель — уменьшить время от принятой операции до подтверждённого результата и стоимость работы с большими аудиториями. Главный измеренный резерв — повторные полные чтения: локальный профиль для 50k получателей показывает **100k delivery-строк для NOW и 200k для двух targeted quanta**. Это измерение синтетического стенда, а не production p95/p99. Назначения ботов, права, порядок санкций, квоты, журналы и fences неизвестных эффектов сохраняются.

## Что уже сделано и что ещё не принято

| Работа                                            | Реализация и проверки                                                                                                                                                                                                                                            | Production и приёмка                                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader неизменного rollup, default-off            | Написан; локальная парная off/new матрица показывает выигрыш только отдельных maintenance-сценариев                                                                                                                                                              | По последнему сохранённому срезу развёрнут `6f36a148`, ускорение выключено во всех 14 ролях. Выпуск совместимости не является принятым ускорением NOW/доставки |
| **2A0, текущий единственный runtime-этап**        | PR211, `630e2018`: точный CI failed после timeout 50k fixture и пересечения с cleanup; CodeQL успешен. Исправлен жизненный цикл теста; focused PostgreSQL 16/Redis 7: **268/268**, четыре suites, без skips, cleanup завершён. Новая ревизия и её CI ещё впереди | Новый merge/deploy не выполнен; production остаётся `6f36a148`. Локальная проверка не заменяет CI и production-приёмку                                         |
| 5P, callback 3, shutdown 4 и дальнейшие изменения | Запланированы; source review подтвердил callback/shutdown gaps                                                                                                                                                                                                   | Не реализованы и не приняты. Нельзя приписывать им уже достигнутый результат                                                                                   |

Текущие здоровые инфраструктурные samples не закрывают **не менее 65 старых записей карантина**, unknown, отдельные отказы MAX, OCR и неполную живую приёмку. Для 96 старых ordered-кандидатов полнота evidence не доказана; первые семь дали смешанный DENY. Сохранить отказ и fences; следующий шаг — проверенный bounded reader точной формы источника, без replay или исключения отказавших строк. Необъяснённое отклонение локального scheduled/deadline-64 также остаётся открытым; не выбирать только удачные benchmark-ячейки.

## Порядок с максимальным ожидаемым выигрышем

**2A0 → 5P → 3 → 4 → 5A → 5B → 5C → 6 → 7 → 8.** Активен один implementation/release-этап. 5P идёт первым после 2A0: это узкое сокращение ненужного payload с сохранением состава строк, без ожидания нового механизма полноты. Затем два небольших исправления надёжности уменьшают риски перед структурными миграциями. Их номера сохранены для связи с каноническим планом. Согласованные диагностические ступени 2A–2D выпускаются отдельно, когда нужны следующему этапу; полная 2D обязательна до производственного расширения ускоряющих путей.

### 2A0. Закрыть текущий выпуск

Распознаваемый режим `test` отклоняет shortcut **до SQL** и выполняет полный действующий rollup. Четыре недоказанных SQL-кандидата отвергнуты; исходные физические бюджеты и таймауты не ослабляются. Numeric SQL сохраняется, но его включение не разрешается фактом локального теста.

Нативный prerequisite: один owned fixture сохраняет непрерывный insert/delete цикл на 50k и четыре состояния истории, каждое с retained/empty/one cases. Подготовка, вставка, удаление и proofs разделены на конечные последовательные тестовые фазы. Остановка запрещает следующий SQL, а teardown сначала дожидается принятой операции и только затем очищает свои строки. Проверка gate/drain моделирует асинхронную операцию; это не доказательство реальной SQL race. Сохранены 30s Jest, 10s SQL, 15s proof transaction и 45s cleanup. Latency query/index assertions не изменены; они прошли после полного churn на той же disposable базе. Отдельно прошли filtered lifecycle и все семь latency cases на свежих stores: 8 passed, 95 остальных assertions намеренно исключены фильтром; cleanup завершён. Точный CI новой ревизии ещё впереди.

В coalesced warning добавляются только уже вычисленный `isCritical` и доказанный `failureOrigin=local_quota`; остальное остаётся `unlinked/unknown`. Новых await, транспортной корреляции, retry и изменений health/лимитов нет. Завершить точные CI, штатный deploy и приёмку совместимости. **Exposure shortcut в test остаётся нулевым; performance не принят.**

### 5P. Уменьшить payload действующих чтений

Точный scope: **два envelope-select по 4 поля, один delivery-select финализатора по 15 полей**, planner `Pick<sentCount | cycleCount>` и точные inferred-типы callbacks без `any`. Сохранить полные rowsets, predicates, расположение/число запросов, текущий порядок массивов, CAS/lease/deadline/SEND/receipt/unknown и repair reload. Убрать неиспользуемые dialog/post-action JSON. Типы — Prisma select/GetPayload и точные Pick; select-aware doubles возвращают только реально выбранные поля. Миграция, runtime toggle и новый memory framework не нужны.

Сначала focused callers: оба envelope fallback, missing/current-status/occurrence-clamp/nextSendAt/canRetry; finalizer/verification/cancellation, legacy all-null и положительное verification enrollment, pending/quarantine wake, mixed terminal, lost lease/CAS. Успешный NOW не доказывает исполнение fallback-чтений. Добавить небольшие реальные PostgreSQL caller/lease-CAS проверки; прямое равенство reader не заменяет race coverage.

**Native equivalence:** full и реальные projected Prisma reads в одном RepeatableRead snapshot на **64/10k/50k**. Проверить значения, число строк, точную идентичность и исходную последовательность targets без добавления ORDER BY или сортировки сравнения. Реальный SQL отличается только проекцией. В ready fixtures использовать принимаемый действующим parser контекст с 8-KiB сжимаемым padding под фактическим cap 64KiB; измерить pg_column_compression, stored/logical sizes и сообщить наблюдавшийся inline/compressed/external охват, не предполагать TOAST. Большие readpairs выполнить один раз на тех же ready fixtures после timed samples/postconditions и reset вне timing, не создавать вторую большую матрицу.

**Размер результата:** вне всех timed intervals посчитать точный `serializedPrismaResultUtf8Bytes` — UTF-8 длину документированной **row-wise JSON-сериализации реальных полных и projected Prisma результатов**, с одинаковой null/date encoding. Сохранить scalar rows/keys/digest, освободить proof-объекты до следующей ячейки. Это application JSON bytes этих чтений, **не PostgreSQL wire bytes, allocation bytes или размер heap**. Длина конкретного D-массива не измеряет hydration всего turn: **`hydratedDeliveryCount=null` остаётся unknown**.

**Парный runtime-профиль:** одинаковые frozen tooling/payload/order на выпущенном 2A0 baseline и 5P candidate; rollup и temporal selection off. Только **5 cells: ready NOW 64/10k/50k, verification NOW64, deadline64**; один warmup + три measured вызова = **20 calls/arm**. Сохранить семь малых authorization/cancellation/verification controls. Сравнить реальные outcomes, writes/affected rows, исходную action/target sequence по immutable fixture ordinal и receipt linkage. Без повторного full24cell/maintenance/targeted, fresh-Node children, forced GC/`--expose-gc`, heap snapshots, allocation profiler, GC hooks или Prisma proxies. Proposed opt-in `--projection` сначала реализовать и проверить, не выдавать его за существующую команду.

Существующие elapsed/Node CPU, process memory snapshots, sampled RSS/GC/event-loop дают только наблюдавшиеся локальные величины с coverage/gaps. Порядок диагностических readpairs одинаков для двух arms: они влияют на cache/память следующей ячейки. Нет whole-turn hydration/allocations, exact retained heap/peak или leak claims. Пропущенная ячейка/native skip/timeout/teardown gap оставляет приёмку открытой; outliers не удалять. Достаточный результат 5P — те же строки/решения/действия, меньший selected/serialized payload и честно записанные локальные наблюдения. 5P остаётся O(N); CPU/RSS improvement фиксируется только если наблюдается, production p95/p99 или проценты ускорения отсюда не следуют.

### 3. Передавать точный чат в VK callback ACK

Подтверждённый source gap: `VkBotReviewService.answer()` передаёт bot/source, но не `rateLimitEntityId`. Поэтому MAX-клиент использует общий `unknown-target:bot` answer scope, и разные личные диалоги конкурируют в одном fallback. Это подтверждает устройство лимитера, не величину production-задержки.

Передать сохранённый в job **privateChatId**, сохранив bot/source, формулы и ключи лимитов. Не выводить адресат из user/callback ID. Публичный `process` проверяет успех, бизнес-отказ, повторный ACK и отсутствующий чат. Две обработки одного согласования дают два допустимых ACK, но одно действие публикации; отказ ACK не отменяет сохранённое решение. Missing chat не приводит к ACK или выдуманному scope.

### 4. Дожидаться полной операции восстановления комментариев

Подтверждённый source gap: recovery сейчас очищает таймеры, но не участвует в `RuntimeWorkerOwner`; первоначальный scheduled pause-check находится вне `inFlight`.

Синхронно закрыть admission/таймеры; отслеживать всю принятую операцию от pause-check через coordinator до завершения. Стабильный worker adapter дренирует её до закрытия SQL/Redis. Сохранить **5s grace / 9s hard watchdog**. Force close не должен снова ждать бесконечно при module destroy; повторное закрытие идемпотентно.

Проверить shutdown во время первого pause-check, ожидания coordinator и batch; ошибки, повторный close и force. Сохранить существующие coalescing, повторную проверку operator pause, batch=50 и правила marker/authority. Этот этап не восстанавливает потерянный job/контекст и не разрешает unknown SEND.

### 5A–5C. Ограничить повторный рабочий проход порцией

Это основной следующий архитектурный резерв CPU, памяти и latency. Разделить на три выпуска с самостоятельными gates.

- **5A — совместимые readers и инвалидирование.** Добавочные nullable version/seal, producers/readers off. До DDL доказать общий порядок реальных блокировок и охват writers, repair, FK CASCADE/SET NULL. Простой child-trigger с parent UPDATE не принимается без native proof: существующие пути имеют противоположные порядки. Append-only invalidation — кандидат, не выбранное решение. Проверить первый seal, visibility после FK wait, свежий SQL после ожидавшего CAS, races с обоими победителями и off/WAL cost. Не переписывать parent на каждую delivery/lease. Этот reader-compatible выпуск задаёт rollback floor.
- **5B — выдача сертификата новым полным снимкам.** Только атомарно доказанная новая материализация получает уникальный seal token и версию. `existing > 0`, отсутствие envelopes и старая частичная история не доказывают полноту; повторно использованный occurrence не получает новую authority из догадки. Все структурные изменения инвалидируют доказательство. Сохранённая после ACK квитанция не зависит от пригодности seal.
- **5C — bounded automatic ongoing turn.** Вход до полной загрузки targets/envelope JSON. Проверка поддерживаемой версии и текущего token внутри сериализованного claim и progress CAS. Изменившийся token запрещает продолжение. Пустой SKIP LOCKED не разрешает finalize, сертификат состава не доказывает settlement, SQL error не становится empty/success. Manual/repair/recovery/global terminal finish сохраняют полный путь. После SEND/ACK fallback допускает только settlement/recovery, без повторного SEND. Не вызывать O(N) finalizer после каждой непустой порции без отдельного доказательства необходимости.

Сохранить SEND quantum=4, verification budget=50 и final authorization непосредственно перед внешним действием. Внутренний progress не подменяет полные публичные массивы targeted callers.

**Доказательство:** 10k/50k, retained history/skew/stale statistics, locked rows и races revoke/stop/edit/cancel; plans rows×loops, heap fetches/buffers, память/event loop и полная парная runtime-матрица. Малый LIMIT/output не доказывает малое физическое чтение. Первичная материализация, массовая отмена и terminal settlement имеют отдельные бюджеты; bounded turn не обещает постоянной стоимости всей публикации.

### 6. Выбирать готовые задачи по транзакционной readiness-проекции

После bounded turn добавить versioned hints: SEND, receipt verification, blocker recheck, lease expiry и исходный deadline. Каждый writer атомарно обновляет или инвалидирует hint. Это ускоряет поиск; журналы и fresh authorization остаются источником истины и права на SEND.

Сначала сравнить чистые решения старого/нового selector без второго claim или эффекта, затем включать индексную выборку. Отдельно ввести fairness **3 порции ready / 1 recovery**; внутри recovery чередовать receipts и наступившие blocker checks. Свободный бюджет отдавать доступному классу; равные сроки имеют стабильный порядок. Сохранить nextAttemptAt/lease/deadline, одного владельца retry и общий бюджет между workers.

**Доказательство:** старые blockers перед свежей готовой работой, постоянный NOW с расписанием/recovery, contention/WAL, late receipt и потеря Redis после SQL commit; отсутствие голодания и дублей. Не повышать квоты/concurrency, чтобы скрыть дорогие чтения.

### 7. Сохранять durable продолжение комментария

Минимальные version/phase и ссылки на immutable данные записывать атомарно с SQL marker. Outbox relay может дублировать; исполнитель проверяет фазу, ownership, настройки и квитанцию. Известная квитанция завершается без SEND; unknown остаётся под fence, старая история без доказанного контекста — на проверке.

**Доказательство:** добавочная миграция и совместимые readers/rollback floor; SQL commit без Redis job, двойной relay, конкурентные executors, crash до/после MAX ACK и записи receipt, отзыв прав/отмена. BullMQ job ID не гарантирует exactly-once MAX SEND.

### 8. Выделять компоненты вокруг доказанных контрактов

Порядок: Публик selection/preparation/send/settlement → модерация lifecycle/commands/group messages/channel posts → MAX transport/admission/outcomes. Публичные фасады и обязательные зависимости сохраняются; новые границы типизированы. Неполные события и nullable MAX payload закрепить fixtures. Сравнивать чистые решения; внешнее действие исполняет один путь.

Ранний webhook ACK после DELETE-намерения требует отдельного доказательства порядка страйков/санкций и в этот цикл не входит. Перенос монолита, смена брокера или SDK сами по себе не являются доказанным ускорением.

## Обязательный измерительный контур перед расширением

Выпускать малыми самостоятельными частями; новые ссылки получают совместимого reader до writer.

| Ступень        | Необходимое доказательство                                                                                                                                                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A             | Точная явная типизированная связь вызова с HTTP. Повторный Error, успешный HTTP с последующим локальным отказом и coalesced warning не создают ложную причинность                                                                                           |
| 2B / 2C-DELETE | Квитанцию связывает только writer, впервые сохранивший это точное доказательство. Закрытая когорта принятых webhook-источников, immutable UTC bounds; native caps/sentinel/fanout/bytes/TOAST/retention. Квитанции и уникальные intents считаются раздельно |
| **2D-Публик**  | Неизменяемый принятый состав NOW/расписания и source→occurrence→recipient→attempt→receipt, реальное exposure пути. Старые hash/версии mutation и пересозданные delivery IDs не восстанавливают исходный состав; materialization/retention gaps явны         |

Все принятые операции остаются в знаменателе: отказ, отмена, истечение, карантин, unknown и незавершённые/будущие. Исходный приём/deadline не меняется от retry. Отдельно считать first claim, queue/ordering wait, capacity deferral, retry lateness, HTTP и receipt commit; NOW/расписание и текст/изображения/видео. Скорость только завершённых — отдельная метрика. В панели unknown виден явно, автоматический повтор запрещён; IDs и их хеши не используются в metric labels.

**2A0, 2A и даже 2B+2C не открывают 5%/25%/100% Публика.** До 2D и живой приёмки — off и совместимый сконфигурированный test с полным fallback; текущий test-shortcut не имеет exposure. Разработку выключенного совместимого пути можно продолжать. Ingress-когорта не видит непереданные MAX события: отдельно проверять действующие подписки/reconciliation и коррелируемые тестовые источники.

## Выпуск и критерии остановки

Каждый этап фиксируется отдельно: **написано → локально проверено → точный CI → развёрнуто → принято в production**. Affected native/unit и публичные checks выполняются до дорогого broad; повтор broad — при изменённых входах, отказе или новом gap. Требуются успешные **Required и Analyze JavaScript and TypeScript точного target SHA**.

Штатный guarded deploy: свежий baseline → точные зелёные push-main images → синхронизированный VPS SHA → strict smokes/census/immutable component manifest. API-образ обслуживает все 14 ролей и оба native auxiliaries: обновить весь выбранный компонент; unaffected statics наследуют точные baseline source/ref/image. PostgreSQL/Redis не пересоздавать; сохранить очереди, deploy lock, disk floors и соседние проекты. Preload не равен deploy; удалённый `deploy main --plan` не является read-only preflight.

Живая приёмка — в уже разрешённой сессии Публика, только назначенные test chat/channel, со свежей проверкой точного типа и прав бота/человека, маркированным контентом. Повторного разрешения на эту сессию не нужно. Недоступная browser automation оставляет gate открытым; MAX ACK не доказывает видимость в клиенте.

После 2D и test-приёмки: **5% ≥24h → 25% ≥24h → 100% ≥48h**, стабильные группы сущностей. Для каждой ступени нужны ненулевая реальная экспозиция, закрытые когорты всех принятых операций и сравнимая нагрузка. Недостаточная выборка, receipt/retention gaps или пропуски наблюдений означают незавершённую приёмку.

Стоп: новый дубль внешнего действия, неверная санкция, обход прав, потеря квитанции либо ухудшение p95/p99 >10% при сравнимой нагрузке. Сначала безопасно выключить новый путь с проверкой фактических flags; image rollback не меняет dotenv и не доказывает off. Соблюдать rollback reader floor, сохранить deadlines/journals/fences. Unknown не повторять. Очистка очередей, снятие fences или destructive recovery не являются способом добиться зелёного статуса.

Инфраструктура, интеграция MAX и конечный пользовательский результат принимаются отдельно. Старые ordered/quarantine кандидаты требуют ограниченного точного evidence, а не replay; OCR — минимальных monotonic timing/exit facts без повышения timeout/concurrency. Эти диагностические ветки не вытесняют основной этап без доказанного инцидента.

## Актуальные практики, на которых основан план

Свежие первоисточники получены **18.10.2026 00:31:27–00:33:06 МСК**: 21 успешный ответ; TLS timeout не использован. В повторно проверенном корпусе новых контрактных изменений MAX не найдено. SDK v1.0.2 от 8 октября; nullable/incomplete fixes относятся к v1.0.1. OpenAPI SHA `1a4a502fab096aa3a15d83d7ea95667ffb44d2ac`. Установлен Node BullMQ 5.77.6; GitHub latest Rust release не определяет Node-версию. OTel messaging 1.44.0 имеет статус Development.

- [PostgreSQL ordering](https://www.postgresql.org/docs/16/indexes-ordering.html), [EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html), [SELECT](https://www.postgresql.org/docs/16/sql-select.html): доказать физический бюджет; SKIP LOCKED не доказывает полноту. EXPLAIN ANALYZE только на disposable стенде.
- [BullMQ idempotence](https://docs.bullmq.io/patterns/idempotent-jobs), [shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown), [AWS outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): атомарные фазы, at-least-once relay, fencing, drain владельца; timeout не доказывает отсутствие внешнего эффекта.
- [Node event loop](https://nodejs.org/en/learn/asynchronous-work/dont-block-the-event-loop), [worker threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html): сначала убрать широкую hydration; CPU pool — по профилю, обычный SQL/MAX I/O не переносить в threads.
- [MAX messages](https://dev.max.ru/docs-api/methods/POST/messages), [subscriptions](https://dev.max.ru/docs-api/methods/POST/subscriptions), [changelog](https://dev.max.ru/docs-api/changelog-api): сохранить 2 сообщения/с на адресата и текущие project keys; webhook-only изменения прав, nullable events и идемпотентный ingress. Документированного серверного idempotency key для SEND в проверенном API нет.
- [MAX SDK changelog](https://github.com/max-messenger/max-bot-api-client-ts/blob/main/CHANGELOG.md): закрепить nullable/incomplete payloads контрактными fixtures; обновление зависимости требует отдельной необходимости и проверки.
- [OTel messaging](https://opentelemetry.io/docs/specs/semconv/messaging/): связать процесс/попытку/settlement, закрепить версию атрибутов; не смешивать webhook, job и операцию.

Официального подтверждения массового MAX-инцидента в этом корпусе нет; это не опровержение сбоя и не основание выводить его окончание из changelog. Согласованное объявление для пользователей не заменяет техническую диагностику.
