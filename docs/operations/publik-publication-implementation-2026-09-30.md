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
