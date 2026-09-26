# Публик: надёжность публикаций, аудит и реализация

## Цель и границы

Разобрать жалобы на пропущенные посты по этапам: сохранение намерения, материализация
расписания, готовность получателей, исполнение, подтверждение MAX и восстановление.
Проверяются NOW, ONCE, SLOTS, RECURRENCE, VK autopublish, медиа и Publisher isolation.
Исходная база: `5325e10b`, runtime `9796f27b`. Это риск-ориентированный аудит;
отсутствие всех возможных дефектов не обещается.

Никаких массовых retry, очистки очередей, копирования прав Major в Publisher,
изменения политик публикации или повторной отправки AMBIGUOUS. Данные постов, токены,
имена и идентификаторы не экспортируются в отчёт. Пользовательские изменения в API
AGENTS и историческом incident-документе сохраняются.

## Подтверждённые находки

### P1. Неверная Prisma-проекция блокирует подготовку webhook Публика

`ReplacementAttachMarkerStore.claim` использовал общий `select` для
`ChannelAutoPostAttachMarker` и `ChatAutoCommentAttachMarker`, включая `linkType`.
У модели чата этого поля нет. Универсальный delegate принимает `unknown`, поэтому
проверка TypeScript и старые mock-based тесты пропускали ошибку.

Production-журнал содержит 14 последовательных `prisma_validation` ошибок из
`WebhookService` на строке 888 с повторами 2/4/8/16/32/64/128/256 секунд.
В точном compiled runtime эта строка вызывает PublisherChatCommentProducer.
Реальный сгенерированный Prisma-клиент локально воспроизвёл
`Unknown field linkType ... ChatAutoCommentAttachMarker` до обращения к SQL.
Отдельная регрессия сначала упала на прежнем коде, а после исправления прошла.

Последствие выходит за пределы комментариев: ordered predecessor удерживает новые
события, oldest queue lag включает глобальную деградацию, а Publication materializer
и фоновые отправки соблюдают governor pause. При повторной проверке были readiness 503,
lag около 28 минут и живые PostgreSQL/Redis. Нельзя чинить это снятием ordering fence.

Исправление: отдельные проекции, проверяемые через generated Prisma types, плюс
проверка реального Prisma query compiler для обоих видов маркеров с безсетевым
адаптером. Канальные forward/edit guards, dispatch fences и CAS не изменяются.

Источники: `apps/api/src/moderation/replacement-attach-marker.store.ts`,
`apps/api/src/publisher/publisher-chat-comment-producer.service.ts`,
`apps/api/src/webhook/webhook.service.ts`.

### P1. Часть расписаний заблокирована проверкой автора, а не транспортом

В ограниченной выборке журналов за 30 минут было 799 предупреждений
`PUBLISHER_ACTOR_ACCESS_REQUIRED`. Последующая выборка отнесла предупреждения к шести
публикациям и 77 запускам. Это не число уникальных потерянных сообщений.

Новый read-only каталог обнаружил в ограниченном срезе 32 SCHEDULED запуска с этим
blocker: 28 SLOTS и 4 RECURRENCE, с активными расписаниями и публикациями. В объединённой
выборке текущих и исторических состояний были как `publisher_user_not_admin`, так и
готовые метаданные получателей. Уточнённая группировка по состоянию запуска и lifecycle
показала: все 148 выбранных target slots текущих SCHEDULED относятся к просроченному
`publisher_user_not_admin`; `metadata_ready` относится к историческим состояниям.
Это повторяющиеся target slots, не 148 уникальных каналов. Сам первый отчёт не доказывал,
что старый отказ всё ещё соответствует правам в MAX. После восстановления очереди
повторный срез показал те же причины уже с `edge_unexpired=true`: штатная перепроверка
обновила отказ. Нужна проверка прав автора, а не принудительный retry отправки.

Код ACTOR_ACCESS объединяет недоступную/просроченную авторизацию, подключение,
отсутствующий каталог и выключенную политику. Повтор каждые 60 секунд сам по себе не
устраняет эти состояния. Свежий подтверждённый отказ должен сохраняться; исправление
не может выдавать доступ по существованию старой публикации.

### P2. Есть разрыв восстановления полностью отсутствующей access edge

`PublisherReadinessService.requestActorAccessRefresh` может номинировать публикацию
без actor edge. `PublisherBindingRefreshService.resolveCandidateVersion` при отсутствии
edge бросает `PublisherCandidateRefreshSupersededError`, который processor завершает
без проверки MAX. Нужна versioned pending candidate до постановки такой проверки,
без выдачи GRANTED и без перезаписи свежих grants/denials. Требуется отдельная регрессия
на всю связку номинации и worker, а не только проверка вызова enqueue.

Статус: воспроизведено совместным тестом реального producer и worker. Исправление
создаёт под блокировкой Chat только versioned `BOT_DENIED/UNKNOWN` pending candidate,
повторно проверив точный активный Publisher binding. Конкурентные grants/denials не
перезаписываются; Redis вызывается после commit. При сбое Redis существующий bounded
candidate recovery подхватывает pending-запись. MAX проверяет бота и человека до GRANTED.
Тот же механизм применён к ручной перепроверке сохранённых получателей публикации,
после проверки владельца публикации. Ручная постановка остаётся доступной при выключенном
dispatch; worker отложит проверку до включения. Для существующей edge сохраняется версия.
Текущая production-выборка не доказывает, что именно этот дефект объясняет наблюдаемые
ACTOR_ACCESS блокировки.

### P2. Ошибка получателя и неопределённая отправка требуют разных действий

В выборке были AMBIGUOUS и FAILED с сохранённым remote message ID. Наличие FAILED не
означает, что MAX не получил сообщение. Старые неоднозначные доставки не сбрасываются
и не повторяются. Существующие receipt-first recovery, sender identity и exact-presence
проверки сохраняются. Отдельные VK enqueue warnings также требуют классификации,
а не снятия настроек source/quiet-hours/лимитов/ручной проверки.

## План реализации

| Порядок | Работа                                                                      | Приёмка                                                                                                                  | Статус                                                                          |
| ------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 1       | Ограниченная production-диагностика по публикациям, получателям и доставкам | Индексы до исполнения; не более 32 запусков на статус и 8 targets/deliveries на запуск; нет текста и IDs в выводе        | Реализовано, локально проверено и синхронизировано                              |
| 2       | Исправить Prisma-проекцию, вызывающую глобальные задержки                   | Регрессия падает до исправления; реальные generated-client запросы чата/канала валидны; queue backlog сходится без purge | Выпущено: `b4fef123`; backlog сократился, strict smokes прошли                  |
| 3       | Проверить восстановление доступа и точность blocker                         | Missing candidate номинируется под lifecycle/version fence; свежий DENIED не становится GRANTED без MAX                  | Выпущено: `1adf9525`; automatic/manual nomination и safety tests                |
| 4       | Проверить NOW/расписания/recurrence/VK, медиа и crash boundaries            | Подтверждённый результат восстанавливается без send; timeout остаётся ambiguous; частичная отправка не теряется          | Проверены существующие границы; оба полных API check и exact-SHA CI прошли      |
| 5       | Продуктовые причины задержек                                                | Автор видит access/setup/transient/ambiguous отдельно; recheck не является Retry; права не расширяются                   | Сохранены существующие UI-состояния; исправлен серверный разрыв ручного recheck |
| 6       | Production выпуск и наблюдение                                              | Зелёные Required + CodeQL exact SHA, immutable API image, все 14 ролей, strict smokes и честное post-release окно        | Оба выпуска завершены; результаты и ограничения наблюдения ниже                 |

## Современная архитектурная цель

- Durable intent и результат MAX остаются источниками истины; очередь лишь доставляет работу.
- У каждого зависшего запуска должны быть стадия, конкретная причина, время следующей
  проверки и безопасное действие оператора. «Повторить проверку прав» и «повторить отправку»
  не смешиваются.
- Сложные универсальные delegates защищаются generated-model query-contract тестами.
  Mock-only тестов недостаточно для Prisma-select и динамических transaction contexts.
- Изоляцию получателей и независимость Publisher от модерационного backlog улучшать
  после устранения подтверждённой причины, с сохранением DB/CPU/MAX budgets. Не отключать
  governor и не увеличивать concurrency как способ скрыть ошибку.
- Измерять lateness от scheduledAt до подтверждённой отправки, возраст blocked/ambiguous,
  долю безопасно восстановленных работ и ложные успехи отдельно. Oldest queue samples
  не выдавать за latency отдельных сообщений.
- Перезапись стека, новый брокер, unbounded scans и неподтверждённое автопереотправление
  не входят в решение жалоб.

## Проверки и безопасность

Read-only диагностика поставлена коммитом `5bc7d8f6`. Прошли 29 целевых SQL/privacy/
privilege/index-plan проверок и полные static/infra проверки. Выдано только необходимое
чтение metadata через штатный preview/apply provision; application data не изменялись.
Plain EXPLAIN подтвердил indexed source selection; реальные отчёты выполнились в
ограниченной read-only сессии. Подробности: [runbook](runbooks/publisher-publication-diagnostics.md).

После исправления проекции прошли 56 тестов marker store и Publisher producer, включая
реальный Prisma validator для двух моделей. Это не живой MAX send и не стресс-тест.
Полный API check первого выпуска: 592 suites, 13 232 passed; 24 environment-gated
suites / 176 tests skipped. Typecheck/build, retention, static/docs/infra прошли.
Exact-SHA Required и CodeQL зелёные. Проверенный CI image загружен без сборки на VPS
ниже disk floor. Все 14 API-ролей и OCR auxiliary обновлены, PostgreSQL/Redis не
пересоздавались. Release: `release-20260926T102204Z-b4fef1232235`.

Во время rollout старейшее событие достигало примерно 6 400 секунд; после обычных
повторов и обработки backlog лаг снизился до 0,4 секунды в отдельном срезе. Это возраст
очереди, не latency публикаций. Readiness и обязательные локальные/публичные/OCR smokes
прошли. В ограниченном журнале новых `Recorded webhook preparation failure` нет.
За завершённое окно `2026-09-26T10:31:30Z`–`10:46:00Z`: 58 capacity samples,
полное покрытие, p95 возраста старейшего события 1,876 секунды, максимум 1,987 секунды;
readiness/queue metrics/queue fence без отказов. Первые samples включают штатный
stabilizing mode, поэтому весь интервал не объявляется полностью normal. Отдельный
fleet sample не прошёл во время recycle OCR auxiliary; точечная проверка всех 14 API
ролей показала ноль перезапусков, у изолированного OCR позднее было два, OOM=false.
Этот отдельный native-boundary риск не скрывается сбросом счётчиков или отключением
защиты. В позднем срезе очереди осталось по одному RECEIVED/QUEUED возрастом около
секунды, без ordering predecessor. Старые FAILED и quarantine-маркеры не очищались.

Восстановление actor edge: 14 suites / 223 tests прошли, включая producer-to-worker,
сохранение concurrent grant/denial, отсутствие entity/binding, проигранный insert CAS,
fresh-denial фильтр, выключенный automatic dispatch, ручной refresh и Redis failure.
Локальный Docker daemon недоступен: новые проверки конкурентности используют mocks,
а не реальный PostgreSQL. Полный локальный API check второго выпуска (`1adf9525`):
593 suites / 13 246 passed, 24 environment-gated suites / 176 tests skipped;
retention storage: 10 passed / 1 external-PostgreSQL race skipped. Typecheck/build,
static (554 tool tests), docs и diff-check прошли. Exact-SHA CI `36236415330`
завершился успешно, включая отдельные Redis и существующие PostgreSQL race suites.
Новый отдельный PostgreSQL race-тест для actor nomination не добавлялся.
CodeQL `36236415351` также прошёл, включая проверку открытых high-severity alerts.
Второй verified CI image загружен штатным preload и развёрнут во всех 14 API-ролях
с OCR auxiliary. Release: `release-20260926T105726Z-1adf95259102`.
Миграций нет; PostgreSQL и Redis не пересоздавались. После version fence очередь
возобновлена штатно, lag при обработке rollout backlog снизился с 234 до 148 секунд,
затем до текущих событий. Ingress/admin live/ready, public live, OCR isolation и
UDS raster smokes прошли до фиксации release manifest.

После второго выпуска точечная проверка всех API-ролей и OCR показала running,
restarts=0, OOM=false. Publisher status: dispatch enabled, runtime exact,
global auth pause отсутствует, heartbeat свежий, secrets ready. В ограниченной
выборке 396 записей трёх ролей нет `Recorded webhook preparation failure`,
`Failed to enqueue scheduled publication actor access refresh` и
`Publisher binding refresh scan failed`.

Второе завершённое capacity-окно `2026-09-26T11:04:30Z`–`11:09:15Z`: 19 samples,
полное покрытие, p50 возраста старейшего события 0,477 секунды, p95/max 4,489 секунды.
Readiness, queue metrics, queue fence и fleet topology без отказов; перезапуски и
сбросы счётчиков не наблюдались. Все samples ещё относятся к `stabilizing`, поэтому
сводный статус отчёта остаётся degraded, несмотря на ready=200 и низкий queue lag.
Это короткое post-release окно, не SLO или доказательство доставки конкретных постов.

Это не подтверждение доставки всей истории: в одном post-release срезе оставалось
25 IN_PROGRESS, включая target slots без подключения/со stale bot access, а старейшие
32 SCHEDULED по-прежнему блокировались свежим `publisher_user_not_admin`.
Состояния FAILED/AMBIGUOUS и существующие receipts не изменялись вручную. Для конкретной
жалобы нужен авторизованный разбор точного запуска/получателя, а не массовый replay.

Живые тестовые посты в MAX не создавались; диагностика production была read-only,
кроме штатной выдачи ограниченных audit-role grants и развёртывания приложения.
Автоматическая работа уже существующих пользовательских расписаний не подменялась
ручным запуском или массовым replay.

## Последующие улучшения и критерии

Эти изменения не включаются в срочный выпуск без отдельного измерения и проверки:

1. Метрики publication lateness и времени по blocker: только bounded/indexed агрегаты,
   без идентификаторов и содержимого; отдельно NOW и scheduled, отдельно attempted и
   pre-dispatch. Базовая неделя наблюдения предшествует выбору SLO и порогов тревоги.
2. Изоляция фоновых публикаций от moderation backlog: отдельный бюджет DB/CPU/MAX,
   canary и нагрузочные проверки; общий аварийный governor сохраняется.
3. Независимое исполнение получателей одной публикации: только с явной продуктовой
   семантикой частичного результата, неизменяемыми targets/revision и per-target receipt
   fences. Нельзя молча урезать аудиторию или автоматически повторять attempted sends.
4. Операторский разбор исторических AMBIGUOUS: точечная проверка receipt/сообщения и
   авторизованное действие владельца. Массовое переотправление запрещено.
