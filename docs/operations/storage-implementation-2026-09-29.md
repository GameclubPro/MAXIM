# Реализация оптимизации хранения: 29 сентября 2026

Основание: [план](vps-storage-optimization-plan-2026-09-29.md),
[аудит](vps-storage-audit-2026-09-28.md),
[политика и матрица потребителей v1](storage-lifecycle-policy-v1.md).
Время измерений ниже указано в UTC; в Москве уже 29 сентября.

## Выполненные операции

S0 опубликован коммитом `6deacff165f06120194576afc40f5471635370ac`, проверен
локальными static/infra checks и синхронизирован с чистым VPS checkout без
перезапуска контейнеров. Штатный `postgres-audit storage` успешно выполнен после
синхронизации; диагностические запросы не читают содержимое прикладных таблиц.

28 сентября около 21:17–21:19 UTC после свежего preview выполнен
`vps-docker-space-reclaim.sh --until 24h`. Удалены только четыре ранее
проверенных immutable MAXIM image refs вне retained/current manifests и любых
контейнеров. Семидневное значение по умолчанию не изменено. Шесть манифестов
защищали семь image identities/refs; данные соседних проектов не очищались.

| Показатель                             |            До |         После |
| -------------------------------------- | ------------: | ------------: |
| Доступно на основном filesystem, bytes | 6 969 487 360 | 9 361 305 600 |
| Доступно, ГиБ                          |          6,49 |          8,72 |
| Docker images                          |            48 |            44 |

Измеренный прирост — **2 391 818 240 bytes, около 2,23 ГиБ**. Это разность
`df available` при продолжающейся работе приложения, не сумма размеров tags.
Ingress/admin ready успешны до и после операции. Redis: RDB status `ok`,
background save не выполнялся. Отдельный build cache не очищался.

## Изменения новых записей

- Предложения Major с фотографиями: атомарная запись медиа в существующую
  relation с `imageStorageVersion=1`; audit JSON содержит метаданные. Старый
  JSON reader и отдельные видео-форматы сохранены. Исправлено чтение имён файлов
  из компактных метаданных в списке предложений без загрузки bytes.
- VK import: равные JSON-поля сохраняют прежнее значение PostgreSQL, позволяя
  повторно использовать TOAST pointers. Каждое наблюдение по-прежнему обновляет
  `last_seen_at` и availability time; новые URLs/counters не пропускаются только
  из-за равного content hash. Active publication revision и ручные правки
  защищены прежними условиями.
- Storage audit дополнен группами структурно эквивалентных индексов, включая
  признаки constraint ownership, uniqueness, replica identity и clustering.
  Это кандидаты на проверку, без автоматического удаления.

Новый JSON-путь не переносит старые 19,6 ГиБ audit log автоматически. Сохранение
TOAST pointers уменьшает повторную запись неизменившихся крупных значений,
но не отменяет обновления самих строк и индексов времени наблюдения. Экономия
production bytes/day ещё не измерена.

## Проверки

На локальном одноразовом PostgreSQL **16.15** применены все миграции проекта.
Storage integration проверяет реальный SQL VK repository на изолированной
temporary table с production columns/indexes: пять повторных импортов сохраняют
те же TOAST chunk identities, время наблюдения обновляется, изменённый JSON/URL
сохраняется, ручное содержимое и активный publish key не перезаписываются.
Тест включён в обязательную CI PostgreSQL suite. Проверены legacy/compact media,
порядок смешанных bytes/token assets и отказ при несовместимом хранении.

Runtime SHA: `d43889587ca8b1ea292e9ebf02f0ccc6d0f3c55f`. Локальные проверки:
574 static/tool tests, 462 infra tests и ShellCheck, 13 332 API tests,
11 retention-storage tests, typecheck/build; целевые тесты на реальном PG16
выполнены отдельно без пропуска. CI и CodeQL зелёные для точного runtime SHA.
Image preload проверил checksum и бюджет: 9 379 577 856 bytes available,
733 203 968 bytes archive, 4 294 967 296 bytes обязательного резерва.

Production release: `release-20260928T215905Z-d43889587ca8`. Все 14 API ролей и
OCR auxiliary переведены на точный образ; очереди возобновлены после image fence,
local ingress/admin live/ready, public live, sandbox isolation/UDS raster и OCR
readiness прошли. PostgreSQL и Redis не пересоздавались: оба сохраняют
`StartedAt` от 17 сентября и `RestartCount=0`.

Сразу после rollout readiness уже прошла, но governor оставался в штатном
`stabilizing`: первое окно 22:02:40–22:05:00 UTC нельзя объявлять полностью
здоровым по system mode. В 22:06:50 режим вернулся в `normal/healthy`;
последующая проверка в 22:09 UTC: readiness true, queue lag 0,169 с,
1 058 успешных действий из 1 058 за текущую минуту. Это короткое наблюдение,
не доказательство суточной экономии или недельного SLO.

Контрольное окно после стабилизации 22:10:20–22:12:40 UTC: 10 samples,
complete coverage, `healthy`, максимум sampled oldest queue lag 0,818 с,
новых рестартов 0. Baseline 21:44:00–21:46:20 UTC: 9 samples, complete coverage,
`healthy`, максимум 1,219 с, новых рестартов 0. Это сопоставимые короткие окна,
но их разность нельзя приписывать оптимизации или выдавать за HTTP latency.

После загрузки нового образа доступно 8 213 409 792 bytes (7,65 ГиБ), root 98%.
Повторный manifest-aware preview после релиза не нашёл новых кандидатов.
Следовательно, reclaim дал реальный выигрыш, но релиз использовал часть запаса
и целевые 40 ГиБ по-прежнему не достигнуты.

28 сентября в 21:43 UTC расширенный каталог прошёл plain EXPLAIN и live report
на production: 147 relations, 563 indexes. Найдена одна эквивалентная пара:
`webhook_events_membership_chat_created_at_idx` (311 410 688 bytes) и
`webhook_events_channel_membership_created_idx` (311 074 816 bytes). Оба
non-unique, valid/live, без constraints/replica identity/clustering; две исходные
миграции создают одинаковый `(normalized_payload->'message'->>'chatId', created_at)`
partial index для `user_added/user_removed`. Потенциальная экономия удаления
одного — около 297 МиБ, не сумма обоих. Удаление ещё не выполнено: нужна
отдельная guarded migration и проверка её восстановления после timeout.
Диагностика дополнительно исправлена коммитом `6e253627`: сравнение использует
канонический `pg_get_expr`, а не внутренний AST с позициями исходного SQL;
NULL uniqueness semantics выводятся отдельно. Проверено пятью тестами, static /
infra checks и на PG16; исправление синхронизировано на VPS. Повторные EXPLAIN /
report в 22:05 UTC подтвердили ту же единственную пару.

## Ёмкость и восстановление

После reclaim на root около 8,7 ГиБ: это ниже 20 ГиБ для API build и ниже целевых
40 ГиБ эксплуатационного запаса. API release допускается только через штатный
preload проверенного CI image с его проверкой archive size + 4 ГиБ reserve и
reuse-only deploy. Снижать floors не требуется.

Cold filesystem: 223 001 993 216 bytes (207,69 ГиБ) available. Каталог
`/mnt/maxim-cold/backups/maxim` содержит старые dumps, самый поздний найденный —
`maxim_20260827T033817Z.dump` (25 905 742 226 bytes). Backup/restore-smoke services
inactive; `ExecMainExitTimestamp` пуст, поэтому `Result=success` не является
доказательством выполненного restore. Полная копия текущего тома PostgreSQL
около 241,6 ГиБ на свободную часть cold-диска не помещается даже без WAL/запаса.

Штатный `restore-postgres-backup-smoke.sh --preflight-only` проверил checksum
дампа от 27 августа и отказал по capacity: **325 053 481 757 bytes required**
при **223 001 993 216 bytes available**. Это фактический guard скрипта
(`125% database bytes + 2 GiB`), а не оценка по размеру сжатого архива.

Исправлен отдельный operational defect: сервис backup настроен на
`maximadmin:maximadmin`, а его существующий `.maxim-postgres-backup.lock` был
`0600 root:root`. При inactive service под общим deploy lock и nonblocking
flock на том же inode изменён только владелец этого файла; mode остался `0600`.
После исправления `backup-postgres.sh --preflight-only` дошёл до capacity gate:
260 477 434 903 bytes required против 223 001 993 216 available. Скрипт не
создавал новый dump и не удалял старые поколения в режиме preflight.

Проверено реальное восстановление **локальной зашифрованной копии от 27 августа**.
После проверки SHA-256 `.age` поток `age --decrypt | pg_restore --exit-on-error
--no-owner --no-acl` восстановлен в изолированную PostgreSQL 16.15 на loopback,
без API/Redis/MAX workers. Pipeline завершился с кодом 0, ошибок нет. Контроль
в 22:04 UTC: 91 015 822 359 bytes базы, 116 public tables, 438 indexes,
0 invalid/not-ready indexes, 244 завершённых миграции. Продолжительность
восстановления до контрольной проверки — не более 23 минут на этом компьютере.
Это не RTO текущей production БД: архив старый, железо другое, запуск нового
приложения и согласование post-backup внешних действий не проверялись.
Временный PostgreSQL остановлен, восстановленные plaintext данные и runtime
удалены; исходные encrypted backups и ключи не изменялись.

Варианты следующего capacity gate:

- Дополнительные 100 ГиБ root дадут около 108 ГиБ до следующих операций:
  достаточно для эксплуатационного резерва и последовательного обслуживания
  небольших объектов, но не гарантируют полную перепись webhook на 112,8 ГиБ.
- Для полной переписи крупнейшей таблицы нужен отдельный бюджет:
  размер новой копии + WAL/change log + резерв + concurrent runtime growth.
  Не запускать её как первую операцию даже после расширения.
- Restore на cold требует ещё примерно 95,0 ГиБ только для текущего preflight.
  Добавление 100 ГиБ оставило бы слишком мало места для свежего dump. Более
  реалистичный предварительный ориентир — +150 ГиБ, уточняемый по свежему backup
  и необходимым temporary/WAL files.
  Альтернатива — отдельная проверенная площадка восстановления. Локально при
  реализации было 731 ГиБ свободно; эта площадка уже проверена для старого
  архива, но не является постоянно доступным production restore target.

Платные ресурсы не заказаны. Попытка read-only inventory через настроенный
профиль Yandex Cloud `cod-sa` вернула `PermissionDenied`; стоимость и конкретные
cloud disk IDs не установлены. Для расширения нужны решение владельца о платных
ресурсах и соответствующие права в облаке. До свежего backup/restore и бюджета
destructive backfill, generic TTL, REINDEX/repack/VACUUM FULL не выполняются.

## Оставшиеся этапы и условия

| Этап  | Состояние                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| S0    | Диагностика опубликована, установлена, выполнена                                                             |
| S1    | Reclaim и local restore старого архива выполнены; fresh backup/restore и достаточный резерв остаются открыты |
| S2    | Зафиксированы consumers, holds и консервативная policy v1; конечный replay/restore horizon не доказан        |
| S3    | Компактный webhook format не включён: SQL/raw consumers требуют отдельной совместимости                      |
| S4    | Новый image writer развёрнут; исторический backfill зависит от restore/CAS/budget                            |
| S5–S7 | Proof/holds и destructive runner не реализованы; текущие receipts/claims сохраняются                         |
| S8    | VK TOAST reuse и equivalent-index диагностика развёрнуты; индексы не удалялись                               |
| S9    | PostgreSQL physical reclaim не выполнялся: сначала restore и capacity gate                                   |
| S10   | Partitioning отложен до доказанной необходимости и совместимой identity модели                               |
| S11   | Unattended cleanup не включён; семидневного наблюдения ещё нет                                               |

Это завершение безопасного первого релиза, а не заявление о выполнении всей
многонедельной программы или о достижении 40 ГиБ свободного места.
