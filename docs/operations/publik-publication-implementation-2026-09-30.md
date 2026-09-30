# Публик: реализация улучшений, 30 сентября 2026

Основание: [аудит и план](publik-publication-audit-plan-2026-09-30.md).
Изменения выполнены в изолированном worktree. Чужие незавершённые изменения
исходной рабочей папки сохраняются отдельно; опубликованные изменения main
учитываются при интеграции. PostgreSQL/Redis production не пересоздаются.
Для устойчивого явного повтора добавлено одно nullable поле `retry_authorized_at`
без DEFAULT, backfill, индекса или изменения существующих публикаций.

## Реализованное поведение

| Находки | Изменение                                                                                                                                                                                                                                        |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1/F2   | Истечение положительной проверки автоматически номинирует срочную точную проверку Публика; права не выдаются до её завершения. Плановые bot probes отделены от обслуживания каталога/roster.                                                     |
| F1      | Обслуживание roster использует свежий SQL proof без повторного bot probe. Смена proof во время выполнения вызывает обычный durable retry, а не ложное завершение.                                                                                |
| F1      | Актуальность полномочий автора перед новым send/pin ограничена 15 минутами; трёхдневный grant остаётся для discovery. Просроченная положительная запись номинирует целевую проверку, свежий отказ сохраняется.                                   |
| F1      | Отдельная preflight lane проверяет адресатов ближайших пяти минут, каждые 15 секунд, максимум 100 targets и четыре occurrences за проход. Fanout продолжает ограниченную страницу по position.                                                   |
| F1      | Aged scheduled queue jobs присоединяются к срочному FIFO после 60 секунд; manual priority сохраняется. Сканирование/удаление/смена приоритета используют прежний общий предел 5 000 jobs и concurrency 8.                                        |
| F3      | Единое окно 5 минут применяется к никогда не начатым scheduled sends и после materialization. NOW, реальные прежние попытки и receipt recovery сохраняют собственные правила.                                                                    |
| F3      | Явный Retry автора сохраняется при подготовке и действует пять минут. Счётчик claim уменьшается только при доказанном отсутствии начала MAX request.                                                                                             |
| F3      | Разрешение явного повтора хранится отдельно от временных blockers: проверка прав/пауза больше не стирает новый Retry. Safe cleanup пропущенного до HTTP запуска проверяет все envelopes и сохраняет настоящие попытки/receipts.                  |
| F4      | Временная recurrence-ошибка получает guarded backoff 60-75 секунд под calendar lock. Reconciliation больше не отменяет этот backoff; cancel/content/schedule revision races проверяются.                                                         |
| F6      | Retry-After seconds/date и вложенные причины не сокращают указанный сервером срок до часа. Двухчасовой запрет сохраняется в nextSendAt.                                                                                                          |
| F7      | Фоновая задача, ожидавшая 15 секунд, получает обслуживание раньше нового deadline. Уже работавшая coalescing-защита ограничивала starvation; исходная формулировка риска уточнена.                                                               |
| F8      | Pin различает неизвестные полномочия и подтверждённый отказ, номинирует проверку и ограничивает неизвестность 30 минутами. Отмена даёт SKIPPED, отказ FAILED. RUNNING/AMBIGUOUS не повторяются.                                                  |
| F9      | Поиск выбирает страницу публикаций автора непосредственно SQL, без массива всего совпавшего каталога. Correlation и LATERAL предотвращают выявленные глобальные hashed subplans/catalog-first joins.                                             |
| F10     | Просроченный положительный snapshot отображается как «Проверяем права Публика». Read-only polling ограничен; deny/removal/unknown не маскируются автоматическим grant.                                                                           |
| F10     | Polling прекращается на завершённых/отменённых публикациях даже при историческом blocker/cached pending counter. Смена адресата отменяет прежний recheck.                                                                                        |
| F3/F10  | «Нужно решение» относится к пропущенному окну, а не AMBIGUOUS. Будущая дата отделяется от старого пропуска; разбор конкретного запуска доступен и без созданных delivery rows. Failed/MISSED причина сохраняется при наличии execution envelope. |
| F11     | Receipt CAS создаёт identifier-free timing event от исходного scheduledAt или NOW intent до сохранённого receipt; причины deferral/missed/skipped отделены. Все refresh attempts учитываются в ограниченных минутных гистограммах.               |
| F12     | Новые настоящие PostgreSQL/Redis тесты проверяют авторизацию, SQL планы, гонки и crash/queue restore. MAX HTTP в этих тестах заменён управляемым ответом.                                                                                        |
| F1/F5   | Ограниченная production-диагностика отдельно показывает устаревшую 15-минутную проверку автора; трёхдневный discovery grant больше не обозначается как готовность к отправке.                                                                    |
| F13     | Правка текста сохраняет ERROR расписания. Явное сохранение неизменённой неограниченной RECURRENCE проходит проверки и восстановление; ограниченная серия требует нового расписания. Ошибка видна даже при ACTIVE публикации.                     |
| F14     | Необязательный URL lookup исключён из пути сохранения receipt Публика; ссылку для включённых comment/suggestion features получают только после успешного receipt CAS. Ошибка ссылки не меняет SENT и не препятствует записи dialog reference.    |
| F15     | «Версия для повтора» сохраняет только title/content и request/revision identity, не создавая новый NOW выход и не меняя audience/schedule/intent. Отсутствующие поля PATCH больше не заполняются create-defaults Zod 4.                          |

## Уточнения Политики

- TTL прав не увеличен и не отменён. Проверяется свежий снимок полномочий; окончание
  срока записи не является доказательством снятия роли в MAX.
- Авторизация перед отправкой защищает новую публикацию независимо от того, когда
  последний раз обслуживался общий roster. Disabled policy, removal, свежие denials,
  bot identity, lifecycle/member epochs и route quarantine сохраняют свои границы.
- При частичной отправке сохраняется существующая политика завершения оставшихся
  адресатов и восстановления прежних receipts. SENT/AMBIGUOUS не пересоздаются.
- Never-started scheduled после пяти минут пропускается. Ручной Retry является новым
  явным разрешением, но сохраняет прежние content/intent/revision guards. Это не
  обещание автоматического catch-up всех пропущенных постов.
- Final send guard повторно проверяет полномочия автора после очереди/подготовки.
  Выбор маршрута больше не считается началом HTTP; реальные inline attempts остаются
  в provenance. Publication 429 сразу переносится через durable Retry-After, без
  преждевременных inline повторов, включая NOW.
- Preflight обслуживает persisted targets. Новые адресаты LIVE audience, ещё не
  подготовленные расписания и перезапуск preflight обслуживаются обычными execution
  guards; номинация никогда не заменяет проверку перед самой отправкой.
- Предел 4 background rps остаётся. При fleet выше бюджета нельзя обещать обновление
  всех подключений за 15 минут; увеличение concurrency этого предела не меняет.
  Приоритет получают реальные ближайшие публикации, возраст очереди теперь измеряется.

## Верификация

На этапе focused checks:

- Расписания/Retry-After/author freshness и совместимость прежних Retry:
  финальные 11 suites, 376 tests, включая PostgreSQL, без пропусков.
- Ledger/crash/Redis restore: 7 сценариев с настоящими PostgreSQL/Redis и mocked MAX.
- Поиск: реальные semantics и EXPLAIN; fixture 3 000 адресатов/300 публикаций другого
  автора, без глобальных hashed subplans.
- Mini app CSS/typecheck и 1 433 unit tests; 12 strict screenshots кабинета и modules
  на Android/iPhone/iPhone SE в двух темах. Дополнительно 24 strict сценария
  пропущенного выхода и будущего расписания на тех же устройствах/темах.

Прежние marker-only Retry атомарно сохраняют исходное время авторизации перед
заменой blocker; отдельное поле имеет приоритет даже после окончания своего окна.
Очистка перед HTTP проверяет отсутствие попыток, receipts и чужих leases во всём
запуске. Отменённое закрепление больше не обозначается как истечение срока.

Интеграция с опубликованным main `87a2d4f5766b447fb9adc65756b0506b3420335b`
сохраняет независимую duplicate migration и оба набора PostgreSQL тестов.
Общий immutable baseline пересчитан; в disposable БД обе миграции применены,
проверка drift прошла без новых расхождений относительно принятого baseline.

Наборы пересекаются; их суммы не являются числом уникальных тестов.
Окончательный staged snapshot прошёл repo wrapper перед commit:

- API: 642 suites, 13 932 tests без пропусков, настоящие PostgreSQL/Redis;
  retention PostgreSQL дополнительно 11/11. Typecheck, build и Prisma прошли.
- Mini app: 1 433/1 433 tests, TypeScript/CSS и production build прошли;
  итоговый visual smoke: 13 сценариев, layout/contrast/accessibility прошли.
- Static/agent checks: 606 tests; infra: 494 tests и ShellCheck прошли.
- Дополнительные проверки после commit: contracts 39 suites/311 tests;
  Safety Desk 15 tests, typecheck/build и desktop/narrow browser smoke прошли.
- Production dependency audit в CI: ноль runtime vulnerabilities.

PostgreSQL tests выполнялись в UTC, как в CI: raw pg/Prisma fixtures вне UTC
получают расхождения на три часа. Первый production build
выявил статическую связь modules → publication target selection → editor model →
runtime contracts/Zod. Единственная eligibility-функция перенесена в лёгкий
readiness module с re-export для текущих потребителей. Повторный production build
прошёл без изменения budgets: chat settings 144,3/145,1 КБ, Publisher modules
48,0/50,0 КБ, VK card 81,2/86,0 КБ gzip.

Implementation commit: `71b8e8a36ffd771f6267fc23bedcf699210db92b`.
Release target: `eacc4e88def69fdbacdc6ffde4c35fe4c3f13183`; относительно implementation
commit этот merge меняет только независимый отчёт антидубля, runtime совпадает.
Required и Analyze JavaScript and TypeScript зелёные для обоих SHA.
Для release target: [CI](https://github.com/GameclubPro/MAXIM/actions/runs/36757935956)
и [CodeQL](https://github.com/GameclubPro/MAXIM/actions/runs/36757936565).

## Выпуск

Production release: `release-20260930T184848Z-eacc4e88def6`, 30 сентября 2026.
Обычный `deploy main --auto` завершился успешно после green exact-SHA CI.
API и mini app использовали проверенные immutable CI images без сборки на VPS.
Воспроизведённый серверный impact plan выбрал только `api-shared` и
`miniapp-major-static`: изменения общих dependencies и Safety Desk уже находились
в предыдущем production release `87a2d4f5766b447fb9adc65756b0506b3420335b`.
Предварительно загруженный admin image не потребовал пересоздания Safety Desk.

- Все 14 API roles и OCR auxiliary перешли на exact target `eacc4e88...`;
  mini app также на `eacc4e88...`, admin-static наследует подтверждённый `87a2d4f...`.
- Миграция `20260930190000_add_publication_retry_authorization` успешно применена.
- Webhook queues были защищены общей pause fence на время смены версии;
  fence снят после проверки единого API image. PostgreSQL/Redis не пересоздавались.
- Strict ingress/admin live+ready, public live, OCR isolation/UDS/languages/shadow
  и `https://major-maksimov.ru/app/` smokes прошли; release manifest записан.
- Во время ожидания readiness были временные HTTP 503; обычный deploy дождался
  готовности без повторного запуска, bypass или ручной записи manifest.

Первая проверка после выпуска подтвердила пять health endpoints, точную
идентичность Publisher runtime, свежий heartbeat, готовые secrets и отсутствие
Publisher pause. Ingress/admin queue lag был 4,058/4,156 секунды при пороге 10 секунд.
Общие MAX success counters не используются как доказательство доставки публикаций.

Ограниченные `publisher-publications --explain` и report прошли последовательно:
10 index scans, без physical sequential scans. Выборка: 65 occurrences;
FAILED/AMBIGUOUS по 32 и обе насыщены, один SCHEDULED. Из 142 sampled targets
140 соответствовали `metadata_ready`, два — `binding_not_connected`;
категорий устаревшего author proof или bot snapshot в этой выборке не было.
`metadata_ready` подтверждает только выбранные локальные metadata/freshness
критерии, а не полный MAX write permission или новое разрешение на повтор.
Из 129 sampled deliveries 117 имели попытку и receipt, четыре — попытку без
receipt, восемь не имели попытки. Target sample усечён у девяти occurrences,
delivery sample — у восьми; это не полный census и не измерение нового SLO.

Наблюдение 18:57:01–19:00:45 UTC: запрошено 180 секунд, заключительный тяжёлый
проход завершился через 224 секунды. Получены 12 capacity samples и четыре полных
снимка, archive coverage полная, максимальный интервал 56,64 секунды. Все readiness
HTTP 200; API fleet 14/14 на точном image, restart count ноль, queue fence clear.
Первые три mode samples были degraded/stabilizing, последний — normal/healthy.
Sampled oldest queue lag p50 0,159 с, p95/max 1,812 с; это входящая очередь,
а не задержка публикаций. Свободно 26,96–26,98 GiB, disk warning сохраняется.

Ограниченная ненасыщенная выборка Publisher logs за 18:53:00–19:00:45 UTC:
612 строк, 526 observations сохранения receipt. Измерены delivery observations,
а не уникальные посты; возможны fanout, прежние intents и startup recovery.

| Mode/media      | Observations | p50      | p95       | p99       | Max       |
| --------------- | ------------ | -------- | --------- | --------- | --------- |
| NOW/text        | 512          | 23,594 с | 137,368 с | 159,171 с | 184,794 с |
| SLOTS/text      | 8            | 23,298 с | 32,892 с  | 32,892 с  | 32,892 с  |
| RECURRENCE/text | 6            | 11,382 с | 19,642 с  | 19,642 с  | 19,642 с  |

Эта выборка не подтверждает начальные цели NOW p95 ≤ 3 с или scheduled p95 ≤ 5 с /
p99 ≤ 15 с. Для проверки целей нужны размер fanout, стадийные измерения и длительный
baseline. Успешный health или средняя скорость очереди не закрывают эту приёмку.

Refresh windows: 1 594 attempts, 1 554 returned, 40 thrown. `returned` не означает
grant. `publication_due`: девять returned; `publication_actor_due`: 13 returned /
один thrown, queue age обоих срочных типов в пределах 60-секундного histogram bucket.
Обычные scheduled probes: 804 returned, у 567 queue age больше 60 секунд;
`stale_user_access`: 39 thrown. Зафиксированы 11 author-access deferrals и
11 соответствующих guard warnings; это одни события, их нельзя суммировать.
Общие monitor log scans насыщались 14 раз: отсутствие ошибок во всех журналах
не установлено. Узкий Publisher timing-срез не насыщен.

Дополнительный fixed audit связывает blocker/delivery группы с occurrence status,
а delivery группы — также со schedule status. Join работает только по уже
ограниченному materialized sample; новые columns/grants/table sources не добавлены.
PGlite regression различает одинаковые PENDING deliveries у двух состояний
расписания без вывода идентификаторов; весь focused audit suite 6/6 прошёл.
Diagnostic commit `96a91c92138ea1ad4d37927d6af75b05c92948e9` прошёл staged
static/docs/infra checks (495 infra tests), Required и CodeQL. Обычный
`deploy main --plan` синхронизировал server tooling и подтвердил отсутствие
компонентов для пересоздания. Повторные EXPLAIN/report завершились последовательно:
корреляция использует только Hash Join ограниченных materialized CTE, без новых
широких table sources.

Единственный sampled SCHEDULED с возрастом 52 163 секунды относится к ACTIVE
публикации с RECURRENCE schedule в ERROR. Все восемь sampled targets metadata-ready,
delivery rows отсутствуют. Обработчик требует ACTIVE schedule, поэтому этот выход
не выполняется. Это установленная причина исключения из обработки; первопричина
самого ERROR не выводится fixed catalog, её нельзя приписывать истечению прав.

Локальный review обнаружил воспроизводимую ошибку согласованности: publish-правка
текста/названия выставляла publication lifecycle ACTIVE, но без смены audience,
schedule или intent не перестраивала прежний ERROR schedule. Интерфейс смотрел
только lifecycle и скрывал ERROR расписания. Это подтверждённый дефект текущего
пути обновления, совместимый с sampled состоянием; он не устанавливает причину
первоначального перехода конкретного production расписания в ERROR.
Обычная content/title правка сохраняет ERROR, поскольку rollup также ставит ERROR
после FAILED/PARTIAL/AMBIGUOUS в NOW/ONCE. Автоматическое перестроение NOW из такой
правки могло бы создать новый send intent. Явное сохранение неизменённого
неограниченного RECURRENCE использует существующие validation, calendar/revision
и cancellation guards. Для ограниченного числа повторений требуется новое
расписание: прежний лимит не сбрасывается при таком восстановлении.
Прежние attempted/ambiguous остаются отдельными запусками.
Для восстановления одинакового ERROR-расписания требуется явно переданный
`intent: 'publish'`. Отсутствующий intent в PATCH не возобновляет серию,
даже если клиент передал прежнее правило вместе с названием или содержимым.

Проверка client payload выявила отдельный риск: «Версия для повтора» использовала
общий update builder, который передавал NOW schedule и SNAPSHOT audience вместе
с новым содержимым. Такая правка могла создать отдельный NOW occurrence до
повтора исходного выхода. Для retry-version update передаются только content/title
и revision/request identity; исходные schedule/audience/intent сохраняются.

Сервисные регрессии также выявили семантику Zod 4: `createBase.partial()` сохраняет
внутренние defaults, поэтому пропущенные PATCH schedule/title/intent превращались
в null/пустую строку/publish. Update schema должна сохранять отсутствие этих полей,
при этом create defaults и defaults внутри явно переданного content остаются.

Другой подтверждённый источник лишней задержки: routed send после MAX success
мог выполнить один-два GET для получения URL перед сохранением delivery receipt.
В live dispatcher URL используется только для включённых комментариев/предложений.
Размер вклада в observed p95 неизвестен. Эта работа исключена для обычных публикаций
и выполняется после receipt persistence только для включённых кнопок. Сохраняются
точный bot, исходные lane/source и обычное поведение остальных routed callers.
Проигравший normal/fallback receipt CAS не запускает lookup; ошибка lookup сохраняет
SENT и безопасную запись dialog reference без URL. Существующий message runtime
владеет этой необязательной работой; guard budgets не повышены.
Распределение бюджета, последовательный fanout и проверки полномочий сохраняются;
из короткого среза нет основания повышать concurrency или rps.

## Проверка Дополнительных Исправлений

Implementation commit: `db27648231c3768485445c5389b58b36ad59d2b5`.
Staged snapshot проверен через обычный commit/push wrapper:

- API: 643 suites, 13 977 tests без пропусков с настоящими PostgreSQL 16/Redis 7;
  retention дополнительно 11/11, TypeScript и серверная сборка прошли.
- Все миграции применены в новой disposable БД; drift соответствует принятому
  baseline. В этом дополнительном выпуске новых миграций нет.
- Contracts: 39 suites/324 tests; mini app: 1 439 tests; Safety Desk: 15 tests.
  Сборки всех потребителей, CSS, прежние bundle budgets и browser smokes прошли.
- Static/agent checks: 607 tests; preflight, refactor guards, документация
  и `git diff --check` прошли.
- Отдельный мобильный набор: 54 strict сценария на Android/iPhone/iPhone SE
  в двух темах, включая загруженные редакторы recurrence и ONCE retry.
  Итоговый staged visual smoke также прошёл.

Регрессии закрепляют отсутствие новых отправок при content-only retry update,
отсутствие create-defaults в PATCH, явное разрешение восстановления серии,
сохранение её конечного лимита и порядок receipt CAS → optional lookup → reference.
Получение ссылки после проигранного CAS запрещено; ошибки ссылки не меняют SENT.

## Дополнительный Выпуск

Production release: `release-20260930T204621Z-db27648231c3`.
Required и CodeQL зелёные для exact SHA `db27648231c3768485445c5389b58b36ad59d2b5`:
[CI](https://github.com/GameclubPro/MAXIM/actions/runs/36773322860),
[CodeQL](https://github.com/GameclubPro/MAXIM/actions/runs/36773322780).
Проверенные immutable CI images предварительно загружены для API, mini app и
Safety Desk. Обычный `deploy main --auto` выбрал все три компонента из-за изменения
общего контракта; все 14 API roles, OCR auxiliary и обе active static services
перешли на этот SHA. PostgreSQL/Redis не пересоздавались, pending migrations нет.
Очереди защищены при смене версии и возобновлены после exact-image fence.
Все строгие API/static/OCR smokes прошли; manifest записан. Временные readiness 503
во время прогрева разрешились обычным ожиданием deploy, без bypass или перезапуска.

Publisher status после выпуска: exact runtime, свежий heartbeat, secrets ready,
dispatch pause отсутствует. Пять health endpoints успешны. Наблюдение запрошено
на 180 секунд; его последний полный проход завершился в 20:53:15 UTC.
Capacity report за 20:49:29–20:53:41 UTC содержит 12 samples, complete coverage,
max gap 63,577 с. Readiness, queue metrics/fence и fleet 14/14 без failures,
restarts ноль. Sampled oldest queue lag p50 0,086 с, p95/max 1,131 с.
Mode в этом окне — degraded/stabilizing; заключительные health checks после окна
подтвердили normal/healthy и queue lag 0. Disk warning ниже 40 GiB сохраняется
при примерно 25,5 GiB свободного места; deploy capacity gates пройдены.

Повторные fixed EXPLAIN/report выполнены последовательно: десять Index Scan,
без physical sequential scans и новых grants. Sample по-прежнему включает
32 FAILED, 32 AMBIGUOUS (обе группы насыщены) и один SCHEDULED с возрастом
57 546 секунд. Последний имеет ACTIVE publication, ERROR RECURRENCE schedule,
восемь metadata-ready targets и ноль delivery rows. Новая версия показывает
ошибку и даёт безопасный явный schedule-save; существующая строка автоматически
не возобновлялась. Исторические attempts/receipts не получили нового разрешения
на отправку, реальная первопричина первоначального ERROR не установлена.

Узкий bounded Publisher log read за 20:49:29–20:53:41 UTC: 38 строк, без насыщения
и parse failures; receipt_persisted observations отсутствуют. Эта выборка не
измеряет достигнутую скорость публикаций и не закрывает SLO. Рост concurrency/rps
не выполнялся. Пользовательские каналы не использовались для тестовых публикаций;
настоящий MAX WebView и семидневная приёмка остаются отдельными проверками.

## Операционная Приёмка

F5 не закрывается массовым Retry. Routine production-диагностика использует только
проверенный каталог `vps-connect.sh postgres-audit publisher-publications`, сначала
с `--explain`. Он ограничивает выборку и время запроса, не вызывает MAX и не выводит
идентификаторы или содержимое. Это выборочная диагностика, не полный перечень backlog.
Существующий `audit-publication-backlog.ts` не заменяет этот production-путь: у него
нет тех же ограничений DB session/deadline и вывода. Исторические attempted/AMBIGUOUS
без доказанного результата требуют отдельного разбора через авторизованный продукт
и решения автора или оператора; данный выпуск не даёт им нового разрешения отправки.

Жалоба «Нужно решение» относится к другой категории: никогда не отправленный
scheduled запуск вышел за прежнее пяти-минутное окно. Задержка проверки прав или
общая пауза могла привести к этому состоянию. Для SLOTS той же revision пропуск
прошлой даты не останавливает будущую дату, но прежняя карточка смешивала их статусы.
После переноса revision старые blockers уже исключались SQL. Новый выпуск исправляет
скрытый разбор missing-envelope запуска и сохранение разрешения при повторе, а не
увеличивает срок отправки всех старых постов.

Migration review: ADD nullable TIMESTAMP(3) — metadata-only без переписывания таблицы,
но требует краткого ACCESS EXCLUSIVE lock. Старые строки остаются NULL. Старый API
игнорирует поле; rollback не удаляет его. При rollback новый Retry может раньше
перейти в пропуск после временного blocker, но не получает лишнего разрешения на send.

Read-only production baseline до выпуска: каталог заполнил обе ограниченные
выборки FAILED/AMBIGUOUS по 32 occurrences; старейшие записи около 34 дней.
Выборка содержит как receipts, так и попытки без remote ID. Это исторический
backlog с явной неполнотой выборки, не доказательство текущей потери новых постов.

Метрика receipt_persisted измеряет сохранение реального ответа, а не неизвестное
точное время приёма на стороне MAX. Потеря процесса между commit и log может потерять
событие; receipt-only recovery без исходного execution timing не включается как
новая доставка. База остаётся источником сверки SLO. Deferral event считает успешные
guarded отсрочки, а не уникальные публикации; mode/media/reason labels ограничены.

Семидневный baseline, семидневная проверка достигнутого SLO и настоящий MAX WebView
являются отдельной операционной приёмкой. Локальный аварийный тест использует только
синтетическую БД и тестовую очередь. Он подтверждает существующий внешний dispatch
fence при возврате старого состояния, но не заменяет полноценный host backup/restore
drill. Пользовательские каналы не используются для диагностических сообщений.

Долгие сессии с большим каталогом сохраняют прежний механизм TanStack Query:
обновление списка повторно читает уже загруженные страницы. Для дальнейшего снижения
нагрузки нужен отдельный ограниченный status-запрос; текущий выпуск не меняет
контракт каталога. Поздние уведомления после ухода с экрана устранены.
