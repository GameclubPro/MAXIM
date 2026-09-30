# План исправления антидубля, 30 сентября 2026

Статус: обязательные runtime-исправления реализованы, проверены и выпущены.
Эксплуатационные ограничения и дальнейшие улучшения перечислены ниже. Основание:
[аудит 30 сентября](antiduplicate-audit-2026-09-30.md), исходники
`cfb93bae1ae730110c05e4c8290e0ab7f391c35c` и датированные read-only снимки VPS.
Ниже разделены восемь подтверждённых дефектов, дополнительные риски и улучшения.
План не гарантирует обнаружение всех возможных ошибок. Production-настройки,
сообщения, санкции и runtime control при его подготовке не менялись.

## Результат выпуска

- Runtime SHA: `87a2d4f5766b447fb9adc65756b0506b3420335b`; release manifest:
  `release-20260930T173743Z-87a2d4f5766b`. Успешны exact-SHA `Required` и
  `Analyze JavaScript and TypeScript`, затем штатные strict production smokes.
  Применена миграция policy/history revisions; все 14 API-ролей, OCR auxiliary
  и оба активных static-компонента используют проверенные immutable CI images.
  PostgreSQL/Redis не пересоздавались; webhook pause/drain/image fence сохранён.
- Полный локальный `npm run check`: API 634 suites / 13 801 tests, contracts 311,
  miniapp 1426, admin 15, infrastructure/agent tools 493. Выполнены реальные
  Redis/BullMQ/Sharp регрессии, обязательные PostgreSQL races и Prisma checks;
  miniapp visual smoke прошёл 13 сценариев. Production dependency audit: 0
  vulnerabilities после обновления Nest Fastify adapter и Axios override.
- После обновления ровно 17 предусмотренных column grants успешны
  `postgres-audit duplicate --explain` и все три отчёта `postgres-audit duplicate`.
  Таймаут сохранён. Насыщенные выборки дают только lower bounds; SQL не доказывает
  runtime authority, свежесть capability или отсутствие новых failures.
- Read-only наблюдение 17:45:55Z–17:58:30Z: 48 capacity samples, coverage complete,
  readiness/queue metrics/fence без failing/unknown samples. Первое пятиминутное
  окно содержало восстановление system mode и один отказ topology check; второе
  прошло выбранные service checks без новых перезапусков. Общий lag p95 1.479 s,
  максимум 2.286 s — это sampled oldest-queue lag, не request latency и не SLA.
- Все 14 API-ролей имеют restart count 0. OCR auxiliary перезапустился один раз
  с exit 0, OOM false; причина не установлена. Его health recovery может дать
  `unexpectedMain=1` в текущем classifier, поэтому отдельный лишний API-контейнер
  этим сигналом не доказан. Полное окно имеет status degraded; сохранялись
  предупреждения по диску (минимум 29.524 GiB free), swap usage и swap-in.
- Ограниченное Redis-чтение обнаружило шесть terminal failures в окне наблюдения:
  два byte-limit, три unsupported multi-frame, один запрещённый photo URL.
  Все — v2, точная job identity, одна попытка, `cleanupOnly=terminated`,
  `actionEligible=false`; это отказы проверки источника, а не успешная модерация.
  Защитные лимиты и allowlists не расширялись. Живые тестовые сообщения/санкции
  и переключение runtime control не выполнялись; OCR остался shadow.
- После основного окна system mode снова перешёл в `degrade` при доступном
  readiness 200. Снимок очереди 18:04:01Z: wait/active/prioritized/dueNow равны
  нулю, delayed 467. Диагностика показывает governor pause/slow и ordering
  deferrals. Это сохраняет ограничение эксплуатационной приёмки; уменьшение
  текущего lag не доказывает устойчивую ёмкость и не отменяет предупреждение.

Не завершена отдельная эксплуатационная приёмка: sustainable throughput под
production cgroup-лимитами и переход DAILY в явно назначенном живом тестовом чате.
Гарантированная очистка claim после повторных stalls/потери BullMQ требует
дальнейшего SQL cleanup lease/reconciler; текущий отказ остаётся fail-closed.

## Уточнения реализации

- История использует новый внутренний namespace `dup:window:v1:<chat>:v2:`.
  Bindings v3 несут версии обеих публикаций, стабильный `originalId`, явную область
  действия и ревизию настроек. Старые bindings читаются для диагностики, но не
  получают новых действий. Ручное освобождение сохраняет прежний общий reset key.
- Отдельная положительная SQL-таблица решений не понадобилась. Неизменяемый отзыв
  хранится в существующей таблице claims под собственным dedupe key с NULL
  `messageActionKey`; он не занимает право действия другого правила. SQL commit
  предшествует best-effort отзыву Redis permit. Отзыв не создаёт pending job.
- Первая постановка media job фиксируется отдельным SQL admission key без права
  действия. Повтор после потери permit и BullMQ считается retry и не выдаёт true.
  Короткая отсрочка конкурирующего первого admission не мешает владельцу завершить
  регистрацию; сбой после SQL commit до Redis оставляет действие непроверенным.
- DELETE повторяет проверку разрешения в последнем transport hook после остальных
  guards. Раннее подавление при developer blacklist не зависит от включённого OCR.
- Redis permit отделён от порядка и хранится семь дней. Это срок хранения, не срок
  действий: последнее ограничено десятью минутами от доверенного времени события,
  а также original/runtime/DAILY. Повтор и косметическая правка не продлевают срок
  той же публикации. Утраченный permit при восстановлении не разрешает действия.
  SQL retention claims минимум сутки; истёкшее основание остаётся запрещённым
  независимо от последующей очистки записи отзыва.
- Проверка разрешения выполняется до общего SQL claim, затем claim предшествует
  квалификации. Собственный claim восстанавливается после сбоя; чужой не повышает
  счётчик. Сбой сериализации `INSERT ... ON CONFLICT` повторяет всю транзакцию,
  без чтения из прерванной транзакции. Счётчик отражает разрешённые зарезервированные
  нарушения, а не число успешных доставок; поздний отзыв не уменьшает его вслепую.
- Терминальный отказ, expiry или исчерпание попыток освобождают только точный
  собственный неиспользованный `messageActionKey` в serializable SQL-транзакции.
  Сохранённый intent, moderation event, чужой или более новый owner защищены.
  Уникальный tombstone остаётся; отзыв точных событий записывается атомарно,
  поэтому старый owner не захватывает право повторно. Временный сбой сохраняет
  возможность resume; уже зарезервированную ступень не уменьшают.
- Режим `cleanupOnly` повторяет только очистку SQL claim, включая успешно
  завершённый анализ с ранним отказом. Отсрочка 30 секунд ограничена исходным
  deadline + 24 часа и не продлевает разрешение на модерацию. Очистка completed
  сохраняет permit уже созданного intent. Одновременная потеря Redis/SQL либо
  SQL outage дольше суток оставляет claim запрещающим конкурирующее действие
  до отдельного восстановления или штатной retention; это не разрешает replay.
- Повторные аварии worker могут исчерпать BullMQ stalled recovery до входа в
  `cleanupOnly` processor. В этом случае неиспользованный claim сохраняется
  fail-closed и требует точечного операторского восстановления; метрика
  `worker.cleanup_exhausted` для этого пути не появляется. Обычный `job.retry()`
  не исправляет его: BullMQ сохраняет `defa`/`stc`. Гарантированное восстановление
  после потери queue state требует SQL cleanup lease, сохранённого атомарно
  уже при preclaim, и отдельного bounded reconciler.
- Две серверные ревизии изменяются триггером для всех writers. Matching/окно/допуск
  меняют историю; изменения санкций сохраняют историю, если действующие окно и
  допуск остались теми же. Неактивные поля нормализованы по runtime resolver.
- Одно доказанное обновление локатора к тем же independently verified pixels
  сохраняет публикацию и счётчик. Цепочка A -> B -> A, конфликт, частичная потеря
  state и MAX-read без времени введения не восстанавливают старое основание.
- Типизированный URL-отказ фотографии допускает одно обновление через точное
  сообщение MAX с прежними guards источника и загрузки. Фиксированные `media.url_*`
  метрики считают попытки без адресов и credentials. Повторно запрещённый источник
  не разрешает действие. Нормализация timezone согласована с расчётом DAILY.
- SQL-аудит intent использует десять literal status predicates с прежними caps,
  чтобы planner учитывал распределение статусов. `duplicate --explain` выводит
  только обычный план этого запроса; fixture со всеми конкурирующими индексами
  проверяет ordered retention scan. Production-план и успешное выполнение
  проверены после синхронизации релиза; timeout и предусмотренный набор из
  17 узких column grants сохранены.

Постоянные тесты выполняют реальные Lua-переходы, BullMQ и Sharp, а отдельные
PostgreSQL tests проверяют триггер, конкурирующие claims и долговечные отзывы.
Проверка предсказуемых отсрочек не заменяет измерение sustainable throughput
на стенде с production cgroup-лимитами; числовой SLA этим выпуском не утверждается.

## Приоритеты и зависимости

Главный приоритет: исключить действия по отозванному основанию. Следующий:
остановить повторную нагрузку очереди и сделать пропуски проверки видимыми.
Сохранение счётчиков и DAILY входят в исправление модели истории; отдельно
менять только TTL или только `observedAtMs` недостаточно.

| ID  | Приоритет | Подтверждённый дефект                                                   | Работа                                                 | Обязательное доказательство                                                             |
| --- | --------- | ----------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| D1  | P1        | Lifecycle-only A -> B -> A восстанавливает старое основание             | Версии содержимого и необратимый отзыв                 | Старые bindings оригинала и дубля остаются stale после возврата A                       |
| D2  | P1        | Поздний `actionEligible=false` не останавливает действия                | Проверка разрешения у квалификации, intent и dispatch  | Отзыв после сохранения intent блокирует DELETE/WARN/MUTE/BAN и recovery                 |
| D8  | P1        | Очистка pending через пять минут снимает false latch                    | Отдельное хранение разрешения и запрета                | Пауза, expiry, complete, abandon и перезапуск не восстанавливают запрет                 |
| D3  | P1        | Governor 180 секунд превращается в повтор каждые пять секунд            | Причины/сроки отсрочек, порядок, общий deadline        | Соблюдён `retryAfterMs`; нет очереди частого опроса followers; expiry имеет явный исход |
| D4  | P2        | Правка подписи IMAGE сбрасывает допуск и ступени                        | Стабильная идентичность оригинала при обновлении proof | Caption edit сохраняет allowance, WARN -> MUTE и окончание окна                         |
| D5  | P2        | Правка вне DAILY становится новым основанием через косметическую правку | Время введения версии в lifecycle                      | Версия, введённая вне периода, не входит в него задним числом                           |
| D6  | P2        | Закрытая системная панель не показывает активную очередь                | Dashboard/read model                                   | `message-duplicates` присутствует с актуальными counts и признаком недоступности        |
| D7  | P2        | SQL-аудит использует retired photo toggle/preset                        | Запрос, права роли, schema diagnostics                 | Saved IMAGE eligibility отделена от legacy-полей, runtime и capability                  |

Нумерация D1-D8 совпадает с аудитом. D8 дополнительно воспроизведён при подготовке
этого плана: реальный `ANNOUNCE_SCRIPT` после имитации expiry восстановил true.
Это подтверждение перехода хранилища, а не отдельное воспроизведение DELETE.

Практический порядок: регрессионные тесты и решения по семантике -> согласованный
протокол истории/разрешений/bindings -> scheduling -> диагностика -> выпуск.
Typed delays можно внедрить вместе с безопасным сроком хранения latch; выпускать
их раньше решения D8 нельзя. Диагностику можно готовить независимо, но она
не заменяет проверки поведения.

## Инварианты исправления

- Окно закреплено за принятой публикацией. Отклонённые и удалённые повторы не
  становятся оригиналами и не продлевают его срок. Регрессия +21/+30/+43 часа
  остаётся обязательной для TEXT, MESSAGE и IMAGE.
- Публикация, введение новой версии содержимого, приход webhook и выполнение
  worker имеют разные часы. Время проверки MAX не является временем публикации.
- Смена сравниваемого содержимого отзывает старое разрешение необратимо.
  Возврат A после B может породить новое наблюдение, но не оживить старый binding.
- IMAGE сравнивает весь точный canonical raster и полный набор фотографий
  с сохранением кратности, без подписи. Platform ID служит локатором, не proof.
  MESSAGE требует независимые hashes не-фото вложений; TEXT не сравнивает медиа.
- CHAT разделяет поиск совпадений между участниками, но допуск и эскалация
  остаются авторскими. Администраторы, боты и иммунитет не повышают ступень.
- `actionEligible=false` поглощает последующие true для того же логического
  задания. Разрешение не восстанавливается очисткой Redis или повтором webhook.
- Отсутствующие, конфликтующие, просроченные или недоступные доказательства
  не разрешают действие. Транспортный сбой отличается от подтверждённого запрета:
  он допускает ограниченный retry, не превращается в permanent false.
- Runtime off/shadow авторитетны. Retired photo/rolling пути не включаются.
  Отсутствие сообщения не разрешает санкцию без точного durable DELETE receipt.
- Ручное освобождение сохраняет cutoff и существующий grace текущего окна/DAILY.
  Grace не считать ошибкой. Нельзя сбрасывать чужой IMAGE-оригинал или claims.
- Все побочные эффекты используют актуальную авторизацию, включая настроенные
  продуктовые уведомления. Диагностика и тестовые ответы не отправляются в группы.

## Дополнительные риски, которые надо проверить

Эти пункты не добавлены к числу подтверждённых runtime-дефектов. Для каждого
нужны тест и решение; результат проверки определит объём реализации.

| ID  | Наблюдение в коде                                                                                               | Возможное последствие                                                                                                  | Проверка и решение                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Digests настроек зависят от значений; у ChatSettings нет отдельной duplicate policy revision                    | Настройки A -> B -> A или disable -> enable могут вернуть старую группу/binding                                        | Создать pending intent, поменять и вернуть настройки без новых сообщений. Зафиксировать: старые действия необратимо отзываются; историю можно сохранять только по явно выбранной политике                                    |
| R2  | `guard.qualify()` вызывается до `ensureIntentWithMessageActionClaim()`                                          | Чужой заблокировавший claim может оставить лишнюю ступень, хотя действия антидубля нет                                 | Проверить реальный PostgreSQL claim другой политики и следующий повтор. Разделить нарушение, резервирование ступени и применение действия; исключить повышение от ineligible/чужого owner                                    |
| R3  | `suppressDeferredPhotoAnalysisActions()` теперь вызывает только `enqueueCommercialOcr(false)`                   | Ранний выход повторной обработки может не сообщить запрет уже поставленному message job                                | Пройти пути admin/unresolved access, ночного режима, active mute, required subscription, конкурирующего правила и relay с ранее созданным job. Подключить отзыв антидубля только там, где он следует из результата модерации |
| R4  | Guard записывает обнаруженную правку оригинала через lifecycle с `Date.now()`                                   | Новый учёт версии может принять время проверки за введение содержимого или блокировать позже пришедший доверенный edit | Разделить invalidation от MAX-read и доверенный content introduction. Проверка отзывает старое основание, но не создаёт публикацию или санкцию                                                                               |
| R5  | `qualified()` возвращает прежнюю ступень до полного `checkMessage()`; итоговый guard всё равно вызывается позже | При доработке можно случайно принять найденную ступень за актуальное разрешение                                        | Resume квалификации возвращает прежний count, но никогда не обходит текущие runtime/settings/latch/receipt guards                                                                                                            |
| R6  | Блокировка порядка общая для чата, worker имеет concurrency 2                                                   | Горячий чат или один недоступный head может задерживать другие чаты и участников                                       | Нагрузочный тест горячего и нескольких спокойных чатов, зависшего head, неодинаковых альбомов. Сохранить порядок внутри чата и продвижение остальных                                                                         |
| R7  | У photo и binary разные allowlists; forbidden URL не проходит refresh-путь для 403/404/410                      | Поддерживаемые фотографии могут оставаться непроверенными, но причина production failures пока неизвестна              | Классифицировать запрет по фиксированным кодам HTTPS/credentials/port/host. Проверить безопасный refresh точного сообщения, включая отказ/смену фото; не расширять hosts по числу failures                                   |
| R8  | TTL, complete и abandon очищают разные части состояния; Redis может потерять доказательства                     | Новая версия/разрешение может совпасть с прежней после отсутствия записи; recovery может считать missing разрешённым   | Проверить частичную потерю state, lifecycle, cutoff, permit и cache. Missing не восстанавливает полномочия; новая запись имеет новую incarnation                                                                             |
| R9  | Существующие flow-тесты используют настоящие Redis/BullMQ/Sharp, но адаптеры PostgreSQL/MAX                     | Не покрыты межпроцессные гонки commit, wakeup, receipt и санкции                                                       | Добавить реальные PostgreSQL race-тесты и fault injection, не ограничиваться mocks и чтением строки Lua                                                                                                                      |
| R10 | Runbooks обещают необратимый отзыв и содержат описание прежней ZCOUNT-истории IMAGE                             | Реализация и документация могут снова разойтись; существующий rollback floor проверяет только старый guard             | Обновить текущие runbooks вместе с кодом и усилить обе rollback-проверки для нового протокола                                                                                                                                |

До safety-релиза закрыть R1-R5 и R8: они влияют на полномочия и счётчики.
R6/R7 проверить до приёмки scheduling, R9/R10 входят в выпуск. Не переводить
непроверенные риски в «исправлено» только по наличию нового поля или unit mock.

## Этап 0. Воспроизводимые регрессии

Вернуть шесть диагностических сценариев аудита как постоянные regression specs:
два lifecycle A -> B -> A, поздний отзыв действий, два caption/counter сценария
и DAILY outside -> cosmetic inside. Дополнить D8 тестом actual Redis expiry,
не используя пяти- или десятиминутный sleep: менять deadline отдельного
изолированного job, сохраняя тот же Lua и проверяя состояние до/после cleanup.

Использовать существующие `message-duplicate-history.redis-integration.spec.ts`
и `message-duplicate-flow.redis-integration.spec.ts`; тесты общего ordering
должны также защищать его retired photo consumer от случайного оживления.
В каждом тесте проверять не только отсутствие DELETE, но и counter, binding,
оригинал, срок окна и возможность следующего корректного сообщения.

Изолированные Redis и PostgreSQL должны быть локальными и одноразовыми.
Текущие skipped PostgreSQL tests не считать покрытием. Новые race-specs включить
в обязательную CI-команду: существующий `test:postgres-races` перечисляет файлы
явно. Фиктивные часы не должны нарушать deadline, который Lua проверяет по Redis TIME.

Результат этапа: failing tests текущих дефектов, проверенные R1-R5/R8,
зафиксированные семантика настроек и правило квалификации. Runtime пока не менять.

## Этап 1. История и версия содержимого

Основные модули: `message-duplicate-window.script.ts`,
`message-duplicate-history.service.ts`, `message-duplicate.service.ts`,
`message-duplicate-delete-guard.service.ts`, `message-duplicate-state.ts`.

1. В lifecycle хранить доверенное время последнего события, версию источника,
   конфликт, время введения сравниваемой версии и признак достоверности этого
   времени. Обновлять это состояние до ранних выходов и вне DAILY; допуск
   оригинала и действий выполнять отдельно. На MAX-read без даты правки
   разрешена только инвалидация; неизвестную дату не заменять временем worker.
2. В original и duplicate binding включить точные версии обоих сообщений.
   `valid()`/`matching()` сверяют версии, а не только digest A. Повтор того же
   события не меняет версию; содержательная правка и конфликт отзывают старую.
   Возврат к A создаёт новую версию. Более старое событие не откатывает актуальное.
3. Версии не должны переиспользоваться после TTL/утраты записи. Использовать
   уникальную incarnation и generation либо эквивалентный невозвратный token.
   Если обязательного lifecycle/state нет, старый binding отклоняется.
4. Разделить stable original identity и freshness скачанного proof.
   `observedAtMs` не использовать как изменяемую часть counter identity.
   Caption-only edit с теми же IMAGE-источниками не затирает готовое состояние
   пустой identity и не расходует ещё один allowed repeat.
5. Для нового/неясного источника сначала отозвать прежний proof. Сохранить
   счётчик можно после независимой проверки того же сравниваемого содержимого
   и непрерывности версии. Изменённое фото, промежуточная B или неполный альбом
   не получают старое разрешение. Одинаковый ID сам по себе ничего не сохраняет.
6. Время введения B вне DAILY сохранить при последующей косметической правке.
   У DAILY оригинал принадлежит одному `[start, end)`; правка вчерашнего текста
   без нового содержимого не вводит его в сегодняшний период. Для содержания,
   введённого вне периода, исход внутри периода остаётся «не оригинал».
7. Counter привязать к автору, стабильному оригиналу/его содержательной версии,
   fingerprint/policy context и author reset epoch. Отдельно сохранить
   accepted allowances, qualified violations и one-stage-per-message.
   При продлении physical TTL не менять логическое `expiresAtMs`.

Готовность: D1/D4/D5 зелёные для оригинала и дубля; косметическая правка
не сдвигает окно и не сбрасывает ступень, содержательная правка не оживляет bindings.
Проверить равные timestamps, conflict -> replay, out-of-order, удаления,
семидневное окно, переходы типов вложений и ручное освобождение.

## Этап 2. Разрешение действий и durable recovery

Основные модули: `message-duplicate.queue.ts`, `message-duplicate.processor.ts`,
`photo-duplicate-ordering.store.ts`, `message-duplicate-media.service.ts`,
`message-duplicate-enforcement.service.ts`, `message-duplicate-delete-guard.service.ts`,
границы dispatch в `moderation-delete-intent.service.ts` и duplicate actions.

Предпочтительная модель: отдельное состояние авторизации конкретного решения,
доступное ingress/moderation, background и action. Binding ссылается на decision
и его версию; immutable `actionEligible=true` внутри job не является полномочием.
Сначала проверить пригодность существующего durable состояния; если оно не
позволяет хранить отзыв и CAS, добавить узкую запись решения в PostgreSQL.
Не встраивать новый протокол в несвязанные claims других правил.

1. Разделить scheduling/order membership и authorization. Очистка порядка,
   complete и abandon не удаляют запрет, пока может существовать относящийся
   к нему job/intent/sanction recovery. Завершение анализа не означает
   завершение MAX-действия. Положительное разрешение тоже должно оставаться
   проверяемым после выхода из ordering lease; иначе новый guard потеряет
   все intents, исполняемые позже в `api-action`.
2. Начальная регистрация и retry различаются: retry не создаёт разрешение
   из missing. True -> false монотонно; replay true ничего не меняет.
   Восстановление из Redis-loss требует durable доказательства, а не job boolean.
   Source/settings/runtime rejection и expiry сохраняют терминальный исход.
3. Публиковать отзыв там, где повторная обработка установила ineligible,
   включая проверенные R3 ранние выходы. Не отзывать навсегда из-за одного
   недоступного сервиса и не создавать новый media job только ради подавления.
   При конкурирующей политике сохранить её собственное право действия.
4. Ввести async-проверку разрешения отдельно от `assertOwned()`.
   Lease подтверждает владение worker, authorization подтверждает право действия.
   Проверять последнее перед квалификацией, передачей intent, после внешних
   проверок и в фактических before-mutation hooks DELETE/WARN/MUTE/BAN.
5. Сохранённый intent и DB sweeper проверяют тот же decision/version независимо
   от живого callback в background. После отзыва reason антидубля не исполняется;
   смешанные причины проходят собственные guards. Нельзя отменять чужую
   легитимную причину или трактовать malformed duplicate metadata как legacy.
6. Квалификацию сделать идемпотентным резервированием одной ступени для
   разрешённого владельца. Учесть R2: SQL claim и Redis counter не атомарны
   между собой. Нужны persist/resume/reconcile переходы, включая crash между
   ними; простой перенос вызова `qualify()` или blind decrement недостаточен.
   Уже подтверждённое наше удаление восстанавливает ту же ступень по receipt.
7. Если R1 подтверждён, добавить серверную монотонную duplicate policy revision
   по образцу scoped traffic/stop-word revisions. Все writers, включая
   перенос раздела/всех настроек и private controls, повышают её атомарно с
   изменением значимых нормализованных полей. No-op и посторонние UI-поля
   её не меняют. Возврат значений не возвращает прежнюю revision.
   Заранее разделить влияние compare/schedule/allowance и sanction-only изменений:
   отзыв старой санкции не обязан сбрасывать полезную историю совпадений.
8. Определить срок хранения authorization из всех consumers: срок job,
   срок original/runtime/DAILY, `retryUntilAt` intent и recovery санкции.
   После общего срока missing означает «действия запрещены».
   Durable retention очищается ограниченными индексированными пакетами,
   не с fleet scan при каждой проверке и не с бессрочными per-message Redis keys.

Граница гарантии: отзыв, завершённый до последнего before-mutation guard,
блокирует действие. Уже отправленный MAX-запрос нельзя отменить задним числом.
Определить linearization point, сериализацию разрешения/отзыва и остаточную
гонку с remote dispatch; не обещать транзакцию Redis + PostgreSQL + MAX.
Ошибки подтверждения оставляют безопасный ограниченный retry с прежней ступенью.

Готовность: D2/D8, реальные гонки R2/R9, complete/restart/recovery и revoke
между DELETE и санкцией проходят. Проверить DB sweep раньше завершения
background, потерю ответа после commit, ledger ambiguity и MAX-delete-before-DB.

## Этап 3. Повторы, deadline и пропускная способность

1. `MessageDuplicateMediaDeferredError` передаёт фиксированный reason code
   и проверенный `retryAfterMs`/`nextEligibleAt`. Отдельные причины:
   governor pause/slow, order not-head/busy, source-not-ready,
   proof budget, decode capacity и infrastructure retry.
   Не копировать free-form governor reason в метрики.
2. Processor сохраняет и использует срок отсрочки. Для governor пауза
   не короче его рекомендации; положительный bounded jitter может разнести
   одновременные пробуждения. Для slow выбрать ограниченное продвижение,
   чтобы стабильный slow не голодал бесконечно. Проверить recovery window,
   ручную паузу и давление хоста отдельно.
3. Один абсолютный deadline задаётся при первом admission и не продлевается
   retry/re-add. Его верхняя граница также учитывает исходный duplicate window,
   DAILY end и runtime expiry. Проверять дедлайн после длительных операций
   и непосредственно перед действием, не только в начале `process()`.
4. Когда рекомендованное пробуждение позже deadline, сохранить явный исход
   `unverified_expired` с причиной; не возобновлять такой job и не переносить
   его в следующий DAILY. Отсрочка не является non-match или successful action.
   Продление десяти минут рассматривается только после измерения SLA/ёмкости.
5. Followers не опрашивают chat head каждые пять секунд. Предпочтительно
   один bounded wakeup на чат с продвижением следующего при completion;
   допустим deadline-aware defer до nextEligibleAt head, если тесты доказывают
   ограничение попыток и восстановление потерянного wakeup.
   Сохранить порядок доверенных event times и консервативный tie handling.
6. Pending membership существует до абсолютного job deadline с запасом
   на Redis/worker recovery, а не произвольные пять минут от announce.
   Heartbeat lease остаётся отдельным. Cleanup не снимает authorization,
   не оставляет dead head и не требует неограниченного удаления expired members.
7. Все длительные deferrals сохраняют доказанный progress в revision/source-scoped
   caches. Частичный proof или negative cache никогда не доказывает совпадение.
   First candidate не скачивать без необходимости; отсутствие proof у него
   не считать потерянным подтверждённым действием.
8. Сохранить лимиты 30 секунд, 20 uncached items, byte/pixel budgets и decode slots.
   Slot освобождается после фактического завершения Sharp. Не повышать concurrency,
   не ослаблять governor и не расширять ресурсы до измерений на общем VPS.

Нагрузочная приёмка на стенде с сопоставимыми cgroup-лимитами:

- cold и warm cache, одиночные фото и альбомы 10 фото, TEXT/MESSAGE/IMAGE;
- один горячий и несколько спокойных чатов; один медленный источник;
- стабильная пауза 180 секунд и восстановление, slow, restart/stalled jobs;
- при фиксированной паузе head пробуждается не чаще рекомендованного срока;
  attempts followers не растут пропорционально backlog каждые пять секунд;
- после снятия давления при поступлении ниже измеренной ёмкости backlog
  уменьшается и все eligible jobs успевают до своих deadlines;
- saturation даёт явные deferred/expired outcomes, сохраняет права и не
  деградирует webhook/action SLO относительно контрольного прогона.

Измерить throughput, p50/p95/p99 enqueue-to-proof и proof-to-receipt,
CPU/RSS, decode occupancy, attempts/job, age/dueDelayed и expired outcomes.
Числовой эксплуатационный SLA утвердить по этим измерениям; текущие снимки
VPS и 7 completed за 30 секунд не являются оценкой sustainable throughput.

## Этап 4. Диагностика и источники

Для D6 изменить `AUXILIARY_QUEUE_NAMES` в `queue-metrics.service.ts`, его tests
и закрытые consumers, если требуется. Legacy queue показывать явно retired
или убрать из активного списка. Общая readiness остаётся лёгкой. Недоступные
Redis/counts показывать как unavailable/stale, не как пустую очередь.

Для D7 изменить `vps-postgres-audit.sh` вместе с
`vps-provision-postgres-audit-role.sh` и их tests. Сейчас `maxim_audit` получает
строго ограниченные column grants; прежний readiness проверял набор из 12 прав,
исправленная schema v2 требует ровно 17:
простого добавления `duplicate_compare_mode` в SELECT недостаточно. Согласовать
allowlist, grants, проверку состава прав и versioned output; не давать роли
SELECT всей `chat_settings`, metadata, текстов или URL.

В выводе разделить legacy compatibility, saved eligibility
(`antiDuplicateEnabled`, compare mode, scope/schedule), runtime mode/revision
и capability freshness. SQL не читает Redis authority: runtime передаётся
отдельным датированным read-only снимком, без заявления об атомарности снимков.
Сохранять caps, `sample_saturated`, lower bounds и unavailable. Не называть
насыщенную выборку полным количеством включённых чатов.

Для delete-intent timeout сначала проверить shape и plain EXPLAIN с имеющимся
`(status, updatedAt)` индексом, затем bounded keyset/candidate joins при необходимости.
LIMIT не ограничивает scan/sort. Не добавлять индекс по факту единственного timeout,
не увеличивать deadline и не запускать EXPLAIN ANALYZE на основном VPS.

Дополнить observability фиксированными outcome/reason кодами:
matched/allowed/first-candidate, revoked, source-unverified, unsupported,
governor/order/source/budget deferred, expired, intent-handoff,
remote-deleted, proven-absent, sanction-applied и verification-unavailable.
Отдельно показывать attempts и уникальные логические outcomes. Для последних
использовать идемпотентные terminal transitions/ограниченный durable read model;
process-local logs с потерей при crash не выдавать за точные fleet totals.
Без идентификаторов, хешей, текстов, URL, токенов и свободных ошибок в labels.

Предлагаемые сигналы: возраст oldest eligible job относительно deadline,
новые expired jobs, длительный governor pause, attempts/completed ratio,
доля source-unverified в явно ограниченной выборке и stalled/retry рост.
При неточном denominator показывать unavailable/incomplete. Worker completion,
matched и intent handoff не означают успешное удаление.

Для R7 безопасный refresh запрещённого/истёкшего URL выполнять только через
точный MAX message lookup и проверку той же message/revision/photo identity;
полученный новый URL заново проходит HTTPS/redirect/DNS/private-IP/host guards.
Никакой прямой загрузки запрещённого URL, произвольного wildcard или fallback
к другой фотографии. Проверить byte/pixel/high-bit-depth/unsupported-content
исходы и отсутствие ложных bans; не менять все лимиты ради двух failed jobs.

## Совместимость и миграция

До правок утвердить таблицу writers/readers для ingress/moderation,
background, `api-action`, DB sweeper, diagnostics и обеих rollback-команд.
Новый протокол обязателен на всех границах, а не только в admission.

- Новые history records используют namespace v2, bindings v3 и jobs v2;
  readers и semantic/idempotency keys обновлены совместно.
- Старый v1 означает delete_only, v2 full. Нельзя просто расширить union до 3:
  `isBoundMessageDuplicateDelete()`, qualify/guard, rollout, reason ownership,
  receipt equality и `assertClaimMatchesIntent()` зависят от этой семантики.
  Новая схема должна явно сохранять scope; незнакомая схема отклоняется.
- Старый job без `comparison=IMAGE` не становится IMAGE. Старый binding без
  revision/permission proof не получает их по default. Сохранить ownership
  sentinel `MESSAGE_DUPLICATE:`/`message_v1`, чтобы ошибка parse не отправила
  reason в обычный незащищённый delete путь.
- При невозможности доказанного переноса старые задания и bindings безопасно
  отклоняются с отдельным исходом. История прогревается новыми наблюдениями;
  ожидаемое временное снижение coverage фиксируется. Исторические нарушения,
  санкции и claims не пересчитываются и не исполняются повторно.
- Новая namespace/digest version отделяет несовместимую историю. Byte/raster
  proof cache сохранять только при прежнем алгоритме и прежней привязке;
  новый proof не переносить из старого непроверенного platform ID.
  Не выполнять массовый Redis purge.
- Если нужны durable decision/policy columns, миграция только additive,
  с bounded DDL, проверкой defaults/constraints/индексов/retention и совместимостью
  предыдущего образа. Backfill полномочий из legacy history запрещён.
- Усилить `maxim_topology_require_message_duplicate_delete_guard()` и
  `message-duplicate-deploy-guards.test.mjs` для нового history/permission
  протокола. Текущий floor проверяет наличие старого current-content guard;
  это не доказательство понимания нового отзыва. Проверить обе rollback-команды.

## Матрица обязательных тестов

| Группа                | Сценарии                                                                            | Что проверять                                                                     |
| --------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Lifecycle             | A -> B -> A у original и duplicate, только ранний lifecycle                         | Старые bindings stale; новая допустимая версия работает                           |
| Порядок правок        | Older event, равное время/разный source, replay конфликта, будущая/ingress дата     | Нельзя откатить версию, выбрать конфликт по message hash или выдумать время       |
| IMAGE refresh         | Подпись/пробелы, URL renewal, перестановка, новые ID с теми же пикселями            | Сохранить counts только при доказанной непрерывности; captions не влияют на IMAGE |
| Реальная замена       | Фото B, A -> B -> A, TEXT -> IMAGE -> mixed/partial                                 | Старые полномочия отозваны; неполное содержимое не разрешает DELETE               |
| Counter               | allowed 0/1/верхний лимит, все реакции off, WARN/MUTE/BAN                           | Правильное число разрешённых сообщений и одна ступень на message                  |
| Claim race            | Чужой owner, собственный replay, concurrent workers, crash на границе Redis/SQL     | Чужой owner/ineligible не повышает count; свой retry сохраняет count              |
| Eligibility           | false до/во время qualify, после intent commit, во время guards и до mutation       | Нет последующего действия и лишней квалификации; проверяется актуальный запрет    |
| Хранение запрета      | Expiry pending, >5 минут gap, complete/abandon, reannounce true, Redis loss         | Запрет не превращается в true; missing не даёт право                              |
| Recovery              | DB sweeper раньше background completion, retry после DELETE, receipt lost/ambiguous | Exact receipt и одна санкция; одно отсутствие не авторизует её                    |
| Конкурирующие правила | Ранние admin/night/mute/subscription/relay пути, mixed reasons                      | Правильный отзыв duplicate; чужая политика не обходится и не отменяется           |
| Fixed interval        | +21/+30/+43 ч, ровно expiry, old edited post, 7 дней                                | Фиксированный срок от принятого original; отклонённые не продлевают               |
| DAILY                 | Outside material -> inside cosmetic; start/end; overnight; yesterday edit           | Время версии/границы сохраняются; старый job не переходит в новый период          |
| Часовые пояса         | Spring gap, fallback, collapsed period, смена timezone                              | Один calendar window по существующей Luxon-семантике                              |
| Scope/reset           | SAME_AUTHOR/CHAT, два участника, manual release, admin/bot/immunity                 | Чужие ступени не наследуются; cutoff/grace не обходятся                           |
| Settings/runtime      | A -> B -> A, disable/enable, sanction-only/no-op, off/shadow/full                   | Старые действия не оживают; нет retired fallback                                  |
| Источник              | 403/404/410, forbidden URL, redirect/DNS, deleted/changed MAX message               | Только доказанный safe refresh; недоступность не равенство/отсутствие             |
| Resource              | Cold/warm, cache eviction, 10 фото, 20-item budget, decode slot занятый             | Сохранён bounded progress; нет partial match и преждевременного release slot      |
| Scheduling            | Pause 180s, slow, not-head/busy, delayed failure, deadline, stalled/restart         | Правильный next attempt; fairness и явный terminal outcome                        |
| Diagnostics           | Новая очередь, недоступный Redis/SQL, caps, новая audit-role схема                  | Нет ложных нулей/полных counts и утечки данных                                    |
| Compatibility         | v1/v2/new/unknown job/binding, legacy photo, mixed image rollout/rollback           | Неизвестные схемы fail closed; старые claims/санкции не переигрываются            |

Для сложных последовательностей добавить model-based/property tests переходов
observe/edit/remove/qualify/reset/retry; модель должна формулировать продуктовые
инварианты независимо от Lua. Это полезнее тестов, которые повторяют строки
implementation. Прогоны декодирования и нагрузочные fixtures должны быть реальными.

## Проверки и выпуск runtime-исправления

Этот раздел относится к реализованному runtime-исправлению. Локальные проверки
и выпуск обязательны; только дальнейшие docs-only уточнения не требуют деплоя.

1. Выполнить `node scripts/agent/preflight.mjs` и impact planner.
   При итерации использовать публичные workspace wrappers, не `*:unlocked`
   или `*:source`. Codegen/API проверки сериализовать с consumers.
2. Для новой истории и авторизации выполнить API checks, реальные Redis/BullMQ
   регрессии, PostgreSQL races и `check:prisma`, если меняется storage.
   Для контрактов/UI выполнить contracts, miniapp и admin checks;
   для deploy/SQL scripts выполнить `check:infra` и соответствующие agent tests.
   Общий blast radius истории, claim/dispatch и протокола требует `npm run check`.
3. Сверить invariant matrix реальными Redis/BullMQ/Sharp/PostgreSQL прогонами.
   Стендовый capacity прогон с production cgroup-лимитами остаётся отдельной
   эксплуатационной приёмкой перед утверждением SLA или повышением concurrency,
   лимитов и ресурсоёмкости. Локальный Docker daemon недоступен; выпуск не должен
   заявлять измеренную ёмкость. В отчёте отдельно перечислить пропущенные
   интеграции и ожидаемые ограничения.
4. Stage только файлы реализации. При текущем dirty tree чужие изменения
   не включать и не откатывать. Для параллельной runtime-работы использовать
   отдельный checkout/worktree; staged wrapper не принимает посторонние runtime inputs.
   Commit/push через `local-commit-push.sh`, дождаться `Required` и
   `Analyze JavaScript and TypeScript` для точного SHA.
5. Deploy через `vps-connect.sh` только затронутых компонентов. Shared API
   пересоздаёт все роли из topology и требуемый OCR auxiliary; Postgres/Redis
   не пересоздавать. Не обходить disk floor; при нехватке предпочесть проверенный
   preload immutable CI image. Contract/UI scope выбирать по planner.
6. Сохранить штатный webhook queue pause/drain/exact-image fence.
   Отдельно проверить прекращение старых active media/intent mutations и судьбу
   delayed jobs новой/старой версии: webhook fence сам по себе не является
   доказательством совместимости auxiliary queue. При сбое перехода не возобновлять
   queues до подтверждения одного совместимого image на всех ролях.
7. Выполнить strict smokes и read-only queue/diagnostic snapshots с timestamps.
   Живые сравнения/удаления/санкции выполнять только в явно назначенном тестовом
   чате с согласованным участником без admin immunity. Fleet-wide переключение
   control не является smoke и не входит в подготовку этого плана.
8. После выпуска сравнить два последовательных пятиминутных окна и один
   полный десятиминутный job lifetime: governor delays, attempts/backlog,
   expired/unverified, guard revocations и реальные receipts. При сохранении
   перегруза показывать degraded coverage; здоровый общий health её не доказывает.
   Для DAILY дополнительно проверить переход периода в тестовой зоне.

## Остановка и откат

Условия остановки: действие после завершённого отзыва, повторная санкция,
действие по отсутствующему/конфликтному proof, восстановление запрета через TTL,
переход DAILY, рост expiries при поступлении ниже измеренной ёмкости,
или ухудшение webhook/action SLO, связанное с выпуском.

Использовать существующий preview-first `off --expected-revision` с фактической
текущей revision. Точное состояние reread после CAS-конфликта. Off останавливает
новые действия, но не отменяет уже отправленный MAX-запрос; проверить активные
dispatch/receipts. Не расширять `MODERATION_DELETE_INTENT_MODE`, не сбрасывать
claims, counters, settings или ручные санкции ради повторного выполнения.

Откатывать через retained immutable release, который понимает новый permission
и binding protocol, проходит обновлённый source floor и Prisma compatibility.
Откат приложения не откатывает additive DB schema. Новый runtime control epoch
и отозванные decisions не возвращаются к старым значениям. Если совместимого
образа нет, сохранить off и выпускать исправление вперёд, а не включать старый
guard. Queue fence остаётся обязательным на обоих путях rollback.

## Улучшения после обязательных исправлений

- Durable cleanup lease вместе с preclaim и bounded SQL reconciler: восстановить
  только точного неиспользованного owner после его deadline, независимо от
  повторных stalls, failed-job eviction и потери BullMQ. Intent/event и более
  нового owner проверять в той же serializable транзакции; анализ не повторять.
- Единая типизированная причина решения во всех слоях вместо inference по
  свободному тексту exceptions; UI показывает состояние конкретного чата
  и известные исходы, не внутренние параметры worker.
- Ограниченный диагностический путь для обращения: обе публикации, время,
  mode/scope/allowance, источник, guard rejection и receipt. Только через
  закрытую авторизацию, без публикации исходного содержимого и токенов.
- Per-chat scheduling/coalescing и bounded reuse уже проверенных media proofs
  развивать по capacity результатам. Отдельный analysis worker/image или увеличение
  concurrency рассматривать лишь при доказанном bottleneck и review topology.
- Согласовать configuration photo/binary downloaders для официально подтверждённых
  источников, сохраняя отдельные безопасные бюджеты. Legacy flags удалять только
  отдельной миграцией после окончания поддерживаемой совместимости.
- Включить invariant/property и fault-injection набор в регулярный CI; тяжёлый
  load test выполнять при изменении алгоритма, resource limits или scheduling.

В рамках обязательного ремонта не менять продуктовую семантику exact IMAGE,
manual-release grace, CUSTOM matching, thresholds и per-author sanctions.
Обновить [rollout](operations/runbooks/message-duplicate-rollout.md) и
[exact photo runbook](operations/runbooks/exact-photo-duplicate-repair.md) при
реализации; датированные аудиты оставить историческим свидетельством.

## Результат доработки плана

Семь исходных недостатков получили зависимости, модули исправления и критерии
приёмки. Добавлен D8 с локальным воспроизведением потери false latch и десять
проверяемых рисков. План охватывает старые задания, explicit scope/version,
durable recovery, qualification/claim races, SQL column grants, capacity,
ограничения доказательств и совместимый откат.

Исходные 632 пройденных теста относятся к аудиту, не к реализации этого плана.
Исправление проверяется отдельными regression suites: реальные Redis/BullMQ/Sharp
переходы, PostgreSQL policy/claim races и полная API-проверка. Стендовая ёмкость
и переход DAILY в живом тестовом чате пока не подтверждены.
