# MAXIM: потребители webhook body и условия безопасного expiry

Статический разбор текущего кода на 1 октября 2026 года дополняет
[план оптимизации](storage-and-bot-cost-optimization-plan-2026-10-01.md), этап P4.
Документ описывает обнаруженные зависимости от `normalizedPayload`, включая
вложенный `raw`. Это карта потребителей для проектирования совместимости,
а не доказанный полный граф production holds и не разрешение удалять данные.
Срок хранения здесь не назначается.

`PROCESSED`, `DUPLICATE`, завершённый BullMQ job и отсутствие новых задач сами
по себе не доказывают, что тело больше никому не понадобится. Часть обработчиков
запускается после завершения webhook; часть использует историю для восстановления.
Существующие execution claims, sessions и ledgers — источники lifecycle, но
проверка универсального body hold не установлена. Поля ссылки на исходный webhook
не всегда являются внешними ключами, поэтому одного обхода FK недостаточно.

## Матрица

Под «удержанием» далее понимается требование будущего P4, если отдельно не сказано,
что текущий потребитель уже работает с независимой компактной записью.

| Потребитель и источник                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Минимальные данные                                                                                                                                                                 | До какого состояния удерживать body или независимую проекцию                                                                                                                                       | Что добавить до expiry                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt → outbox → worker: [WebhookService](../../apps/api/src/webhook/webhook.service.ts), [WebhookOutboxService](../../apps/api/src/webhook/webhook-outbox.service.ts), `findOutstandingMessageQueueWork()` в [WebhookRoutingService](../../apps/api/src/webhook/webhook-routing.service.ts)                                                                                                                                                                                                       | Полное событие для ещё не исполненной подготовки; компактные тип, scope, точная идентичность сообщения/редакции/пакета, порядок и маршрутизация для admission                      | Пока возможны initial admission, retries, timeout quarantine, ordered predecessor, незавершённая подготовка или повторная материализация job                                                       | Versioned envelope; отдельный body reader; indexed проекции всех JSON predicates; atomically durable handoff/hold до подтверждения исходного события. Сохранить старейшую/свежую долю admission, порядок внутри чата и CAS                          |
| Canonical execution, timeout/shadow settlement: `prepareExecution()`, `completeExecution()` и settlement в [WebhookCanonicalExecutionService](../../apps/api/src/moderation/webhook-canonical-execution.service.ts); standby recovery в [ModerationService](../../apps/api/src/moderation/moderation.service.legacy.ts)                                                                                                                                                                              | Семантическая идентичность, exact owner/mirror, expiry/lease и equality proof; для исполнения — событие                                                                            | До завершения всех execution/shadow claims, recovery/quarantine и зависимых mirror settlement. Terminal receipt тоже может быть источником сравнения                                               | Персистентная versioned semantic identity и доказанное equivalent сравнение; owner/mirror references; retain dedup/claims отдельно от тела. Missing/expired body не должно превращаться в «owner отсутствует» и разрешать повторный эффект          |
| Общая модерация, callbacks, media/forward extraction: [ModerationUpdateExtractors](../../apps/api/src/moderation/moderation-update-extractors.ts), [MaxCallbackUpdate](../../apps/api/src/moderation/max-callback-update.util.ts), [PrivateControlMarkupImporter](../../apps/api/src/moderation/private-control-markup-importer.ts), [WebhookSemanticEventKey](../../apps/api/src/webhook/webhook-semantic-event-key.ts)                                                                             | Подлинные sender/recipient/message/callback, авторство, event/edit time, package identity, nested forward, markup и transferable attachments                                       | До завершения исполнения и handoff всех зависимых задач. Одной нормализованной строки текста недостаточно                                                                                          | Fixtures-equivalence для raw variants; отдельная компактная metadata projection там, где это доказано. Не использовать message creation time вместо edit time, не терять markup/forward/media identities                                            |
| Photo duplicate: `processPhotoDuplicateJob()` в [PhotoDuplicateModerationService](../../apps/api/src/moderation/photo-duplicate/photo-duplicate-moderation.service.ts), [PhotoAttachmentExtractor](../../apps/api/src/moderation/photo-duplicate/photo-attachment-extractor.ts)                                                                                                                                                                                                                      | Complete logical photo album; точные message/time/author/package/photo identities и execution bot                                                                                  | Обработчик специально ждёт `PROCESSED`; удерживать от admission до durable analysis/result/notice/delete handoff и окончания recovery, либо перенести весь необходимый source в независимую запись | Durable source reference/hold до enqueue; повторная материализация после Redis loss; exact source-equivalence перед освобождением; reverse references из jobs и baselines, включая delayed/failed/recovery                                          |
| Message duplicate media: `loadSource()` и анализ baseline в [MessageDuplicateMediaService](../../apps/api/src/moderation/message-duplicate/message-duplicate-media.service.ts), [MessageDuplicateService](../../apps/api/src/moderation/message-duplicate/message-duplicate.service.ts)                                                                                                                                                                                                              | Исходное и baseline media, text/forward content, exact media identity и freshness                                                                                                  | Пока source либо baseline нужен новой оценке, retry, source refresh или delete proof. Удаление самого job не доказывает неиспользование baseline                                                   | Durable source/baseline projection, явное release при supersession/окончании reference, equivalence hashes и exact author/package binding; проверять обратные ссылки, а не только возраст receipt                                                   |
| Commercial OCR и image stop-list: `loadSource()` и `loadCompletedSemanticOwner()` в [CommercialOcrModerationService](../../apps/api/src/moderation/commercial-ocr/commercial-ocr-moderation.service.ts)                                                                                                                                                                                                                                                                                              | Фото/package/source identity, semantic owner, human authorship и фиксированные admission/policy proofs                                                                             | После `PROCESSED` ещё выполняются admission, analysis и guarded deletion. Удерживать source и найденного completed owner до завершения всей цепочки либо durable независимого evidence             | Hold/source projection для queued/admitted/retrying job и completed semantic owner; сохранить native sandbox identity и exact authorization. Не переносить OCR текст в jobs, БД или метрики                                                         |
| Publisher forward import: `loadPersistedForwardReceipt()` в [PublisherPostImportProcessingService](../../apps/api/src/admin/publisher-post-import-processing.service.ts), [PublisherPostImportService](../../apps/api/src/publisher/publisher-post-import.service.ts)                                                                                                                                                                                                                                | Exact Publisher/session/actor/private recipient плюс вложенное forwarded message, markup и медиа                                                                                   | До capture/processing/recovery session и durable content/assets/result proof. Persisted receipt является предпочтительным источником                                                               | Session → body hold; release только после durable materialization либо проверенного terminal cancellation/expiry. Поздний exact-message GET — fallback, а не гарантия восстановления nested forward                                                 |
| Publisher auto-reply authoring: `loadPersistedReceipt()` в [PublisherAutoReplyContentCaptureService](../../apps/api/src/publisher/publisher-auto-reply-content-capture.service.ts), [PublisherAutoReplySourceFenceService](../../apps/api/src/publisher/publisher-auto-reply-source-fence.service.ts)                                                                                                                                                                                                | Exact Publisher/actor/session/message, raw content/format/media; cancellation source fence отдельно                                                                                | До durable content revision/assets и завершения capture/recovery; сохранить absorbing cancellation proof независимо от body                                                                        | Session source hold; atomically capture/release; separate body lifecycle from source fence. Удаление `WebhookEvent` каскадно удаляет execution claims, поэтому compact proof должен переживать body expiry и сохранять запрет отменённого источника |
| Publisher suggestion/private-dialog delivery recovery: [ChannelSuggestionDeliveryRecovery](../../apps/api/src/admin/admin-channel-suggestion-delivery-recovery.ts), [PublisherSuggestionAdminRecoveryService](../../apps/api/src/admin/publisher-suggestion-admin-recovery.service.ts), `findLatestPrivateChatRoutesForUser()` в [AdminService](../../apps/api/src/admin/admin.service.legacy.ts)                                                                                                    | Exact bot, actor, private route, authenticated activity type/time и её связь с failed terminal delivery                                                                            | В течение существующего recovery lifecycle, пока более поздняя private activity ещё может разрешить exact delivery recovery. SENT/AMBIGUOUS ledger не сбрасывать                                   | Компактная durable private-activity/route projection с теми же временными и exact-bot predicates; заменить JSON readers. Сохранить separately limited literal branches/keyset/partial-index parity                                                  |
| Publisher binding/access history: `observeWebhook()` и `recoverHistoricalActorCandidates()` в [PublisherEntityBindingLifecycleService](../../apps/api/src/publisher/publisher-entity-binding-lifecycle.service.ts)                                                                                                                                                                                                                                                                                   | Точная Publisher принадлежность, event/actor/entity/source version, type и handshake evidence                                                                                      | До durable actor candidate/observation и завершения нужного исторического покрытия; body можно заменить доказанно эквивалентной compact evidence                                                   | Persist evidence atomically на ingress/processing; bounded resumable backfill и watermark; не путать номинацию кандидата со свежим MAX подтверждением bot/user access                                                                               |
| Reports и ручная recent-message cleanup: `scanHistory()` в [ReportExecutionService](../../apps/api/src/moderation/reports/report-execution.service.ts), `observeEdit()` в [ReportSubmissionService](../../apps/api/src/moderation/reports/report-submission.service.ts), `findRecentTrackedMessageIds()` в [AdminManualMessageCleanupService](../../apps/api/src/admin/admin-manual-message-cleanup.service.ts)                                                                                      | Для истории — compact chat/author/message/type/source/creation times и стабильный cursor; для edits — content version/hash; для counter recovery — exact authored message evidence | До завершения scan/materialized actions и связанных retry/delete intents; будущий report/manual action ещё может читать существующее продуктовое окно истории                                      | Индексируемая tracked-message projection с exact window/cursor semantics; durable edit/counter evidence до acknowledgement. Не требовать полного raw тела ради простого списка message IDs и не сокращать продуктовое окно неявно                   |
| Message retention: [ReadRetentionCapture](../../apps/api/src/message-retention/message-retention.policy.ts), [CaptureRetentionMessage](../../apps/api/src/message-retention/message-retention-capture.ts), [MessageRetentionDeleteGuard](../../apps/api/src/message-retention/message-retention-delete-guard.service.ts)                                                                                                                                                                             | На admission нужны authenticated human author, exact recipient/message и creation time. Далее candidate/policy/activation/intent — compact records                                 | Raw нужен до durable capture решения. Проверенный later delete guard читает candidate, policy и intent, а не webhook body                                                                          | Доказать атомарный admission/acknowledgement и отсутствие альтернативного body-dependent recovery. Не удерживать raw на весь delay только из-за retention после независимого capture; сохранять policy, activation и dispatch guards                |
| Discovery, display names и ownership repair: [ManagedEntityCandidateSyncService](../../apps/api/src/admin/managed-entity-candidate-sync.service.ts), `resolveUserDisplayNames()` в [AdminService](../../apps/api/src/admin/admin.service.legacy.ts), [LocalAdminContactDisplayNameQuery](../../apps/api/src/moderation/local-admin-contact-display-name.query.ts), `loadWebhookRepairSignals()` в [MaxBotOwnershipFoundationService](../../apps/api/src/max/max-bot-ownership-foundation.service.ts) | Compact event allowlist, user/chat/bot, entity type/title, name, source event/time и freshness/tie-break                                                                           | Пока отсутствующая или неполная read model требует historical JSON fallback                                                                                                                        | Durable read-model watermark/repair; bounded backfill parity; заменить все fallback readers, сохраняя event allowlist и индексируемые predicates. Equal name не разрешает потерять более свежий observedAt                                          |
| Закрытый dashboard: `readWebhookStatusMetricsByTypes()` в [QueueMetricsService](../../apps/api/src/system/queue-metrics.service.ts)                                                                                                                                                                                                                                                                                                                                                                  | Compact type/status/time/role, без тяжёлого raw                                                                                                                                    | Полное тело не требуется после равнозначной проекции                                                                                                                                               | Перенести type predicates на compact projection; health/readiness оставить на lightweight indexed lag path, не добавлять dashboard fanout в health                                                                                                  |
| Исторические операторские tools: [AuditCommercialFilter](../../apps/api/src/scripts/audit-commercial-filter.ts), [RepairKaravanStorefrontRelays](../../apps/api/src/scripts/repair-karavan-storefront-relays.ts)                                                                                                                                                                                                                                                                                     | Audit corpus требует content; relay repair требует exact source/author/forward evidence                                                                                            | Только явное review/export/repair удержание, если оно реально требуется. Само наличие исторического tool не доказывает бесконечную необходимость body                                              | Явное поведение `body expired/unavailable`, совместимый архивный reader либо предварительный ограниченный capture. Нельзя считать expired data пустым контентом, восстанавливать send из догадки или незаметно заявлять полный corpus               |

Дополнительные ingress observers, например
[PublisherStartQueue](../../apps/api/src/publisher/publisher-start.queue.ts) и
[PublisherVkBotReviewQueue](../../apps/api/src/publisher/publisher-vk-bot-review.queue.ts),
извлекают raw start/callback evidence и формируют компактные intent/job envelopes.
Для них нужно доказать durable handoff и recovery до освобождения source; факт
формирования компактного job сам по себе не гарантирует сохранность при Redis loss.
В частности, Publisher start сначала сохраняет intent в PostgreSQL и только затем
обращается к Redis — это полезный существующий lifecycle boundary.

## Additive prerequisites

1. Ввести versioned envelope и независимый body reference с явным состоянием
   unavailable/expired. Сначала добавить dual readers/writers и проекции, сохраняя
   старые колонки. Изменить SQL JSON readers до переноса или сжатия их источника.
2. Сохранять компактную semantic/order/identity projection atomically с receipt.
   Сравнить старые и новые результаты на webhook variants, callbacks, edits,
   human/bot authorship, forwarded markup, media albums и mirrored events.
3. Создавать durable hold до acknowledgement/admission зависимого потребителя.
   Владельцем должен быть конкретный lifecycle owner с проверяемой release
   операцией; состояния failure, ambiguous send и quarantine требуют своего
   решения. Возраст hold без подтверждения завершения owner недостаточен.
4. Проверять reverse references из SQL sessions/claims/baselines/ledgers и из
   recoverable jobs, включая ссылки без FK. Job завершён, а durable source ещё
   используется — допустимое состояние, которое expiry обязан учитывать.
5. Перед expiry повторно проверять terminal receipt плюс отсутствие holds,
   активных claims/recovery/references в той же защищённой операции. Сериализовать
   новое admission/hold против этой операции. Отдельно сохранять dedup и
   side-effect proofs: missing body не разрешает повторное исполнение.
6. Сначала подтвердить свежий isolated restore, затем проверить readers,
   retries/recovery и отсутствие потерянного source на восстановленной копии.
   Документировать rollback floor: каждый допускаемый к откату runtime должен
   понимать новый body layout/expired marker. Количество сохранённых образов
   не является доказательством reader compatibility.
7. Запускать сначала bounded indexed dry-run/canary с resumable cursor,
   rate/batch/time budget и pause при ухудшении readiness/lag/I/O/free space.
   Не сканировать полноразмерный JSON для каждого expiry кандидата. Считать
   eligible/held/missing/expired/released отдельно и обезличенно.

Meaningful gates: PG races между admission/hold/release/expiry, worker crash
между SQL и Redis, retry после restart, terminal owner/mirror recovery, source
supersession и cancellation, restore parity, rollback reader compatibility.
Существующие suites дают базовую семантику, но не проверяют ещё не реализованный
body expiry: `webhook-outbox-postgres`, `webhook-canonical-execution`,
`photo-duplicate-moderation.integration`, `message-duplicate-media`,
`commercial-ocr-moderation`, `publisher-post-import-processing`,
`publisher-auto-reply-content-capture`, `publisher-entity-binding-lifecycle`,
`admin-channel-suggestion-delivery-recovery-postgres`, `reports-postgres`,
`message-retention-delete-guard` и `publisher-start-postgres`.

## P1: что измерять перед уменьшением фоновой работы

Outbox опрашивает DB каждые 200 ms; live receipts и due retries не имеют доказанного
durable ingress → enqueue wakeup. Увеличение интервала меняет latency. Успешно
enqueued=0 может означать ordered blockers, delayed work, quarantine или ошибку,
а не idle. Нужны wakeup плюс safety polling и согласованная граница latency.

Delete reconciler раз в секунду последовательно выполняет ancillary recovery и
due sweep. Для будущих delete intents не создаётся delayed BullMQ wakeup;
DB sweep остаётся частью гарантии исполнения. Recovery возвращает восстановленные
источники, не scanned candidates; ошибки отдельных candidates могут быть обработаны
внутри фазы. В первую очередь измерять реальные вызовы/результаты/duration.
Indexed bounded ancillary existence probe рассматривается только после проверки
планов/выгоды и с сохранением fast due sweep.

Activity уже обновляется только для более нового event time; debounce без durable
watermark/recovery теряет последний тихий event при crash. Простая агрегация max-time
меняет folding title: старое событие с title не должно подменять title текущей строки,
если новое событие title не содержит. Lifecycle/type/bot/title изменения требуют
отдельных сохраняемых границ. Display-name observedAt и deterministic source-event
tie-break нельзя пропускать только из-за равного name.

Конструктор dedicated admin read Prisma client ещё не открывает соединения:
adapter создаёт pool в `connect()`. Потребители включают private critical/realtime
flows и action refresh. Role-routing или lazy constructor без actual pool/use/latency
метрик не доказывают экономию и могут перенести тяжёлые reads в moderation pool.

## Семантика добавленных fixed phase метрик

`deleteReconciler` использует существующий process `startedAt`, отчёт раз в 30 секунд
и TTL 90 секунд; tick не обращается к Redis. Отсутствие provider/report — отсутствие
покрытия. Фазы фиксированы, сохраняются calls/succeeded/errors и bounded monotonic
duration buckets. `tickCalls` включает overlapping calls; `skippedInFlight` показывает
пропуски из-за существующей защиты от параллельного запуска.

`returnedCount` — сумма числа, возвращённого успешно завершившейся фазой:

- `staleSendFences`: сумма возвращённых affected-row counts четырёх guarded
  statements, включая восстановленные fallback replies и quarantined fences.
- `replacementRecovery`: успешно обработанные recovery sources по текущему
  контракту; это не число scanned candidates и не доказательство отсутствия pending.
- `dueSweep`: число выбранных due IDs, включая кандидатов с неуспешным queue handoff.
- `retainedPurge`: сумма returned delete statement counts завершившейся purge фазы.

Это результаты операций, не отдельный счётчик committed transactions. Частичные
эффекты до exception не представлены возвращённым числом. `errors` показывает
ошибки, вышедшие из фазы; внутренние подавленные candidate errors здесь не считаются.
Нулевая сумма не означает idle и не используется для изменения cadence.
