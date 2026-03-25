import { useEffect, useEffectEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../lib/cn';
import {
  BROADCAST_SCHEDULE_MAX_DAYS,
  BROADCAST_SCHEDULE_STEP_MINUTES,
  buildBroadcastScheduleSlotIso,
  countBroadcastScheduleDays,
  formatBroadcastScheduleDay,
  formatBroadcastScheduleSlot,
  getBroadcastScheduleDayKey,
  sortAndUniqueBroadcastSlots,
} from '../lib/broadcast-schedule';
import { maxImpact, maxSelectionChanged } from '../lib/max-bridge';

type BroadcastSchedulePlannerProps = {
  value: string[];
  occupiedSlots?: string[];
  error?: string;
  disabled?: boolean;
  resetKey?: string | number;
  onChange: (nextValue: string[]) => void;
  onOpenDay?: (dayKey: string) => void;
  onSelectionStateChange?: (state: BroadcastSchedulePlannerSelectionState) => void;
};

export type BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: number;
  selectedDayCount: number;
  slotCount: number;
  futureSlotCount: number;
  isDaySheetOpen: boolean;
  isConfirmed: boolean;
};

type BroadcastScheduleSheetStep = 'time';

type SlotGroup = {
  label: string;
  start: number;
  end: number;
};

const SLOT_GROUPS: SlotGroup[] = [
  { label: 'Ночь', start: 0, end: 6 * 60 },
  { label: 'Утро', start: 6 * 60, end: 12 * 60 },
  { label: 'День', start: 12 * 60, end: 18 * 60 },
  { label: 'Вечер', start: 18 * 60, end: 24 * 60 },
];
const PLANNER_NOW_REFRESH_MS = 5_000;

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 24 * 60 * 60 * 1_000);
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 0, 0, 0, 0);
}

function startOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1, 0, 0, 0, 0);
}

function endOfMonth(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth() + 1, 0, 23, 59, 59, 999);
}

function getMonthKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
}

function parseMonthKey(value: string): Date {
  const [yearRaw, monthRaw] = value.split('-');
  const year = Number.parseInt(yearRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  return new Date(year, Math.max(0, month - 1), 1, 0, 0, 0, 0);
}

function formatMonthKey(value: string): string {
  const date = parseMonthKey(value);
  return new Intl.DateTimeFormat('ru-RU', {
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function formatDayChipLabel(dayKey: string): string {
  const date = new Date(`${dayKey}T12:00:00`);
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'short',
  }).format(date);
}

function formatCountLabel(count: number, singular: string, few: string, plural: string): string {
  const remainder10 = count % 10;
  const remainder100 = count % 100;

  if (remainder10 === 1 && remainder100 !== 11) {
    return `${count} ${singular}`;
  }

  if (remainder10 >= 2 && remainder10 <= 4 && (remainder100 < 12 || remainder100 > 14)) {
    return `${count} ${few}`;
  }

  return `${count} ${plural}`;
}

function getMonthKeys(windowStart: Date, windowEnd: Date): string[] {
  const keys: string[] = [];
  const cursor = startOfMonth(windowStart);
  const lastMonth = startOfMonth(windowEnd);

  while (cursor.getTime() <= lastMonth.getTime()) {
    keys.push(getMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return keys;
}

function getMonthCells(monthKey: string): Date[] {
  const monthStart = parseMonthKey(monthKey);
  const gridStart = addDays(monthStart, -((monthStart.getDay() + 6) % 7));
  const cells: Date[] = [];
  for (let index = 0; index < 42; index += 1) {
    cells.push(addDays(gridStart, index));
  }
  return cells;
}

function getMinutesList(group: SlotGroup): number[] {
  const values: number[] = [];
  for (let minute = group.start; minute < group.end; minute += BROADCAST_SCHEDULE_STEP_MINUTES) {
    values.push(minute);
  }
  return values;
}

function formatMinuteLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function getSelectedDaySlots(dayKey: string, slots: string[]): string[] {
  return slots.filter((slot) => getBroadcastScheduleDayKey(slot) === dayKey);
}

function sortDayKeys(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function formatDaySummary(dayKeys: string[]): string {
  const labels = sortDayKeys(dayKeys).map((dayKey) => formatDayChipLabel(dayKey));
  if (labels.length <= 2) {
    return labels.join(', ');
  }

  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

export function BroadcastSchedulePlanner({
  value,
  occupiedSlots = [],
  error,
  disabled = false,
  resetKey,
  onChange,
  onOpenDay,
  onSelectionStateChange,
}: BroadcastSchedulePlannerProps) {
  const [anchorNow] = useState(() => new Date());
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const normalizedValue = sortAndUniqueBroadcastSlots(value);
  const scheduledDayKeys = sortDayKeys(
    normalizedValue.map((slot) => getBroadcastScheduleDayKey(slot)),
  );
  const initialDayKey = scheduledDayKeys[0] ?? getBroadcastScheduleDayKey(anchorNow);
  const [activeDayKey, setActiveDayKey] = useState(initialDayKey);
  const [pickedDayKeys, setPickedDayKeys] = useState<string[]>([]);
  const [currentMonthKey, setCurrentMonthKey] = useState(() =>
    getMonthKey(new Date(normalizedValue[0] ?? anchorNow)),
  );
  const [sheetStep, setSheetStep] = useState<BroadcastScheduleSheetStep | null>(null);
  const [applyToAllPickedDays, setApplyToAllPickedDays] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const windowStart = startOfDay(anchorNow);
  const windowEnd = endOfMonth(addDays(anchorNow, BROADCAST_SCHEDULE_MAX_DAYS - 1));
  const monthKeys = getMonthKeys(windowStart, windowEnd);
  const visibleMonthKey = monthKeys.includes(currentMonthKey) ? currentMonthKey : monthKeys[0];
  const selectedDayCount = countBroadcastScheduleDays(normalizedValue);
  const occupiedSet = new Set(sortAndUniqueBroadcastSlots(occupiedSlots));
  const selectedSet = new Set(normalizedValue);
  const pickedDaySet = new Set(pickedDayKeys);
  const minimumTime = liveNowMs + 30_000;
  const liveTodayKey = getBroadcastScheduleDayKey(new Date(liveNowMs));
  const activeDaySlots = getSelectedDaySlots(activeDayKey, normalizedValue);
  const pickedDayLabel = formatCountLabel(pickedDayKeys.length, 'день', 'дня', 'дней');
  const pickedDaySummary = formatDaySummary(pickedDayKeys);
  const targetDayKeys =
    applyToAllPickedDays && pickedDayKeys.length > 1 ? pickedDayKeys : [activeDayKey];
  const isDaySheetOpen = sheetStep !== null;
  const pastSlotCount = normalizedValue.filter(
    (slot) => new Date(slot).getTime() < minimumTime,
  ).length;
  const futureSlotCount = normalizedValue.length - pastSlotCount;
  const isReviewStep =
    isConfirmed && normalizedValue.length > 0 && pickedDayKeys.length === 0 && !isDaySheetOpen;
  const slotCountLabel = formatCountLabel(normalizedValue.length, 'слот', 'слота', 'слотов');
  const dayCountLabel = formatCountLabel(selectedDayCount, 'день', 'дня', 'дней');

  const emitSelectionStateChange = useEffectEvent(
    (nextState: BroadcastSchedulePlannerSelectionState) => {
      onSelectionStateChange?.(nextState);
    },
  );

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setLiveNowMs(Date.now());
    }, PLANNER_NOW_REFRESH_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (pickedDayKeys.length > 0) {
      if (!pickedDayKeys.includes(activeDayKey)) {
        setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
      }
      return;
    }

    if (scheduledDayKeys.length === 0) {
      const todayKey = getBroadcastScheduleDayKey(anchorNow);
      setActiveDayKey(todayKey);
      setCurrentMonthKey(getMonthKey(anchorNow));
      return;
    }

    if (!scheduledDayKeys.includes(activeDayKey)) {
      setActiveDayKey(scheduledDayKeys[0] ?? activeDayKey);
    }
  }, [activeDayKey, anchorNow, pickedDayKeys, scheduledDayKeys]);

  useEffect(() => {
    if (pickedDayKeys.length === 0) {
      setSheetStep(null);
      setApplyToAllPickedDays(false);
      return;
    }

    if (pickedDayKeys.length === 1) {
      setApplyToAllPickedDays(false);
    }
  }, [pickedDayKeys]);

  useEffect(() => {
    setPickedDayKeys(scheduledDayKeys);
    setActiveDayKey(scheduledDayKeys[0] ?? getBroadcastScheduleDayKey(anchorNow));
    setSheetStep(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(false);
  }, [resetKey]);

  useEffect(() => {
    if (normalizedValue.length === 0) {
      setIsConfirmed(false);
    }
  }, [normalizedValue.length]);

  useEffect(() => {
    emitSelectionStateChange({
      pickedDayCount: pickedDayKeys.length,
      selectedDayCount,
      slotCount: normalizedValue.length,
      futureSlotCount,
      isDaySheetOpen,
      isConfirmed,
    });
  }, [
    emitSelectionStateChange,
    futureSlotCount,
    isConfirmed,
    isDaySheetOpen,
    normalizedValue.length,
    pickedDayKeys.length,
    selectedDayCount,
  ]);

  function replaceSlotsForDays(
    dayKeys: string[],
    updater: (dayKey: string, currentSlots: string[]) => string[],
  ) {
    const uniqueDayKeys = sortDayKeys(dayKeys);
    const cleaned = normalizedValue.filter(
      (slot) => !uniqueDayKeys.includes(getBroadcastScheduleDayKey(slot)),
    );
    const nextSlots = [...cleaned];

    for (const dayKey of uniqueDayKeys) {
      nextSlots.push(...updater(dayKey, getSelectedDaySlots(dayKey, normalizedValue)));
    }

    onChange(sortAndUniqueBroadcastSlots(nextSlots));
  }

  function isSlotUnavailable(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    if (new Date(slotIso).getTime() < minimumTime) {
      return true;
    }

    return occupiedSet.has(slotIso) && !selectedSet.has(slotIso);
  }

  function isSlotSelectedForDay(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    return getSelectedDaySlots(dayKey, normalizedValue).includes(slotIso);
  }

  function togglePickedDay(dayKey: string) {
    if (disabled) {
      return;
    }

    setIsConfirmed(false);
    setPickedDayKeys((current) => {
      const exists = current.includes(dayKey);
      const next = exists
        ? current.filter((item) => item !== dayKey)
        : sortDayKeys([...current, dayKey]);

      if (!exists) {
        setActiveDayKey(dayKey);
        onOpenDay?.(dayKey);
      } else if (activeDayKey === dayKey && next[0]) {
        setActiveDayKey(next[0]);
      }

      return next;
    });
    maxSelectionChanged();
  }

  function openTimeStep() {
    if (disabled || pickedDayKeys.length === 0) {
      return;
    }

    setIsConfirmed(false);
    if (!pickedDayKeys.includes(activeDayKey)) {
      setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
    }
    setApplyToAllPickedDays(pickedDayKeys.length > 1);
    setSheetStep('time');
    maxImpact('medium');
  }

  function finishPickedSelection() {
    setPickedDayKeys([]);
    setApplyToAllPickedDays(false);
    setSheetStep(null);
    setIsConfirmed(normalizedValue.length > 0);
  }

  function closeDaySheet() {
    setApplyToAllPickedDays(false);
    setSheetStep(null);
    maxImpact('soft');
  }

  function clearPickedSelection() {
    finishPickedSelection();
    maxImpact('soft');
  }

  function clearTargetDays() {
    setIsConfirmed(false);
    replaceSlotsForDays(targetDayKeys, () => []);
    maxImpact('soft');
  }

  function reopenDayStep() {
    setIsConfirmed(false);
    setPickedDayKeys(scheduledDayKeys);
    setActiveDayKey(scheduledDayKeys[0] ?? getBroadcastScheduleDayKey(anchorNow));
    setSheetStep(null);
    maxImpact('light');
  }

  function reopenTimeStep() {
    if (scheduledDayKeys.length === 0) {
      return;
    }

    setIsConfirmed(false);
    setPickedDayKeys(scheduledDayKeys);
    setActiveDayKey(scheduledDayKeys[0] ?? getBroadcastScheduleDayKey(anchorNow));
    setApplyToAllPickedDays(scheduledDayKeys.length > 1);
    setSheetStep('time');
    maxImpact('medium');
  }

  function toggleSlot(minutes: number) {
    if (disabled) {
      return;
    }

    const hasConflict = targetDayKeys.some(
      (dayKey) => isSlotUnavailable(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    );
    if (hasConflict) {
      return;
    }

    const shouldAdd = targetDayKeys.some((dayKey) => !isSlotSelectedForDay(dayKey, minutes));
    replaceSlotsForDays(targetDayKeys, (dayKey, currentSlots) => {
      const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
      return shouldAdd
        ? sortAndUniqueBroadcastSlots([...currentSlots, slotIso])
        : currentSlots.filter((slot) => slot !== slotIso);
    });
    maxImpact(shouldAdd ? 'light' : 'soft');
  }

  const monthCells = getMonthCells(visibleMonthKey);

  return (
    <>
      <section className={cn('broadcast-planner', disabled && 'is-disabled')}>
        <div className="broadcast-planner__calendar-card">
          <div className="broadcast-planner__calendar-head">
            <button
              type="button"
              className="broadcast-planner__month-button"
              onClick={() => {
                const currentIndex = monthKeys.indexOf(visibleMonthKey);
                if (currentIndex > 0) {
                  setCurrentMonthKey(monthKeys[currentIndex - 1] ?? visibleMonthKey);
                  maxSelectionChanged();
                }
              }}
              disabled={disabled || monthKeys.indexOf(visibleMonthKey) <= 0}
              aria-label="Предыдущий месяц"
            >
              ←
            </button>
            <strong>{formatMonthKey(visibleMonthKey)}</strong>
            <button
              type="button"
              className="broadcast-planner__month-button"
              onClick={() => {
                const currentIndex = monthKeys.indexOf(visibleMonthKey);
                if (currentIndex >= 0 && currentIndex < monthKeys.length - 1) {
                  setCurrentMonthKey(monthKeys[currentIndex + 1] ?? visibleMonthKey);
                  maxSelectionChanged();
                }
              }}
              disabled={disabled || monthKeys.indexOf(visibleMonthKey) >= monthKeys.length - 1}
              aria-label="Следующий месяц"
            >
              →
            </button>
          </div>

          <div className="broadcast-planner__weekdays" aria-hidden>
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>

          <div className="broadcast-planner__grid">
            {monthCells.map((cell) => {
              const dayKey = getBroadcastScheduleDayKey(cell);
              const daySlots = getSelectedDaySlots(dayKey, normalizedValue);
              const busyCount = occupiedSlots.filter(
                (slot) => getBroadcastScheduleDayKey(slot) === dayKey && !selectedSet.has(slot),
              ).length;
              const isOutsideMonth = getMonthKey(cell) !== visibleMonthKey;
              const isBeforeWindow = startOfDay(cell).getTime() < windowStart.getTime();
              const isAfterWindow = startOfDay(cell).getTime() > windowEnd.getTime();
              const isDisabled = disabled || isBeforeWindow || isAfterWindow;
              const isToday = dayKey === liveTodayKey;
              const isActive = dayKey === activeDayKey;
              const isPicked = pickedDaySet.has(dayKey);
              const dayIndicatorCount =
                daySlots.length > 0
                  ? Math.min(daySlots.length, 3)
                  : isPicked || busyCount > 0
                    ? 1
                    : 0;
              const dayAriaLabelParts = [formatDayChipLabel(dayKey)];

              if (isToday) {
                dayAriaLabelParts.push('сегодня');
              }

              if (daySlots.length > 0) {
                dayAriaLabelParts.push(
                  `${formatCountLabel(daySlots.length, 'слот', 'слота', 'слотов')} настроено`,
                );
              } else if (isPicked) {
                dayAriaLabelParts.push('выбран для настройки');
              } else if (busyCount > 0) {
                dayAriaLabelParts.push('день занят');
              }

              return (
                <button
                  key={`${visibleMonthKey}-${dayKey}`}
                  type="button"
                  className={cn(
                    'broadcast-planner__day',
                    isOutsideMonth && 'is-outside',
                    daySlots.length > 0 && 'is-selected',
                    busyCount > 0 && 'is-busy',
                    isToday && 'is-today',
                    isPicked && 'is-picked',
                    isActive && isPicked && 'is-active',
                  )}
                  disabled={isDisabled}
                  aria-label={dayAriaLabelParts.join(', ')}
                  onClick={() => togglePickedDay(dayKey)}
                >
                  {isPicked ? (
                    <span className="broadcast-planner__day-marker">✓</span>
                  ) : isToday ? (
                    <span className="broadcast-planner__day-today-dot" aria-hidden />
                  ) : null}
                  <div className="broadcast-planner__day-head">
                    <span className="broadcast-planner__day-number">{cell.getDate()}</span>
                  </div>
                  <div className="broadcast-planner__day-foot">
                    <span
                      className={cn(
                        'broadcast-planner__day-indicators',
                        daySlots.length > 0 && 'is-selected',
                        isPicked && daySlots.length === 0 && 'is-picked',
                        busyCount > 0 && daySlots.length === 0 && !isPicked && 'is-busy',
                        dayIndicatorCount === 0 && 'is-empty',
                      )}
                      aria-hidden
                    >
                      {Array.from({ length: Math.max(dayIndicatorCount, 1) }).map((_, index) => (
                        <span key={`${dayKey}-${index}`} className="broadcast-planner__day-dot" />
                      ))}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
          {pickedDayKeys.length > 0 ? (
            <div className="broadcast-planner__picked-strip" aria-label="Выбранные дни">
              {pickedDayKeys.map((dayKey) => {
                const slotsCount = getSelectedDaySlots(dayKey, normalizedValue).length;
                return (
                  <button
                    key={dayKey}
                    type="button"
                    className={cn(
                      'broadcast-planner__picked-chip',
                      dayKey === activeDayKey && 'is-active',
                    )}
                    onClick={() => {
                      setActiveDayKey(dayKey);
                      maxSelectionChanged();
                    }}
                    disabled={disabled}
                  >
                    <strong>{formatDayChipLabel(dayKey)}</strong>
                    <small>
                      {slotsCount > 0
                        ? formatCountLabel(slotsCount, 'слот', 'слота', 'слотов')
                        : 'без времени'}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : null}

          {!isReviewStep && pickedDayKeys.length > 0 ? (
            <div className="broadcast-planner__selection-bar">
              <div className="broadcast-planner__selection-copy">
                <strong>{pickedDaySummary}</strong>
                <small>{pickedDayLabel}</small>
              </div>

              <div className="broadcast-planner__selection-actions">
                <button
                  type="button"
                  className="broadcast-planner__selection-reset"
                  onClick={clearPickedSelection}
                  disabled={disabled}
                >
                  Сбросить
                </button>
                <button
                  type="button"
                  className="broadcast-planner__selection-open"
                  onClick={openTimeStep}
                  disabled={disabled || pickedDayKeys.length === 0}
                >
                  Выбрать время
                </button>
              </div>
            </div>
          ) : null}
        </div>

        {isReviewStep ? (
          <div className="broadcast-planner__review-card">
            <div className="broadcast-planner__review-head">
              <div>
                <strong>Проверьте расписание</strong>
                <small>
                  {futureSlotCount > 0
                    ? `${dayCountLabel} · ${slotCountLabel}`
                    : 'Добавьте хотя бы один будущий слот.'}
                </small>
              </div>
            </div>

            <div className="broadcast-planner__review-stats">
              <div className="broadcast-planner__review-stat">
                <small>Дней</small>
                <strong>{selectedDayCount}</strong>
              </div>
              <div className="broadcast-planner__review-stat">
                <small>Слотов</small>
                <strong>{normalizedValue.length}</strong>
              </div>
              <div className="broadcast-planner__review-stat">
                <small>К отправке</small>
                <strong>{futureSlotCount}</strong>
              </div>
            </div>

            <div className="broadcast-planner__review-actions">
              <button
                type="button"
                className="broadcast-planner__review-link"
                onClick={reopenDayStep}
                disabled={disabled}
              >
                Изменить дни
              </button>
              <button
                type="button"
                className="broadcast-planner__review-link"
                onClick={reopenTimeStep}
                disabled={disabled}
              >
                Изменить время
              </button>
            </div>

            <div className="broadcast-planner__agenda-list">
              {normalizedValue.map((slot) => (
                <div key={slot} className="broadcast-planner__agenda-row">
                  <div className="broadcast-planner__agenda-main">
                    <strong>{formatBroadcastScheduleSlot(slot)}</strong>
                    <span>{formatBroadcastScheduleDay(getBroadcastScheduleDayKey(slot))}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {error ? <small className="broadcast-planner__error">{error}</small> : null}
      </section>

      {typeof document !== 'undefined' && isDaySheetOpen && pickedDayKeys.length > 0
        ? createPortal(
            <div className="broadcast-planner-sheet" aria-hidden={!isDaySheetOpen}>
              <button
                type="button"
                className="broadcast-planner-sheet__backdrop"
                aria-label="Закрыть выбор времени"
                onClick={closeDaySheet}
              />

              <section
                className="broadcast-planner-sheet__panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="broadcast-planner-sheet-title"
              >
                <div className="broadcast-planner-sheet__grabber" aria-hidden />

                <div className="broadcast-planner__sheet">
                  <div className="broadcast-planner__sheet-head">
                    <div>
                      <strong id="broadcast-planner-sheet-title">Шаг 2. Выберите время</strong>
                      <small>Отмечайте слоты сразу.</small>
                    </div>

                    <div className="broadcast-planner__sheet-facts">
                      <button
                        type="button"
                        className="broadcast-planner__clear-button"
                        onClick={closeDaySheet}
                        disabled={disabled}
                      >
                        Назад
                      </button>
                    </div>
                  </div>

                  {pickedDayKeys.length > 1 ? (
                    <>
                      <div className="broadcast-planner__day-tabs">
                        {pickedDayKeys.map((dayKey) => (
                          <button
                            key={dayKey}
                            type="button"
                            className={cn(
                              'broadcast-planner__day-tab',
                              dayKey === activeDayKey && !applyToAllPickedDays && 'is-active',
                              getSelectedDaySlots(dayKey, normalizedValue).length > 0 &&
                                'has-slots',
                            )}
                            onClick={() => {
                              setActiveDayKey(dayKey);
                              setApplyToAllPickedDays(false);
                              maxSelectionChanged();
                            }}
                          >
                            <strong>{formatDayChipLabel(dayKey)}</strong>
                            <small>{`${getSelectedDaySlots(dayKey, normalizedValue).length} сл.`}</small>
                          </button>
                        ))}
                      </div>

                      <div className="broadcast-planner__mode-row">
                        <button
                          type="button"
                          className={cn(
                            'broadcast-planner__mode-chip',
                            !applyToAllPickedDays && 'is-active',
                          )}
                          onClick={() => setApplyToAllPickedDays(false)}
                        >
                          По дням
                        </button>
                        <button
                          type="button"
                          className={cn(
                            'broadcast-planner__mode-chip',
                            applyToAllPickedDays && 'is-active',
                          )}
                          onClick={() => setApplyToAllPickedDays(true)}
                        >
                          Для всех
                        </button>
                      </div>
                    </>
                  ) : null}

                  {!applyToAllPickedDays && activeDaySlots.length > 0 ? (
                    <div
                      className="broadcast-planner__selected-strip"
                      aria-label="Выбранные слоты дня"
                    >
                      {activeDaySlots.map((slot) => (
                        <span key={slot} className="broadcast-planner__selected-chip">
                          {formatBroadcastScheduleSlot(slot).split(', ').pop()}
                        </span>
                      ))}
                    </div>
                  ) : null}

                  {SLOT_GROUPS.map((group) => (
                    <div key={group.label} className="broadcast-planner__time-group">
                      <div className="broadcast-planner__time-group-head">
                        <strong>{group.label}</strong>
                      </div>
                      <div className="broadcast-planner__time-grid">
                        {getMinutesList(group).map((minutes) => {
                          const selectedCountForTargets = targetDayKeys.filter((dayKey) =>
                            isSlotSelectedForDay(dayKey, minutes),
                          ).length;
                          const conflictTargetCount = targetDayKeys.filter((dayKey) =>
                            isSlotUnavailable(dayKey, minutes),
                          ).length;
                          const isSelected = selectedCountForTargets === targetDayKeys.length;
                          const isMixed =
                            selectedCountForTargets > 0 &&
                            selectedCountForTargets < targetDayKeys.length;
                          const hasConflict = conflictTargetCount > 0 && !isSelected && !isMixed;

                          return (
                            <button
                              key={`${group.label}-${minutes}`}
                              type="button"
                              className={cn(
                                'broadcast-planner__time-chip',
                                isSelected && 'is-selected',
                                isMixed && 'is-mixed',
                                hasConflict && !isSelected && !isMixed && 'is-disabled',
                              )}
                              onClick={() => toggleSlot(minutes)}
                              disabled={disabled || (hasConflict && !isSelected && !isMixed)}
                            >
                              <strong>{formatMinuteLabel(minutes)}</strong>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}

                  <div className="broadcast-planner__sheet-footer">
                    <button
                      type="button"
                      className="broadcast-planner__review-link"
                      onClick={clearTargetDays}
                      disabled={disabled}
                    >
                      {applyToAllPickedDays && pickedDayKeys.length > 1
                        ? 'Очистить выбранные'
                        : 'Очистить день'}
                    </button>
                    <button
                      type="button"
                      className="broadcast-planner__sheet-submit"
                      onClick={() => {
                        finishPickedSelection();
                        maxImpact('soft');
                      }}
                      disabled={disabled}
                    >
                      Сохранить
                    </button>
                  </div>
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
