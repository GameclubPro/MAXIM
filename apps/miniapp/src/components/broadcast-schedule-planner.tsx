import type { ManagedBroadcastSummary } from '@maxim/contracts';
import { useEffect, useEffectEvent, useState } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { cn } from '../lib/cn';
import {
  BROADCAST_QUICK_PRESETS,
  BROADCAST_SCHEDULE_MAX_DAYS,
  BROADCAST_SCHEDULE_STEP_MINUTES,
  buildBroadcastScheduleSlotIso,
  countBroadcastScheduleDays,
  formatBroadcastScheduleDay,
  formatBroadcastScheduleSlot,
  getBroadcastScheduleDayKey,
  resolveBroadcastQuickScheduleSelection,
  sortAndUniqueBroadcastSlots,
  type BroadcastQuickPreset,
} from '../lib/broadcast-schedule';
import { formatSupportedMarkdownPreview } from '../lib/max-markdown';
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
  managedBroadcasts?: ManagedBroadcastSummary[];
  managedBroadcastsLoading?: boolean;
  currentTargetLabel?: string;
  excludeBroadcastId?: string | null;
  onEditBroadcast?: (broadcastId: string) => void;
  onDeleteBroadcast?: (broadcastId: string) => void;
  pendingEditBroadcastId?: string | null;
  pendingDeleteBroadcastId?: string | null;
  quickPreset?: BroadcastQuickPreset | null;
  onSelectQuickPreset?: (preset: BroadcastQuickPreset) => void;
  onClearQuickPreset?: () => void;
};

export type BroadcastSchedulePlannerSelectionState = {
  pickedDayCount: number;
  selectedDayCount: number;
  slotCount: number;
  futureSlotCount: number;
  isDaySheetOpen: boolean;
  isConfirmed: boolean;
};

type BroadcastScheduleSheetMode = 'time' | 'agenda';

type SlotGroup = {
  label: string;
  start: number;
  end: number;
};

type BroadcastScheduleAgendaTone = 'active' | 'warning' | 'danger' | 'muted';

type BroadcastScheduleAgendaEntry = {
  id: string;
  dayKey: string;
  title: string;
  previewSource: string;
  statusLabel: string | null;
  tone: BroadcastScheduleAgendaTone;
  timeSlots: string[];
  facts: string[];
  canEdit: boolean;
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

function formatAgendaTime(slot: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(slot));
}

function resolveAgendaTone(status: ManagedBroadcastSummary['status']): BroadcastScheduleAgendaTone {
  if (status === 'FAILED') {
    return 'danger';
  }
  if (status === 'PARTIAL') {
    return 'warning';
  }
  if (status === 'COMPLETED' || status === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function resolveAgendaStatusLabel(status: ManagedBroadcastSummary['status']): string | null {
  if (status === 'FAILED') {
    return 'Пауза';
  }
  if (status === 'PARTIAL') {
    return 'Ошибки';
  }
  return null;
}

function buildAgendaFacts(
  broadcast: ManagedBroadcastSummary,
  currentTargetLabel: string,
): string[] {
  const audienceLabel =
    broadcast.targetMode === 'all'
      ? formatCountLabel(broadcast.targetChats, 'чат', 'чата', 'чатов')
      : broadcast.targetMode === 'selected'
        ? formatCountLabel(broadcast.targetChats, 'чат', 'чата', 'чатов')
        : currentTargetLabel;
  return [
    audienceLabel,
    broadcast.hasImage ? 'Фото' : null,
    broadcast.buttonEnabled
      ? `${broadcast.buttons.length > 1 ? broadcast.buttons.length : ''} CTA`.trim()
      : null,
  ].filter((item): item is string => Boolean(item));
}

function buildAgendaEntries(
  managedBroadcasts: ManagedBroadcastSummary[],
  currentTargetLabel: string,
  excludeBroadcastId: string | null | undefined,
): BroadcastScheduleAgendaEntry[] {
  const entries: BroadcastScheduleAgendaEntry[] = [];

  for (const broadcast of managedBroadcasts) {
    if (excludeBroadcastId && broadcast.id === excludeBroadcastId) {
      continue;
    }

    const slotsByDay = new Map<string, string[]>();
    for (const slot of sortAndUniqueBroadcastSlots(broadcast.scheduledSlots)) {
      const dayKey = getBroadcastScheduleDayKey(slot);
      const current = slotsByDay.get(dayKey) ?? [];
      current.push(slot);
      slotsByDay.set(dayKey, current);
    }

    for (const [dayKey, timeSlots] of slotsByDay) {
      entries.push({
        id: broadcast.id,
        dayKey,
        title:
          formatSupportedMarkdownPreview(broadcast.textPreview, 120) ||
          (broadcast.hasImage ? 'Фото без текста' : broadcast.textPreview),
        previewSource: broadcast.textPreview,
        statusLabel: resolveAgendaStatusLabel(broadcast.status),
        tone: resolveAgendaTone(broadcast.status),
        timeSlots: sortAndUniqueBroadcastSlots(timeSlots),
        facts: buildAgendaFacts(broadcast, currentTargetLabel),
        canEdit: broadcast.scheduleMode === 'calendar',
      });
    }
  }

  return entries.sort((left, right) => {
    const dayDiff = left.dayKey.localeCompare(right.dayKey);
    if (dayDiff !== 0) {
      return dayDiff;
    }

    const leftTime = new Date(left.timeSlots[0] ?? '').getTime();
    const rightTime = new Date(right.timeSlots[0] ?? '').getTime();
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }

    return left.title.localeCompare(right.title, 'ru');
  });
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

function snapMinutesToStep(minutes: number): number {
  return Math.ceil(minutes / BROADCAST_SCHEDULE_STEP_MINUTES) * BROADCAST_SCHEDULE_STEP_MINUTES;
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

function formatDayDensityLabel(slotCount: number): string {
  if (slotCount <= 0) {
    return '';
  }

  if (slotCount >= 4) {
    return '4+';
  }

  return String(slotCount);
}

function getSuggestedMinutes(dayKey: string, minimumTimeMs: number): number[] {
  const minimumDate = new Date(minimumTimeMs);
  const minimumDayKey = getBroadcastScheduleDayKey(minimumDate);
  const baseCandidates =
    dayKey === minimumDayKey
      ? [
          snapMinutesToStep(minimumDate.getHours() * 60 + minimumDate.getMinutes()),
          snapMinutesToStep(minimumDate.getHours() * 60 + minimumDate.getMinutes()) + 60,
          18 * 60,
          21 * 60,
        ]
      : [9 * 60, 13 * 60, 18 * 60, 21 * 60];

  return Array.from(
    new Set(
      baseCandidates.filter((minutes) => {
        if (minutes < 0 || minutes >= 24 * 60) {
          return false;
        }

        return (
          buildBroadcastScheduleSlotIso(dayKey, minutes).localeCompare(minimumDate.toISOString()) >=
          0
        );
      }),
    ),
  ).slice(0, 4);
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
  managedBroadcasts = [],
  managedBroadcastsLoading = false,
  currentTargetLabel = 'Текущий чат',
  excludeBroadcastId = null,
  onEditBroadcast,
  onDeleteBroadcast,
  pendingEditBroadcastId = null,
  pendingDeleteBroadcastId = null,
  quickPreset = null,
  onSelectQuickPreset,
  onClearQuickPreset,
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
  const [sheetMode, setSheetMode] = useState<BroadcastScheduleSheetMode | null>(null);
  const [agendaDayKey, setAgendaDayKey] = useState<string | null>(null);
  const [applyToAllPickedDays, setApplyToAllPickedDays] = useState(false);
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [showFullTimeGrid, setShowFullTimeGrid] = useState(false);

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
  const quickSelection = quickPreset
    ? resolveBroadcastQuickScheduleSelection(quickPreset, liveNowMs)
    : null;
  const agendaEntries = buildAgendaEntries(
    managedBroadcasts,
    currentTargetLabel,
    excludeBroadcastId,
  );
  const agendaEntriesByDay = new Map<string, BroadcastScheduleAgendaEntry[]>();
  for (const entry of agendaEntries) {
    const current = agendaEntriesByDay.get(entry.dayKey) ?? [];
    current.push(entry);
    agendaEntriesByDay.set(entry.dayKey, current);
  }
  const agendaDayEntries = agendaDayKey ? (agendaEntriesByDay.get(agendaDayKey) ?? []) : [];
  const agendaSlotCount = agendaDayEntries.reduce(
    (count, entry) => count + entry.timeSlots.length,
    0,
  );
  const showAgendaSkeleton =
    sheetMode === 'agenda' && managedBroadcastsLoading && agendaDayEntries.length === 0;
  const isDaySheetOpen = sheetMode !== null;
  const pastSlotCount = normalizedValue.filter(
    (slot) => new Date(slot).getTime() < minimumTime,
  ).length;
  const futureSlotCount = normalizedValue.length - pastSlotCount;
  const scheduledDayCards = scheduledDayKeys.map((dayKey) => ({
    dayKey,
    slots: getSelectedDaySlots(dayKey, normalizedValue),
  }));
  const pickedSlotsCount = pickedDayKeys.reduce(
    (count, dayKey) => count + getSelectedDaySlots(dayKey, normalizedValue).length,
    0,
  );
  const suggestedMinutes =
    sheetMode === 'time' ? getSuggestedMinutes(activeDayKey, minimumTime) : [];

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
      if (sheetMode === 'time') {
        setSheetMode(null);
      }
      setApplyToAllPickedDays(false);
      return;
    }

    if (pickedDayKeys.length === 1) {
      setApplyToAllPickedDays(false);
    }
  }, [pickedDayKeys, sheetMode]);

  useEffect(() => {
    if (sheetMode !== 'agenda' || !agendaDayKey) {
      return;
    }

    if (managedBroadcastsLoading) {
      return;
    }

    if (agendaDayEntries.length === 0) {
      setSheetMode(null);
      setAgendaDayKey(null);
    }
  }, [agendaDayEntries.length, agendaDayKey, managedBroadcastsLoading, sheetMode]);

  useEffect(() => {
    setPickedDayKeys(scheduledDayKeys);
    setActiveDayKey(scheduledDayKeys[0] ?? getBroadcastScheduleDayKey(anchorNow));
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(false);
  }, [resetKey]);

  useEffect(() => {
    if (normalizedValue.length === 0) {
      setIsConfirmed(false);
    }
  }, [normalizedValue.length]);

  useEffect(() => {
    if (sheetMode !== 'time') {
      setShowFullTimeGrid(false);
      return;
    }

    setShowFullTimeGrid(suggestedMinutes.length === 0);
  }, [activeDayKey, applyToAllPickedDays, sheetMode, suggestedMinutes.length]);

  useEffect(() => {
    if (!quickPreset) {
      return;
    }

    setPickedDayKeys([]);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(false);
  }, [quickPreset]);

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

  function clearQuickPresetIfNeeded() {
    if (quickPreset) {
      onClearQuickPreset?.();
    }
  }

  function getMinuteChipState(minutes: number) {
    const selectedCountForTargets = targetDayKeys.filter((dayKey) =>
      isSlotSelectedForDay(dayKey, minutes),
    ).length;
    const busyTargetCount = targetDayKeys.filter((dayKey) => isSlotBusy(dayKey, minutes)).length;
    const pastRestrictionCount = targetDayKeys.filter(
      (dayKey) => isSlotInPast(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    ).length;
    const isSelected = selectedCountForTargets === targetDayKeys.length;
    const isMixed = selectedCountForTargets > 0 && selectedCountForTargets < targetDayKeys.length;
    const hasBusy = busyTargetCount > 0 && !isSelected && !isMixed;
    const hasPastRestriction = pastRestrictionCount > 0 && !isSelected && !isMixed;

    return {
      isSelected,
      isMixed,
      hasBusy,
      hasPastRestriction,
    };
  }

  function isSlotInPast(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    return new Date(slotIso).getTime() < minimumTime;
  }

  function isSlotBusy(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    return occupiedSet.has(slotIso) && !selectedSet.has(slotIso);
  }

  function isSlotSelectedForDay(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    return getSelectedDaySlots(dayKey, normalizedValue).includes(slotIso);
  }

  function openAgendaDay(dayKey: string) {
    clearQuickPresetIfNeeded();
    setActiveDayKey(dayKey);
    setAgendaDayKey(dayKey);
    setSheetMode('agenda');
    onOpenDay?.(dayKey);
    maxImpact('medium');
  }

  function togglePickedDay(dayKey: string) {
    if (disabled) {
      return;
    }

    clearQuickPresetIfNeeded();
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

    clearQuickPresetIfNeeded();
    setIsConfirmed(false);
    if (!pickedDayKeys.includes(activeDayKey)) {
      setActiveDayKey(pickedDayKeys[0] ?? activeDayKey);
    }
    setApplyToAllPickedDays(pickedDayKeys.length > 1);
    setAgendaDayKey(null);
    setSheetMode('time');
    maxImpact('medium');
  }

  function finishPickedSelection() {
    setPickedDayKeys([]);
    setApplyToAllPickedDays(false);
    setSheetMode(null);
    setAgendaDayKey(null);
    setIsConfirmed(normalizedValue.length > 0);
  }

  function closeDaySheet() {
    setApplyToAllPickedDays(false);
    setSheetMode(null);
    setAgendaDayKey(null);
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

  function openTimeStepForAgendaDay() {
    if (disabled || !agendaDayKey) {
      return;
    }

    clearQuickPresetIfNeeded();
    setIsConfirmed(false);
    setPickedDayKeys([agendaDayKey]);
    setActiveDayKey(agendaDayKey);
    setApplyToAllPickedDays(false);
    setSheetMode('time');
    maxImpact('medium');
  }

  function handleAgendaEdit(broadcastId: string) {
    if (disabled || !onEditBroadcast) {
      return;
    }

    setSheetMode(null);
    setAgendaDayKey(null);
    onEditBroadcast(broadcastId);
  }

  function handleAgendaDelete(broadcastId: string) {
    if (disabled || !onDeleteBroadcast) {
      return;
    }

    setSheetMode(null);
    setAgendaDayKey(null);
    onDeleteBroadcast(broadcastId);
  }

  function openScheduledDay(dayKey: string) {
    if (disabled) {
      return;
    }

    clearQuickPresetIfNeeded();
    setPickedDayKeys([dayKey]);
    setActiveDayKey(dayKey);
    setApplyToAllPickedDays(false);
    setAgendaDayKey(null);
    setSheetMode('time');
    setIsConfirmed(false);
    onOpenDay?.(dayKey);
    maxImpact('medium');
  }

  function toggleSlot(minutes: number) {
    if (disabled) {
      return;
    }

    clearQuickPresetIfNeeded();
    const hasPastRestriction = targetDayKeys.some(
      (dayKey) => isSlotInPast(dayKey, minutes) && !isSlotSelectedForDay(dayKey, minutes),
    );
    if (hasPastRestriction) {
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

  function revealFullTimeGrid() {
    setShowFullTimeGrid(true);
    maxImpact('soft');
  }

  const monthCells = getMonthCells(visibleMonthKey);

  return (
    <>
      <section className={cn('broadcast-planner', disabled && 'is-disabled')}>
        <div className="broadcast-planner__calendar-card">
          <div className="broadcast-planner__quick-row" aria-label="Быстрые действия">
            {BROADCAST_QUICK_PRESETS.map((preset) => {
              const action = resolveBroadcastQuickScheduleSelection(preset, liveNowMs);
              return (
                <button
                  key={preset}
                  type="button"
                  className={cn(
                    'broadcast-planner__quick-chip',
                    quickPreset === preset && 'is-active',
                  )}
                  onClick={() => onSelectQuickPreset?.(preset)}
                  disabled={disabled}
                >
                  {action.label}
                </button>
              );
            })}
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
            {['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map((label, index) => (
              <span key={`${label}-${index}`}>{label}</span>
            ))}
          </div>

          <div className="broadcast-planner__grid">
            {monthCells.map((cell) => {
              const dayKey = getBroadcastScheduleDayKey(cell);
              const daySlots = getSelectedDaySlots(dayKey, normalizedValue);
              const agendaCount = (agendaEntriesByDay.get(dayKey) ?? []).length;
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
              } else if (agendaCount > 0) {
                dayAriaLabelParts.push(
                  `${formatCountLabel(agendaCount, 'рассылка', 'рассылки', 'рассылок')} запланировано`,
                );
              } else if (busyCount > 0) {
                dayAriaLabelParts.push('есть занятое время');
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
                  onClick={() => {
                    const hasAgendaEntries = agendaCount > 0;
                    const hasDraftSlots = daySlots.length > 0;
                    if (
                      hasAgendaEntries &&
                      pickedDayKeys.length === 0 &&
                      !pickedDaySet.has(dayKey) &&
                      !hasDraftSlots
                    ) {
                      openAgendaDay(dayKey);
                      return;
                    }

                    if (hasDraftSlots && pickedDayKeys.length === 0 && !pickedDaySet.has(dayKey)) {
                      openScheduledDay(dayKey);
                      return;
                    }

                    togglePickedDay(dayKey);
                  }}
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
                    {daySlots.length > 0 ? (
                      <span
                        className={cn(
                          'broadcast-planner__day-density',
                          isPicked && 'is-picked',
                          isActive && isPicked && 'is-active',
                        )}
                        aria-hidden
                      >
                        {formatDayDensityLabel(daySlots.length)}
                      </span>
                    ) : !isPicked && agendaCount > 0 ? (
                      <span className="broadcast-planner__day-count" aria-hidden>
                        {agendaCount}
                      </span>
                    ) : (
                      <span
                        className={cn(
                          'broadcast-planner__day-indicators',
                          isPicked && daySlots.length === 0 && 'is-picked',
                          busyCount > 0 && daySlots.length === 0 && !isPicked && 'is-busy',
                          !isPicked && busyCount === 0 && 'is-empty',
                        )}
                        aria-hidden
                      >
                        <span className="broadcast-planner__day-dot" />
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          {pickedDayKeys.length > 0 ? (
            <div className="broadcast-planner__dock">
              <div className="broadcast-planner__dock-copy">
                <strong>{pickedDaySummary}</strong>
                <small>
                  {pickedSlotsCount > 0
                    ? `${formatCountLabel(pickedSlotsCount, 'слот', 'слота', 'слотов')} · ${pickedDayLabel}`
                    : pickedDayLabel}
                </small>
              </div>
              <div className="broadcast-planner__dock-actions">
                <button
                  type="button"
                  className="broadcast-planner__dock-clear"
                  onClick={clearPickedSelection}
                  disabled={disabled}
                  aria-label="Снять выбор дней"
                >
                  ×
                </button>
                <button
                  type="button"
                  className="broadcast-planner__dock-primary"
                  onClick={openTimeStep}
                  disabled={disabled || pickedDayKeys.length === 0}
                >
                  Время
                </button>
              </div>
            </div>
          ) : quickSelection ? (
            <div className={cn('broadcast-planner__dock', 'is-quick')}>
              <div className="broadcast-planner__dock-copy">
                <strong>{quickSelection.label}</strong>
                <small>{quickSelection.summary}</small>
              </div>
              <div className="broadcast-planner__dock-actions">
                <button
                  type="button"
                  className="broadcast-planner__dock-clear"
                  onClick={() => onClearQuickPreset?.()}
                  disabled={disabled}
                  aria-label="Отменить быстрое время"
                >
                  ×
                </button>
              </div>
            </div>
          ) : scheduledDayCards.length > 0 ? (
            <div className="broadcast-planner__schedule-list">
              {scheduledDayCards.map(({ dayKey, slots }) => (
                <button
                  key={dayKey}
                  type="button"
                  className="broadcast-planner__schedule-card"
                  onClick={() => openScheduledDay(dayKey)}
                  disabled={disabled}
                >
                  <div className="broadcast-planner__schedule-card-head">
                    <strong>{formatDayChipLabel(dayKey)}</strong>
                    <span>{formatCountLabel(slots.length, 'слот', 'слота', 'слотов')}</span>
                  </div>
                  <div className="broadcast-planner__schedule-card-times">
                    {slots.slice(0, 4).map((slot) => (
                      <span key={slot} className="broadcast-planner__schedule-time">
                        {formatAgendaTime(slot)}
                      </span>
                    ))}
                    {slots.length > 4 ? (
                      <span className="broadcast-planner__schedule-time is-more">
                        +{slots.length - 4}
                      </span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {error ? <small className="broadcast-planner__error">{error}</small> : null}
      </section>

      {typeof document !== 'undefined' &&
      isDaySheetOpen &&
      (sheetMode === 'agenda' || pickedDayKeys.length > 0)
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
                      <strong id="broadcast-planner-sheet-title">
                        {sheetMode === 'agenda'
                          ? formatBroadcastScheduleDay(agendaDayKey ?? activeDayKey)
                          : applyToAllPickedDays && pickedDayKeys.length > 1
                            ? pickedDaySummary
                            : formatBroadcastScheduleDay(activeDayKey)}
                      </strong>
                      <small>
                        {showAgendaSkeleton
                          ? 'Обновляем...'
                          : sheetMode === 'agenda'
                            ? `${formatCountLabel(
                                agendaDayEntries.length,
                                'рассылка',
                                'рассылки',
                                'рассылок',
                              )} · ${formatCountLabel(agendaSlotCount, 'слот', 'слота', 'слотов')}`
                            : applyToAllPickedDays && pickedDayKeys.length > 1
                              ? `${pickedDayLabel} · общее время`
                              : activeDaySlots.length > 0
                                ? `${formatCountLabel(
                                    activeDaySlots.length,
                                    'слот',
                                    'слота',
                                    'слотов',
                                  )} выбрано`
                                : 'Выберите время'}
                      </small>
                    </div>

                    <div className="broadcast-planner__sheet-facts">
                      <button
                        type="button"
                        className="broadcast-planner__clear-button"
                        onClick={closeDaySheet}
                        disabled={disabled}
                        aria-label={sheetMode === 'agenda' ? 'Закрыть день' : 'Назад к календарю'}
                      >
                        {sheetMode === 'agenda' ? '×' : '←'}
                      </button>
                    </div>
                  </div>

                  {sheetMode === 'agenda' ? (
                    <>
                      {showAgendaSkeleton ? (
                        <div className="broadcast-planner__day-agenda-skeleton-list" aria-hidden>
                          {Array.from({ length: 2 }).map((_, index) => (
                            <div
                              key={`agenda-skeleton-${index}`}
                              className="broadcast-planner__day-agenda-skeleton-card"
                              style={{ animationDelay: `${index * 48}ms` }}
                            >
                              <span className="broadcast-planner__day-agenda-skeleton-line is-title" />
                              <span className="broadcast-planner__day-agenda-skeleton-line is-meta" />
                              <div className="broadcast-planner__day-agenda-skeleton-chips">
                                <span />
                                <span />
                                <span />
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="broadcast-planner__day-agenda-list">
                          {agendaDayEntries.map((entry, index) => {
                            const isEditing = pendingEditBroadcastId === entry.id;
                            const isDeleting = pendingDeleteBroadcastId === entry.id;
                            const statusLabel = isEditing ? 'Открываем...' : entry.statusLabel;
                            const statusTone = isEditing ? 'active' : entry.tone;

                            const content = (
                              <>
                                <div className="broadcast-planner__day-agenda-head">
                                  <div className="broadcast-planner__day-agenda-copy">
                                    <div className="broadcast-planner__day-agenda-title-row">
                                      <MaxMarkdownPreview
                                        value={entry.previewSource}
                                        className="broadcast-planner__day-agenda-preview max-markdown-preview--clamp-2"
                                        normalizeWhitespace
                                        fallback={entry.title}
                                      />
                                      {entry.canEdit ? (
                                        <span
                                          className="broadcast-planner__day-agenda-chevron"
                                          aria-hidden
                                        >
                                          →
                                        </span>
                                      ) : null}
                                    </div>
                                    {statusLabel ? (
                                      <span
                                        className={cn(
                                          'broadcast-planner__day-agenda-status',
                                          `is-${statusTone}`,
                                        )}
                                      >
                                        {statusLabel}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="broadcast-planner__day-agenda-times">
                                  {entry.timeSlots.map((slot) => (
                                    <span
                                      key={`${entry.id}-${slot}`}
                                      className="broadcast-planner__day-agenda-time"
                                    >
                                      {formatAgendaTime(slot)}
                                    </span>
                                  ))}
                                </div>

                                {entry.facts.length > 0 ? (
                                  <div className="broadcast-planner__day-agenda-facts">
                                    {entry.facts.map((fact) => (
                                      <span key={`${entry.id}-${fact}`}>{fact}</span>
                                    ))}
                                  </div>
                                ) : null}
                              </>
                            );

                            return (
                              <article
                                key={`${entry.dayKey}-${entry.id}`}
                                className={cn(
                                  'broadcast-planner__day-agenda-card',
                                  `is-${entry.tone}`,
                                  entry.canEdit && 'is-editable',
                                )}
                                style={{ animationDelay: `${Math.min(index, 5) * 36}ms` }}
                              >
                                {entry.canEdit ? (
                                  <button
                                    type="button"
                                    className="broadcast-planner__day-agenda-surface"
                                    onClick={() => handleAgendaEdit(entry.id)}
                                    disabled={disabled || isDeleting}
                                  >
                                    {content}
                                  </button>
                                ) : (
                                  <div
                                    className={cn(
                                      'broadcast-planner__day-agenda-surface',
                                      'is-static',
                                    )}
                                  >
                                    {content}
                                  </div>
                                )}

                                <div className="broadcast-planner__day-agenda-actions">
                                  <button
                                    type="button"
                                    className="broadcast-planner__day-agenda-delete"
                                    onClick={() => handleAgendaDelete(entry.id)}
                                    disabled={disabled || isDeleting || isEditing}
                                  >
                                    {isDeleting ? 'Удаляем...' : 'Удалить'}
                                  </button>
                                </div>
                              </article>
                            );
                          })}
                        </div>
                      )}

                      <div className="broadcast-planner__sheet-footer">
                        <button
                          type="button"
                          className="broadcast-planner__sheet-submit"
                          onClick={openTimeStepForAgendaDay}
                          disabled={disabled || !agendaDayKey}
                        >
                          Добавить время
                        </button>
                      </div>
                    </>
                  ) : pickedDayKeys.length > 1 ? (
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

                  {sheetMode === 'time' && suggestedMinutes.length > 0 ? (
                    <div className="broadcast-planner__suggested-row" aria-label="Быстрые времена">
                      {suggestedMinutes.map((minutes) => {
                        const chipState = getMinuteChipState(minutes);
                        return (
                          <button
                            key={`suggested-${minutes}`}
                            type="button"
                            className={cn(
                              'broadcast-planner__suggested-chip',
                              chipState.isSelected && 'is-selected',
                              chipState.isMixed && 'is-mixed',
                              chipState.hasBusy && 'is-busy',
                              chipState.hasPastRestriction && 'is-disabled',
                            )}
                            onClick={() => toggleSlot(minutes)}
                            disabled={disabled || chipState.hasPastRestriction}
                          >
                            {formatMinuteLabel(minutes)}
                          </button>
                        );
                      })}
                    </div>
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

                  {sheetMode === 'time' && suggestedMinutes.length > 0 && !showFullTimeGrid ? (
                    <button
                      type="button"
                      className="broadcast-planner__expand-grid"
                      onClick={revealFullTimeGrid}
                      disabled={disabled}
                    >
                      Ещё время
                    </button>
                  ) : null}

                  {showFullTimeGrid || suggestedMinutes.length === 0
                    ? SLOT_GROUPS.map((group) => (
                        <div key={group.label} className="broadcast-planner__time-group">
                          <div className="broadcast-planner__time-group-head">
                            <strong>{group.label}</strong>
                          </div>
                          <div className="broadcast-planner__time-grid">
                            {getMinutesList(group).map((minutes) => {
                              const chipState = getMinuteChipState(minutes);

                              return (
                                <button
                                  key={`${group.label}-${minutes}`}
                                  type="button"
                                  className={cn(
                                    'broadcast-planner__time-chip',
                                    chipState.isSelected && 'is-selected',
                                    chipState.isMixed && 'is-mixed',
                                    chipState.hasBusy && 'is-busy',
                                    chipState.hasPastRestriction && 'is-disabled',
                                  )}
                                  onClick={() => toggleSlot(minutes)}
                                  disabled={disabled || chipState.hasPastRestriction}
                                >
                                  <strong>{formatMinuteLabel(minutes)}</strong>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))
                    : null}

                  <div className="broadcast-planner__sheet-footer">
                    <button
                      type="button"
                      className="broadcast-planner__review-link"
                      onClick={clearTargetDays}
                      disabled={disabled}
                    >
                      Очистить
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
                      Готово
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
