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
  formatBroadcastScheduleSummary,
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
  isDaySheetOpen: boolean;
  isConfirmed: boolean;
};

type BroadcastScheduleSheetStep = 'count' | 'time';

type CountChoiceId = SlotPreset['id'] | 'custom' | null;

type SlotPreset = {
  id: string;
  label: string;
  minutes: number[];
};

type SlotGroup = {
  label: string;
  start: number;
  end: number;
};

const SLOT_PRESETS: SlotPreset[] = [
  { id: 'single', label: '1 раз', minutes: [10 * 60] },
  { id: 'double', label: '2 раза', minutes: [10 * 60, 18 * 60] },
  { id: 'triple', label: '3 раза', minutes: [10 * 60, 14 * 60, 19 * 60] },
  { id: 'dayparts', label: 'Утро / день / вечер', minutes: [9 * 60, 14 * 60, 20 * 60] },
];

const SLOT_GROUPS: SlotGroup[] = [
  { label: 'Ночь', start: 0, end: 6 * 60 },
  { label: 'Утро', start: 6 * 60, end: 12 * 60 },
  { label: 'День', start: 12 * 60, end: 18 * 60 },
  { label: 'Вечер', start: 18 * 60, end: 24 * 60 },
];

const CUSTOM_COUNT_CHOICE_ID = 'custom';

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

function formatCountChoiceLabel(choice: CountChoiceId): string {
  if (choice === CUSTOM_COUNT_CHOICE_ID) {
    return 'вручную';
  }

  return SLOT_PRESETS.find((preset) => preset.id === choice)?.label.toLowerCase() ?? 'вручную';
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
  const [selectedCountChoice, setSelectedCountChoice] = useState<CountChoiceId>(null);
  const [isConfirmed, setIsConfirmed] = useState(false);

  const windowStart = startOfDay(anchorNow);
  const windowEnd = endOfMonth(addDays(anchorNow, BROADCAST_SCHEDULE_MAX_DAYS - 1));
  const monthKeys = getMonthKeys(windowStart, windowEnd);
  const visibleMonthKey = monthKeys.includes(currentMonthKey) ? currentMonthKey : monthKeys[0];
  const selectedDayCount = countBroadcastScheduleDays(normalizedValue);
  const occupiedSet = new Set(sortAndUniqueBroadcastSlots(occupiedSlots));
  const selectedSet = new Set(normalizedValue);
  const pickedDaySet = new Set(pickedDayKeys);
  const minimumTime = anchorNow.getTime() + 30_000;
  const activeDaySlots = getSelectedDaySlots(activeDayKey, normalizedValue);
  const pickedDayLabel = formatCountLabel(pickedDayKeys.length, 'день', 'дня', 'дней');
  const targetDayKeys =
    applyToAllPickedDays && pickedDayKeys.length > 1 ? pickedDayKeys : [activeDayKey];
  const isDaySheetOpen = sheetStep !== null;
  const emitSelectionStateChange = useEffectEvent(
    (nextState: BroadcastSchedulePlannerSelectionState) => {
      onSelectionStateChange?.(nextState);
    },
  );

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
      setSelectedCountChoice(null);
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
    setSelectedCountChoice(null);
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
      isDaySheetOpen,
      isConfirmed,
    });
  }, [
    emitSelectionStateChange,
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
      return false;
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
    setSelectedCountChoice(null);
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

  function openCountStep() {
    if (disabled || pickedDayKeys.length === 0) {
      return;
    }

    setIsConfirmed(false);
    if (!pickedDayKeys.includes(activeDayKey)) {
      setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
    }
    setSheetStep('count');
    maxImpact('light');
  }

  function finishPickedSelection() {
    setPickedDayKeys([]);
    setApplyToAllPickedDays(false);
    setSheetStep(null);
    setSelectedCountChoice(null);
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

  function openTimeStep(choice: CountChoiceId) {
    if (disabled || pickedDayKeys.length === 0) {
      return;
    }

    setSelectedCountChoice(choice);
    setApplyToAllPickedDays(pickedDayKeys.length > 1);
    if (!pickedDayKeys.includes(activeDayKey)) {
      setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
    }
    setSheetStep('time');
    maxImpact('medium');
  }

  function returnToCountStep() {
    setApplyToAllPickedDays(false);
    setSheetStep('count');
    setIsConfirmed(false);
    maxImpact('light');
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

  function findPresetMinute(
    dayKey: string,
    preferredMinute: number,
    usedMinutes: Set<number>,
  ): number | null {
    const maxStepOffset = Math.floor((4 * 60) / BROADCAST_SCHEDULE_STEP_MINUTES);
    for (let offset = 0; offset <= maxStepOffset; offset += 1) {
      const candidates =
        offset === 0
          ? [preferredMinute]
          : [
              preferredMinute + offset * BROADCAST_SCHEDULE_STEP_MINUTES,
              preferredMinute - offset * BROADCAST_SCHEDULE_STEP_MINUTES,
            ];

      for (const candidate of candidates) {
        if (candidate < 0 || candidate >= 24 * 60 || usedMinutes.has(candidate)) {
          continue;
        }

        if (!isSlotUnavailable(dayKey, candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  function applyPresetToDayKeys(dayKeys: string[], preset: SlotPreset) {
    if (disabled) {
      return;
    }

    replaceSlotsForDays(dayKeys, (dayKey) => {
      const nextMinutes = new Set<number>();
      for (const preferredMinute of preset.minutes) {
        const resolvedMinute = findPresetMinute(dayKey, preferredMinute, nextMinutes);
        if (resolvedMinute != null) {
          nextMinutes.add(resolvedMinute);
        }
      }

      return Array.from(nextMinutes)
        .sort((left, right) => left - right)
        .map((minute) => buildBroadcastScheduleSlotIso(dayKey, minute));
    });
    maxImpact('medium');
  }

  function applyCountChoice(choice: CountChoiceId) {
    setIsConfirmed(false);
    if (choice === CUSTOM_COUNT_CHOICE_ID) {
      openTimeStep(choice);
      return;
    }

    const preset = SLOT_PRESETS.find((item) => item.id === choice);
    if (!preset) {
      return;
    }

    applyPresetToDayKeys(pickedDayKeys, preset);
    openTimeStep(choice);
  }

  const monthCells = getMonthCells(visibleMonthKey);
  const activeDayOccupiedCount = occupiedSlots.filter(
    (slot) => getBroadcastScheduleDayKey(slot) === activeDayKey && !selectedSet.has(slot),
  ).length;

  return (
    <>
      <section className={cn('broadcast-planner', disabled && 'is-disabled')}>
        <div className="broadcast-planner__topline">
          <div className="broadcast-planner__topline-copy">
            <strong>Шаг 1. Выберите дни публикации</strong>
            <small>
              Сначала отметьте даты. Следующие шаги с количеством и временем откроются отдельно.
            </small>
          </div>
        </div>

        <div className="broadcast-planner__calendar-card">
          <div className="broadcast-planner__calendar-copy">
            <strong>Календарь публикаций</strong>
            <small>
              {pickedDayKeys.length > 0
                ? `${pickedDayLabel} готовы к настройке времени.`
                : normalizedValue.length > 0
                  ? formatBroadcastScheduleSummary(normalizedValue)
                  : 'Можно отметить несколько дней сразу, а потом одним действием задать им время.'}
            </small>
          </div>

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
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label) => (
              <span key={label}>{label}</span>
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
              const isToday = dayKey === getBroadcastScheduleDayKey(anchorNow);
              const isActive = dayKey === activeDayKey;
              const isPicked = pickedDaySet.has(dayKey);

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
                  onClick={() => togglePickedDay(dayKey)}
                >
                  {isPicked ? <span className="broadcast-planner__day-marker">✓</span> : null}
                  <span className="broadcast-planner__day-number">{cell.getDate()}</span>
                  <span className="broadcast-planner__day-meta">
                    {daySlots.length > 0
                      ? `${daySlots.length} сл.`
                      : isPicked
                        ? 'в выборе'
                        : busyCount > 0
                          ? 'занято'
                          : ' '}
                  </span>
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

          <div className="broadcast-planner__selection-bar">
            <div className="broadcast-planner__selection-copy">
              <strong>
                {pickedDayKeys.length > 0
                  ? `Выбрано: ${pickedDayLabel}`
                  : normalizedValue.length > 0
                    ? 'Расписание готово'
                    : 'Выберите хотя бы один день'}
              </strong>
              <small>
                {pickedDayKeys.length > 0
                  ? 'Когда даты выбраны, переходите к следующему шагу.'
                  : normalizedValue.length > 0
                    ? 'Чтобы изменить план или добавить ещё дни, отметьте нужные даты в календаре.'
                    : 'Повторный тап по дате снимает выбор.'}
              </small>
            </div>

            {pickedDayKeys.length > 0 ? (
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
                  onClick={openCountStep}
                  disabled={disabled || pickedDayKeys.length === 0}
                >
                  Далее
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {normalizedValue.length > 0 ? (
          <div className="broadcast-planner__agenda">
            <div className="broadcast-planner__agenda-head">
              <strong>План публикаций</strong>
              <small>{normalizedValue.length} слотов</small>
            </div>
            <div className="broadcast-planner__agenda-list">
              {normalizedValue.map((slot) => (
                <div key={slot} className="broadcast-planner__agenda-row">
                  <strong>{formatBroadcastScheduleSlot(slot)}</strong>
                  <span>{formatBroadcastScheduleDay(getBroadcastScheduleDayKey(slot))}</span>
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
                  {sheetStep === 'count' ? (
                    <>
                      <div className="broadcast-planner__sheet-head">
                        <div>
                          <strong id="broadcast-planner-sheet-title">
                            Шаг 2. Сколько раз отправлять?
                          </strong>
                          <small>
                            {pickedDayLabel} выбрано. На следующем шаге зададите точное время.
                          </small>
                        </div>

                        <div className="broadcast-planner__sheet-facts">
                          <button
                            type="button"
                            className="broadcast-planner__clear-button"
                            onClick={closeDaySheet}
                          >
                            Назад
                          </button>
                        </div>
                      </div>

                      <div className="broadcast-planner__picked-strip" aria-label="Выбранные дни">
                        {pickedDayKeys.map((dayKey) => (
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
                              {formatCountLabel(
                                getSelectedDaySlots(dayKey, normalizedValue).length,
                                'слот',
                                'слота',
                                'слотов',
                              )}
                            </small>
                          </button>
                        ))}
                      </div>

                      {pickedDayKeys.length > 1 ? (
                        <div className="broadcast-planner__sheet-note">
                          Количество отправок применится ко всем выбранным дням. Время потом можно
                          оставить одинаковым или поправить по каждому дню отдельно.
                        </div>
                      ) : null}

                      <div className="broadcast-planner__time-grid">
                        {SLOT_PRESETS.slice(0, 3).map((preset) => (
                          <button
                            key={preset.id}
                            type="button"
                            className={cn(
                              'broadcast-planner__time-chip',
                              selectedCountChoice === preset.id && 'is-selected',
                            )}
                            onClick={() => applyCountChoice(preset.id)}
                            disabled={disabled}
                          >
                            {preset.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className={cn(
                            'broadcast-planner__time-chip',
                            selectedCountChoice === CUSTOM_COUNT_CHOICE_ID && 'is-selected',
                          )}
                          onClick={() => applyCountChoice(CUSTOM_COUNT_CHOICE_ID)}
                          disabled={disabled}
                        >
                          Вручную
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="broadcast-planner__sheet-head">
                        <div>
                          <strong id="broadcast-planner-sheet-title">Шаг 3. Выберите время</strong>
                          <small>
                            {selectedCountChoice
                              ? `Основа: ${formatCountChoiceLabel(selectedCountChoice)}. Можно точно поправить часы.`
                              : 'Выберите нужные слоты вручную.'}
                          </small>
                        </div>

                        <div className="broadcast-planner__sheet-facts">
                          {activeDayOccupiedCount > 0 && !applyToAllPickedDays ? (
                            <span>{activeDayOccupiedCount} занято</span>
                          ) : null}
                          <button
                            type="button"
                            className="broadcast-planner__clear-button"
                            onClick={returnToCountStep}
                            disabled={disabled}
                          >
                            Назад
                          </button>
                          <button
                            type="button"
                            className="broadcast-planner__clear-button"
                            onClick={clearTargetDays}
                            disabled={disabled}
                          >
                            {applyToAllPickedDays && pickedDayKeys.length > 1
                              ? 'Очистить выбранные'
                              : 'Очистить день'}
                          </button>
                          <button
                            type="button"
                            className="broadcast-planner__clear-button"
                            onClick={() => {
                              finishPickedSelection();
                              maxImpact('soft');
                            }}
                          >
                            Готово
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
                              Один день
                            </button>
                            <button
                              type="button"
                              className={cn(
                                'broadcast-planner__mode-chip',
                                applyToAllPickedDays && 'is-active',
                              )}
                              onClick={() => setApplyToAllPickedDays(true)}
                            >
                              Все выбранные
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
                      ) : applyToAllPickedDays && pickedDayKeys.length > 1 ? (
                        <div className="broadcast-planner__sheet-note">
                          Одинаковые часы будут поставлены сразу на все отмеченные даты.
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
                              const isSelected = selectedCountForTargets === targetDayKeys.length;
                              const isMixed =
                                selectedCountForTargets > 0 &&
                                selectedCountForTargets < targetDayKeys.length;
                              const hasConflict = targetDayKeys.some(
                                (dayKey) =>
                                  isSlotUnavailable(dayKey, minutes) &&
                                  !isSlotSelectedForDay(dayKey, minutes),
                              );

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
                                  {formatMinuteLabel(minutes)}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
