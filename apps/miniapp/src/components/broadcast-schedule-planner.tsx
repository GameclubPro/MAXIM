import type { ManagedBroadcastCalendarSlot, ManagedBroadcastSummary } from '@maxim/contracts';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MaxMarkdownPreview } from './max-markdown-preview';
import { cn } from '../lib/cn';
import {
  buildAgendaEntries,
  buildAgendaEntriesFromCalendarSlots,
  type BroadcastScheduleAgendaEntry,
} from '../lib/broadcast-planner-agenda';
import {
  BROADCAST_PLANNER_NOW_REFRESH_MS,
  BROADCAST_PLANNER_SLOT_GROUPS,
  addDays,
  buildFreeWindowsForDay,
  endOfMonth,
  formatAgendaTime,
  formatCountLabel,
  formatDayChipLabel,
  formatDayDensityLabel,
  formatDaySummary,
  formatMinuteLabel,
  formatMonthKey,
  getMinutesList,
  getMonthCells,
  getMonthKey,
  getMonthKeys,
  getSelectedDaySlots,
  getSuggestedMinutes,
  snapMinutesToStep,
  sortDayKeys,
  startOfDay,
  type BroadcastFreeWindow,
} from '../lib/broadcast-planner-time';
import {
  BROADCAST_CYCLE_INTERVAL_PRESETS,
  BROADCAST_SCHEDULE_MAX_DAYS,
  buildBroadcastScheduleSlotIso,
  clampBroadcastCycleCount,
  clampBroadcastCycleEveryHours,
  countBroadcastScheduleDays,
  createDefaultBroadcastCycleDraft,
  formatBroadcastCycleIntervalLabel,
  formatBroadcastCycleLastSendLabel,
  formatBroadcastCycleSummary,
  formatBroadcastScheduleDay,
  formatBroadcastScheduleSlot,
  formatLocalDateTimeInputValue,
  getBroadcastSlotInstantKey,
  getBroadcastScheduleDayKey,
  normalizeBroadcastCycleDraft,
  parseLocalDateTimeInputValue,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import { maxImpact, maxSelectionChanged } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';

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
  calendarSlots?: ManagedBroadcastCalendarSlot[];
  targetAwareAvailability?: boolean;
  managedBroadcastsLoading?: boolean;
  sourceChatId?: string | null;
  currentTargetLabel?: string;
  targetContextLabel?: string;
  targetContextMeta?: string;
  calendarRefreshing?: boolean;
  excludeBroadcastId?: string | null;
  onEditBroadcast?: (broadcastId: string) => void;
  onDeleteBroadcast?: (broadcastId: string) => void;
  pendingEditBroadcastId?: string | null;
  pendingDeleteBroadcastId?: string | null;
  timingMode?: BroadcastTimingMode;
  cycle?: BroadcastCycleDraft;
  onTimingModeChange?: (mode: BroadcastTimingMode) => void;
  onCycleChange?: (cycle: BroadcastCycleDraft) => void;
  viewMode?: 'compose' | 'calendar';
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

function areSelectionStatesEqual(
  left: BroadcastSchedulePlannerSelectionState | null,
  right: BroadcastSchedulePlannerSelectionState,
): boolean {
  return (
    left !== null &&
    left.pickedDayCount === right.pickedDayCount &&
    left.selectedDayCount === right.selectedDayCount &&
    left.slotCount === right.slotCount &&
    left.futureSlotCount === right.futureSlotCount &&
    left.isDaySheetOpen === right.isDaySheetOpen &&
    left.isConfirmed === right.isConfirmed
  );
}

const SLOT_GROUPS = BROADCAST_PLANNER_SLOT_GROUPS;
const PLANNER_NOW_REFRESH_MS = BROADCAST_PLANNER_NOW_REFRESH_MS;

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
  calendarSlots = [],
  targetAwareAvailability = false,
  managedBroadcastsLoading = false,
  sourceChatId = null,
  currentTargetLabel = 'Текущий чат',
  targetContextLabel,
  targetContextMeta,
  calendarRefreshing = false,
  excludeBroadcastId = null,
  onEditBroadcast,
  onDeleteBroadcast,
  pendingEditBroadcastId = null,
  pendingDeleteBroadcastId = null,
  timingMode = 'scheduled',
  cycle,
  onTimingModeChange,
  onCycleChange,
  viewMode = 'compose',
}: BroadcastSchedulePlannerProps) {
  const [anchorNow] = useState(() => new Date());
  const [liveNowMs, setLiveNowMs] = useState(() => Date.now());
  const normalizedValue = useMemo(() => sortAndUniqueBroadcastSlots(value), [value]);
  const calendarOnly = viewMode === 'calendar';
  const scheduledDayKeys = useMemo(
    () => sortDayKeys(normalizedValue.map((slot) => getBroadcastScheduleDayKey(slot))),
    [normalizedValue],
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
  const [calendarExpanded, setCalendarExpanded] = useState(
    () => calendarOnly || timingMode === 'scheduled' || normalizedValue.length > 0,
  );
  const lastSelectionStateRef = useRef<BroadcastSchedulePlannerSelectionState | null>(null);

  const windowStart = startOfDay(anchorNow);
  const windowEnd = endOfMonth(addDays(anchorNow, BROADCAST_SCHEDULE_MAX_DAYS - 1));
  const monthKeys = getMonthKeys(windowStart, windowEnd);
  const visibleMonthKey = monthKeys.includes(currentMonthKey) ? currentMonthKey : monthKeys[0];
  const selectedDayCount = countBroadcastScheduleDays(normalizedValue);
  const calendarBusySlots = sortAndUniqueBroadcastSlots(
    calendarSlots
      .filter((slot) => !targetAwareAvailability || slot.hasTargetOverlap)
      .map((slot) => slot.scheduledAt),
  );
  const occupiedSlotList =
    calendarSlots.length > 0 ? calendarBusySlots : sortAndUniqueBroadcastSlots(occupiedSlots);
  const occupiedInstantSet = new Set(occupiedSlotList.map(getBroadcastSlotInstantKey));
  const occupiedSlotsByDay = new Map<string, string[]>();
  for (const slot of occupiedSlotList) {
    const dayKey = getBroadcastScheduleDayKey(slot);
    const current = occupiedSlotsByDay.get(dayKey) ?? [];
    current.push(slot);
    occupiedSlotsByDay.set(dayKey, current);
  }
  const selectedInstantSet = new Set(normalizedValue.map(getBroadcastSlotInstantKey));
  const pickedDaySet = new Set(pickedDayKeys);
  const minimumTime = liveNowMs + 30_000;
  const liveTodayKey = getBroadcastScheduleDayKey(new Date(liveNowMs));
  const activeDaySlots = getSelectedDaySlots(activeDayKey, normalizedValue);
  const pickedDayLabel = formatCountLabel(pickedDayKeys.length, 'день', 'дня', 'дней');
  const pickedDaySummary = formatDaySummary(pickedDayKeys);
  const targetDayKeys =
    applyToAllPickedDays && pickedDayKeys.length > 1 ? pickedDayKeys : [activeDayKey];
  const normalizedCycle = normalizeBroadcastCycleDraft(
    cycle ?? createDefaultBroadcastCycleDraft(liveNowMs),
    liveNowMs,
  );
  const agendaEntries =
    calendarSlots.length > 0
      ? buildAgendaEntriesFromCalendarSlots(
          calendarSlots,
          sourceChatId,
          currentTargetLabel,
          excludeBroadcastId,
        )
      : buildAgendaEntries(managedBroadcasts, currentTargetLabel, excludeBroadcastId);
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
  const agendaFreeWindowSlots =
    agendaDayKey && calendarSlots.length > 0
      ? calendarSlots
          .filter(
            (slot) =>
              getBroadcastScheduleDayKey(slot.scheduledAt) === agendaDayKey &&
              (!targetAwareAvailability || slot.hasTargetOverlap),
          )
          .map((slot) => slot.scheduledAt)
      : agendaDayEntries.flatMap((entry) => entry.timeSlots);
  const agendaFreeWindows = buildFreeWindowsForDay(agendaFreeWindowSlots);
  const showAgendaSkeleton =
    sheetMode === 'agenda' && managedBroadcastsLoading && agendaDayEntries.length === 0;
  const isDaySheetOpen = sheetMode !== null;
  useNativeBackHandler(
    () => {
      setApplyToAllPickedDays(false);
      setSheetMode(null);
      setAgendaDayKey(null);
      maxImpact('soft');
      return true;
    },
    { enabled: isDaySheetOpen, priority: 640 },
  );
  const pastSlotCount = normalizedValue.filter(
    (slot) => new Date(slot).getTime() < minimumTime,
  ).length;
  const futureSlotCount = normalizedValue.length - pastSlotCount;
  const scheduleStatusLabel =
    timingMode === 'now'
      ? 'Сейчас'
      : timingMode === 'cycle'
        ? 'Цикл'
        : futureSlotCount > 0
          ? formatCountLabel(futureSlotCount, 'слот', 'слота', 'слотов')
          : 'Не выбрано';
  const scheduleStatusSummary =
    timingMode === 'now'
      ? 'сразу'
      : timingMode === 'cycle'
        ? formatBroadcastCycleSummary(normalizedCycle, liveNowMs)
        : normalizedValue.length > 0
          ? formatCountLabel(selectedDayCount, 'день', 'дня', 'дней')
          : '';
  const scheduledDayCards = scheduledDayKeys.map((dayKey) => ({
    dayKey,
    slots: getSelectedDaySlots(dayKey, normalizedValue),
  }));
  const pickedSlotsCount = pickedDayKeys.reduce(
    (count, dayKey) => count + getSelectedDaySlots(dayKey, normalizedValue).length,
    0,
  );
  const activeDayFreeWindows = buildFreeWindowsForDay(
    (occupiedSlotsByDay.get(activeDayKey) ?? []).filter(
      (slot) => !selectedInstantSet.has(getBroadcastSlotInstantKey(slot)),
    ),
  );
  const activeDayFreeWindowStartSet = new Set(
    activeDayFreeWindows.map((window) => snapMinutesToStep(window.startMinutes)),
  );
  const suggestedMinutes =
    sheetMode === 'time'
      ? Array.from(
          new Set([
            ...activeDayFreeWindows.map((window) => snapMinutesToStep(window.startMinutes)),
            ...getSuggestedMinutes(activeDayKey, minimumTime),
          ]),
        )
          .filter((minutes) => minutes >= 0 && minutes < 24 * 60)
          .slice(0, 4)
      : [];
  const hasAnyAvailableTimeSlot =
    sheetMode === 'time' && targetDayKeys.every((dayKey) => hasAvailableTimeSlotForDay(dayKey));
  const nextAvailableDayKey =
    sheetMode === 'time' && !hasAnyAvailableTimeSlot ? findNextAvailableDayKey(activeDayKey) : null;
  const normalizedTargetContextLabel =
    targetContextLabel?.trim() || currentTargetLabel.trim() || 'Текущий чат';
  const normalizedTargetContextMeta = targetContextMeta?.trim() ?? '';
  const showCalendar = calendarOnly || (timingMode === 'scheduled' && calendarExpanded);
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
      setActiveDayKey((current) => (current === todayKey ? current : todayKey));
      const anchorMonthKey = getMonthKey(anchorNow);
      setCurrentMonthKey((current) => (current === anchorMonthKey ? current : anchorMonthKey));
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
    setCalendarExpanded(scheduledDayKeys.length > 0);
  }, [resetKey]);

  useEffect(() => {
    if (normalizedValue.length === 0) {
      setIsConfirmed(false);
      return;
    }

    setCalendarExpanded((current) => current || pickedDayKeys.length > 0);
  }, [normalizedValue.length, pickedDayKeys.length]);

  useEffect(() => {
    if (sheetMode !== 'time') {
      setShowFullTimeGrid(false);
      return;
    }

    setShowFullTimeGrid(false);
  }, [activeDayKey, applyToAllPickedDays, sheetMode, suggestedMinutes.length]);

  useEffect(() => {
    if (timingMode === 'scheduled') {
      setCalendarExpanded((current) => (normalizedValue.length > 0 ? current : true));
      return;
    }

    setPickedDayKeys([]);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);
    setIsConfirmed(timingMode === 'now' || timingMode === 'cycle');
    setCalendarExpanded(false);
  }, [normalizedValue.length, timingMode]);

  useEffect(() => {
    if (calendarOnly) {
      setCalendarExpanded(true);
    }
  }, [calendarOnly]);

  useEffect(() => {
    const nextState = {
      pickedDayCount: pickedDayKeys.length,
      selectedDayCount,
      slotCount: normalizedValue.length,
      futureSlotCount,
      isDaySheetOpen,
      isConfirmed,
    };

    if (areSelectionStatesEqual(lastSelectionStateRef.current, nextState)) {
      return;
    }

    lastSelectionStateRef.current = nextState;
    emitSelectionStateChange(nextState);
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

  function activateScheduledMode() {
    if (timingMode !== 'scheduled') {
      onTimingModeChange?.('scheduled');
    }
  }

  function selectTimingMode(nextMode: BroadcastTimingMode) {
    if (disabled || calendarOnly) {
      return;
    }

    onTimingModeChange?.(nextMode);
    setBroadcastModeSideEffects(nextMode);
    maxSelectionChanged();
  }

  function setBroadcastModeSideEffects(nextMode: BroadcastTimingMode) {
    setIsConfirmed(false);
    setPickedDayKeys([]);
    setSheetMode(null);
    setAgendaDayKey(null);
    setApplyToAllPickedDays(false);

    if (nextMode === 'scheduled') {
      setCalendarExpanded(normalizedValue.length === 0);
      return;
    }

    if (normalizedValue.length > 0) {
      onChange([]);
    }
    setCalendarExpanded(false);
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
    const slotKey = getBroadcastSlotInstantKey(slotIso);
    return occupiedInstantSet.has(slotKey) && !selectedInstantSet.has(slotKey);
  }

  function isSlotSelectedForDay(dayKey: string, minutes: number): boolean {
    const slotIso = buildBroadcastScheduleSlotIso(dayKey, minutes);
    const slotKey = getBroadcastSlotInstantKey(slotIso);
    return getSelectedDaySlots(dayKey, normalizedValue).some(
      (slot) => getBroadcastSlotInstantKey(slot) === slotKey,
    );
  }

  function hasAvailableTimeSlotForDay(dayKey: string): boolean {
    return SLOT_GROUPS.some((group) =>
      getMinutesList(group).some(
        (minutes) =>
          (!isSlotInPast(dayKey, minutes) || isSlotSelectedForDay(dayKey, minutes)) &&
          (!isSlotBusy(dayKey, minutes) || isSlotSelectedForDay(dayKey, minutes)),
      ),
    );
  }

  function findNextAvailableDayKey(dayKey: string): string | null {
    const cursor = new Date(`${dayKey}T12:00:00`);
    for (let offset = 1; offset <= BROADCAST_SCHEDULE_MAX_DAYS; offset += 1) {
      const candidateKey = getBroadcastScheduleDayKey(addDays(cursor, offset));
      if (startOfDay(new Date(`${candidateKey}T12:00:00`)).getTime() > windowEnd.getTime()) {
        return null;
      }
      if (hasAvailableTimeSlotForDay(candidateKey)) {
        return candidateKey;
      }
    }
    return null;
  }

  function openAgendaDay(dayKey: string) {
    activateScheduledMode();
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

    activateScheduledMode();
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

    activateScheduledMode();
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

    activateScheduledMode();
    setIsConfirmed(false);
    setPickedDayKeys([agendaDayKey]);
    setActiveDayKey(agendaDayKey);
    setApplyToAllPickedDays(false);
    setSheetMode('time');
    maxImpact('medium');
  }

  function pickFreeWindow(window: BroadcastFreeWindow) {
    if (disabled || !agendaDayKey) {
      return;
    }

    activateScheduledMode();
    setIsConfirmed(false);
    setPickedDayKeys([agendaDayKey]);
    setActiveDayKey(agendaDayKey);
    setApplyToAllPickedDays(false);
    setSheetMode('time');
    replaceSlotsForDays([agendaDayKey], (dayKey, currentSlots) => {
      const slotIso = buildBroadcastScheduleSlotIso(dayKey, window.startMinutes);
      return sortAndUniqueBroadcastSlots([...currentSlots, slotIso]);
    });
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

    activateScheduledMode();
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

    activateScheduledMode();
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
  const scheduleReady =
    timingMode === 'now' ||
    timingMode === 'cycle' ||
    (timingMode === 'scheduled' && futureSlotCount > 0);
  const cycleStartInputValue = formatLocalDateTimeInputValue(normalizedCycle.startAt);
  const cycleStartMinValue = formatLocalDateTimeInputValue(new Date(liveNowMs + 30_000));

  return (
    <>
      <section
        className={cn(
          'broadcast-planner',
          calendarOnly && 'is-calendar-only',
          disabled && 'is-disabled',
        )}
      >
        <div className="broadcast-planner__calendar-card">
          {!calendarOnly ? (
            <>
              <div
                className={cn(
                  'broadcast-planner__mode-card',
                  calendarRefreshing && 'is-refreshing',
                )}
              >
                <div className="broadcast-planner__intent-row" aria-label="Режим отправки">
                  <button
                    type="button"
                    className={cn(
                      'broadcast-planner__intent-chip',
                      timingMode === 'now' && 'is-active',
                    )}
                    onClick={() => selectTimingMode('now')}
                    disabled={disabled}
                    aria-pressed={timingMode === 'now'}
                  >
                    <strong>Сейчас</strong>
                    <small>сразу</small>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'broadcast-planner__intent-chip',
                      timingMode === 'scheduled' && 'is-active',
                    )}
                    onClick={() => selectTimingMode('scheduled')}
                    disabled={disabled}
                    aria-pressed={timingMode === 'scheduled'}
                  >
                    <strong>План</strong>
                    <small>{futureSlotCount > 0 ? scheduleStatusLabel : 'слоты'}</small>
                  </button>
                  <button
                    type="button"
                    className={cn(
                      'broadcast-planner__intent-chip',
                      timingMode === 'cycle' && 'is-active',
                    )}
                    onClick={() => selectTimingMode('cycle')}
                    disabled={disabled}
                    aria-pressed={timingMode === 'cycle'}
                  >
                    <strong>Цикл</strong>
                    <small>{formatBroadcastCycleIntervalLabel(normalizedCycle.everyHours)}</small>
                  </button>
                </div>

                <div className="broadcast-planner__mode-meta">
                  <span
                    className="broadcast-planner__target-chip"
                    title={normalizedTargetContextLabel}
                  >
                    {normalizedTargetContextLabel}
                  </span>
                  <span
                    className={cn('broadcast-planner__mode-state', scheduleReady && 'is-ready')}
                  >
                    {scheduleStatusSummary || scheduleStatusLabel}
                  </span>
                </div>
              </div>

              {timingMode === 'scheduled' && scheduledDayCards.length > 0 ? (
                <div className="broadcast-planner__schedule-toolbar">
                  <div className="broadcast-planner__schedule-list broadcast-planner__schedule-list--compact">
                    {scheduledDayCards.map(({ dayKey, slots }) => (
                      <button
                        key={`summary-${dayKey}`}
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

                  <button
                    type="button"
                    className="broadcast-planner__calendar-toggle"
                    onClick={() => setCalendarExpanded((current) => !current)}
                    disabled={disabled}
                    aria-expanded={calendarExpanded}
                  >
                    {calendarExpanded ? 'Свернуть' : 'Календарь'}
                  </button>
                </div>
              ) : null}
            </>
          ) : null}

          {showCalendar ? (
            <>
              {calendarOnly ? (
                <div
                  className={cn(
                    'broadcast-planner__calendar-context',
                    calendarRefreshing && 'is-refreshing',
                  )}
                >
                  <span
                    className="broadcast-planner__target-chip"
                    title={normalizedTargetContextLabel}
                  >
                    {normalizedTargetContextLabel}
                  </span>
                  {normalizedTargetContextMeta ? (
                    <small>{normalizedTargetContextMeta}</small>
                  ) : null}
                </div>
              ) : null}

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
                  const dayBusySlots = (occupiedSlotsByDay.get(dayKey) ?? []).filter(
                    (slot) => !selectedInstantSet.has(getBroadcastSlotInstantKey(slot)),
                  );
                  const busyCount = dayBusySlots.length;
                  const freeWindowCount = buildFreeWindowsForDay(dayBusySlots).length;
                  const hasFreeWindows = freeWindowCount > 0;
                  const isDenseDay = busyCount + daySlots.length >= 4 || agendaCount >= 3;
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
                      `${formatCountLabel(agendaCount, 'автопостинг', 'автопостинга', 'автопостингов')} запланировано`,
                    );
                  } else if (busyCount > 0) {
                    dayAriaLabelParts.push('есть занятое время');
                  }
                  if (hasFreeWindows) {
                    dayAriaLabelParts.push('есть свободное окно');
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
                        hasFreeWindows && 'has-free-window',
                        isDenseDay && 'is-dense',
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

                        if (
                          hasDraftSlots &&
                          pickedDayKeys.length === 0 &&
                          !pickedDaySet.has(dayKey)
                        ) {
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
                        <span className="broadcast-planner__day-foot-main">
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
                          ) : null}
                        </span>
                        <span
                          className={cn(
                            'broadcast-planner__day-signals',
                            isPicked && daySlots.length === 0 && 'is-picked',
                            !isPicked &&
                              busyCount === 0 &&
                              !hasFreeWindows &&
                              daySlots.length === 0 &&
                              'is-empty',
                          )}
                          aria-hidden
                        >
                          {busyCount > 0 ? (
                            <span
                              className={cn(
                                'broadcast-planner__day-signal',
                                isDenseDay ? 'is-dense' : 'is-busy',
                              )}
                            />
                          ) : null}
                          {hasFreeWindows ? (
                            <span className="broadcast-planner__day-signal is-free" />
                          ) : null}
                          {daySlots.length > 0 || isPicked ? (
                            <span className="broadcast-planner__day-signal is-selected" />
                          ) : null}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}

          {timingMode === 'cycle' && !calendarOnly ? (
            <div className="broadcast-planner__cycle-card">
              <div className="broadcast-planner__cycle-grid">
                <div className="broadcast-planner__cycle-field">
                  <span>Старт</span>
                  <div className="broadcast-planner__cycle-toggle">
                    <button
                      type="button"
                      className={cn(
                        'broadcast-planner__cycle-toggle-button',
                        normalizedCycle.startMode === 'now' && 'is-active',
                      )}
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            startMode: 'now',
                          }),
                        )
                      }
                      disabled={disabled}
                    >
                      Сейчас
                    </button>
                    <button
                      type="button"
                      className={cn(
                        'broadcast-planner__cycle-toggle-button',
                        normalizedCycle.startMode === 'later' && 'is-active',
                      )}
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            startMode: 'later',
                          }),
                        )
                      }
                      disabled={disabled}
                    >
                      Позже
                    </button>
                  </div>
                  {normalizedCycle.startMode === 'later' ? (
                    <input
                      type="datetime-local"
                      value={cycleStartInputValue}
                      min={cycleStartMinValue}
                      onChange={(event) => {
                        const nextStartAt = parseLocalDateTimeInputValue(event.target.value);
                        if (nextStartAt) {
                          onCycleChange?.(
                            normalizeBroadcastCycleDraft({
                              ...normalizedCycle,
                              startMode: 'later',
                              startAt: nextStartAt,
                            }),
                          );
                        }
                      }}
                      disabled={disabled}
                      aria-label="Старт цикла"
                    />
                  ) : null}
                </div>

                <div className="broadcast-planner__cycle-field">
                  <span>Интервал</span>
                  <div className="broadcast-planner__cycle-presets">
                    {BROADCAST_CYCLE_INTERVAL_PRESETS.map((hours) => (
                      <button
                        key={hours}
                        type="button"
                        className={cn(
                          'broadcast-planner__cycle-preset',
                          normalizedCycle.everyHours === hours && 'is-active',
                        )}
                        onClick={() =>
                          onCycleChange?.(
                            normalizeBroadcastCycleDraft({
                              ...normalizedCycle,
                              everyHours: hours,
                            }),
                          )
                        }
                        disabled={disabled}
                      >
                        {formatBroadcastCycleIntervalLabel(hours)}
                      </button>
                    ))}
                  </div>
                  <label className="broadcast-planner__cycle-number">
                    <input
                      type="number"
                      min={1}
                      max={14 * 24}
                      value={normalizedCycle.everyHours}
                      onChange={(event) =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            everyHours: clampBroadcastCycleEveryHours(Number(event.target.value)),
                          }),
                        )
                      }
                      disabled={disabled}
                      aria-label="Интервал в часах"
                    />
                    <small>ч</small>
                  </label>
                </div>

                <div className="broadcast-planner__cycle-field">
                  <span>Повторы</span>
                  <div className="broadcast-planner__cycle-stepper">
                    <button
                      type="button"
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            count: clampBroadcastCycleCount(normalizedCycle.count - 1),
                          }),
                        )
                      }
                      disabled={disabled || normalizedCycle.count <= 2}
                      aria-label="Меньше повторов"
                    >
                      −
                    </button>
                    <strong>{normalizedCycle.count}</strong>
                    <button
                      type="button"
                      onClick={() =>
                        onCycleChange?.(
                          normalizeBroadcastCycleDraft({
                            ...normalizedCycle,
                            count: clampBroadcastCycleCount(normalizedCycle.count + 1),
                          }),
                        )
                      }
                      disabled={disabled || normalizedCycle.count >= 100}
                      aria-label="Больше повторов"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              <div className={cn('broadcast-planner__dock', 'is-cycle')}>
                <div className="broadcast-planner__dock-copy">
                  <strong>{formatBroadcastCycleSummary(normalizedCycle, liveNowMs)}</strong>
                  <small>до {formatBroadcastCycleLastSendLabel(normalizedCycle, liveNowMs)}</small>
                </div>
              </div>
            </div>
          ) : showCalendar && pickedDayKeys.length > 0 ? (
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
                                'автопостинг',
                                'автопостинга',
                                'автопостингов',
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
                                : 'Время'}
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
                      {agendaFreeWindows.length > 0 ? (
                        <div
                          className="broadcast-planner__free-windows"
                          aria-label="Свободное время"
                        >
                          {agendaFreeWindows.map((window) => (
                            <button
                              key={`${agendaDayKey}-${window.id}`}
                              type="button"
                              className="broadcast-planner__free-window"
                              onClick={() => pickFreeWindow(window)}
                              disabled={disabled}
                            >
                              {window.label}
                            </button>
                          ))}
                        </div>
                      ) : null}

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

                                {entry.canEdit ? (
                                  <div className="broadcast-planner__day-agenda-actions">
                                    <button
                                      type="button"
                                      className="broadcast-planner__day-agenda-delete"
                                      onClick={() => handleAgendaDelete(entry.id)}
                                      disabled={disabled || isDeleting || isEditing}
                                      aria-label="Удалить автопостинг"
                                    >
                                      {isDeleting ? '...' : '×'}
                                    </button>
                                  </div>
                                ) : null}
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
                          Добавить
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

                  {sheetMode === 'time' ? (
                    <>
                      {suggestedMinutes.length > 0 ? (
                        <div
                          className="broadcast-planner__suggested-row"
                          aria-label="Быстрые времена"
                        >
                          {suggestedMinutes.map((minutes) => {
                            const chipState = getMinuteChipState(minutes);
                            return (
                              <button
                                key={`suggested-${minutes}`}
                                type="button"
                                className={cn(
                                  'broadcast-planner__suggested-chip',
                                  activeDayFreeWindowStartSet.has(minutes) && 'is-free',
                                  chipState.isSelected && 'is-selected',
                                  chipState.isMixed && 'is-mixed',
                                  chipState.hasBusy && 'is-busy',
                                  chipState.hasPastRestriction && 'is-disabled',
                                )}
                                aria-label={
                                  chipState.hasBusy
                                    ? `${formatMinuteLabel(minutes)}, занято`
                                    : formatMinuteLabel(minutes)
                                }
                                onClick={() => toggleSlot(minutes)}
                                disabled={
                                  disabled || chipState.hasPastRestriction || chipState.hasBusy
                                }
                              >
                                {formatMinuteLabel(minutes)}
                              </button>
                            );
                          })}
                        </div>
                      ) : null}

                      {suggestedMinutes.length === 0 && !hasAnyAvailableTimeSlot ? (
                        <div className="broadcast-planner__time-empty" role="status">
                          <strong>Нет слотов</strong>
                          {nextAvailableDayKey ? (
                            <button
                              type="button"
                              onClick={() => {
                                setPickedDayKeys([nextAvailableDayKey]);
                                setActiveDayKey(nextAvailableDayKey);
                                setApplyToAllPickedDays(false);
                                maxSelectionChanged();
                              }}
                              disabled={disabled}
                            >
                              {formatDayChipLabel(nextAvailableDayKey)}
                            </button>
                          ) : null}
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

                      {suggestedMinutes.length > 0 && !showFullTimeGrid ? (
                        <button
                          type="button"
                          className="broadcast-planner__expand-grid"
                          onClick={revealFullTimeGrid}
                          disabled={disabled}
                        >
                          Все время
                        </button>
                      ) : null}

                      {showFullTimeGrid
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
                                      aria-label={
                                        chipState.hasBusy
                                          ? `${formatMinuteLabel(minutes)}, занято`
                                          : formatMinuteLabel(minutes)
                                      }
                                      onClick={() => toggleSlot(minutes)}
                                      disabled={
                                        disabled ||
                                        chipState.hasPastRestriction ||
                                        chipState.hasBusy
                                      }
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
                    </>
                  ) : null}
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
