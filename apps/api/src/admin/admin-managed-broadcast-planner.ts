import {
  normalizeBroadcastScheduledSlots,
  type BroadcastTargetMode,
  type ManagedBroadcastTargetPreview,
  type ManagedEntityType,
  type SendBroadcastRequest,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus as PrismaManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus as PrismaManagedBroadcastStatus,
  Prisma,
  type ManagedBroadcast as PersistedManagedBroadcast,
} from '../prisma/prisma-client';
import {
  BROADCAST_CALENDAR_SLOT_MINUTES,
  BROADCAST_MAX_DELAY_MS,
  BROADCAST_MIN_DELAY_MS,
  MANAGED_BROADCAST_TARGET_PREVIEW_LIMIT,
  ONE_HOUR_MS,
  normalizeBroadcastScheduleMode,
  type ManagedBroadcastSchedulePlan,
  type ManagedBroadcastTargetPreviewBundle,
  type ParsedManagedBroadcastCalendarSlots,
} from './admin.service.support';

export async function planManagedBroadcastSchedule(
  payload: SendBroadcastRequest,
  sentCount: number,
): Promise<ManagedBroadcastSchedulePlan> {
  const scheduleMode = normalizeBroadcastScheduleMode(payload.scheduleMode);
  const scheduleTimezone = payload.scheduleTimezone.trim() || 'Europe/Moscow';
  assertManagedBroadcastScheduleTimezone(scheduleTimezone);

  if (scheduleMode === 'calendar') {
    const calendarPlan = await parseManagedBroadcastCalendarSlots(
      payload.scheduledSlots,
      sentCount,
      scheduleTimezone,
    );
    const upcomingSlots = calendarPlan.upcomingSlots;

    return {
      scheduleMode,
      scheduleTimezone,
      upcomingSlots,
      nextSendAt: upcomingSlots[0] ?? null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: calendarPlan.sentCount + upcomingSlots.length,
      sendAt: upcomingSlots[0]?.toISOString() ?? null,
      sentCount: calendarPlan.sentCount,
    };
  }

  const scheduledAt = parseManagedBroadcastSendAt(payload.sendAt, {
    required: false,
    sentCount,
  });
  const cycleEveryHours = payload.cycleEnabled ? payload.cycleEveryHours : 1;
  const cycleCount = payload.cycleEnabled ? payload.cycleCount : 1;

  if (sentCount > 0 && !payload.cycleEnabled) {
    throw new BadRequestException(
      'После первого запуска цикла оставьте циклический режим включенным.',
    );
  }
  if (sentCount > 0 && cycleCount <= sentCount) {
    throw new BadRequestException('Количество отправок должно быть больше уже выполненных.');
  }

  const initialDelayMs = scheduledAt ? scheduledAt.getTime() - Date.now() : 0;
  const maxDelayWithCycles = initialDelayMs + (cycleCount - 1) * cycleEveryHours * ONE_HOUR_MS;
  if (maxDelayWithCycles > BROADCAST_MAX_DELAY_MS) {
    throw new BadRequestException('Все оставшиеся отправки должны уместиться в 31 день.');
  }

  const firstOccurrenceAt = scheduledAt ?? new Date();
  const remainingOccurrences = Math.max(1, cycleCount - sentCount);

  return {
    scheduleMode,
    scheduleTimezone,
    upcomingSlots: buildLegacyManagedBroadcastUpcomingSlots(
      firstOccurrenceAt,
      remainingOccurrences,
      cycleEveryHours,
    ),
    nextSendAt: firstOccurrenceAt,
    cycleEnabled: payload.cycleEnabled,
    cycleEveryHours,
    cycleCount,
    sendAt: scheduledAt?.toISOString() ?? null,
    sentCount,
  };
}

export async function parseManagedBroadcastCalendarSlots(
  values: string[],
  sentCount: number,
  scheduleTimezone: string,
  now = new Date(),
): Promise<ParsedManagedBroadcastCalendarSlots> {
  const normalized = normalizeBroadcastScheduledSlots(values);
  if (normalized.length === 0) {
    throw new BadRequestException('Добавьте хотя бы один слот публикации.');
  }

  const todayKey = getDateKeyInTimeZone(now, scheduleTimezone);
  const upcomingSlots: Date[] = [];
  let pastTodayCount = 0;

  for (const value of normalized) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('Некорректный слот публикации.');
    }
    if (!isManagedBroadcastCalendarSlotOnStep(parsed, scheduleTimezone)) {
      throw new BadRequestException('Слоты должны быть кратны 30 минутам.');
    }

    const delayMs = parsed.getTime() - now.getTime();
    if (delayMs < 0) {
      if (getDateKeyInTimeZone(parsed, scheduleTimezone) !== todayKey) {
        throw new BadRequestException(
          'Прошедшие слоты можно оставлять только в пределах сегодняшнего дня.',
        );
      }
      pastTodayCount += 1;
      continue;
    }
    if (delayMs < BROADCAST_MIN_DELAY_MS) {
      throw new BadRequestException('Ближайший слот должен быть минимум через 30 секунд.');
    }
    if (delayMs > BROADCAST_MAX_DELAY_MS) {
      throw new BadRequestException('Планирование календаря доступно максимум на 31 день.');
    }
    upcomingSlots.push(parsed);
  }

  return {
    upcomingSlots,
    sentCount: Math.max(sentCount, pastTodayCount),
  };
}

export function buildLegacyManagedBroadcastUpcomingSlots(
  nextSendAt: Date | null,
  remainingOccurrences: number,
  cycleEveryHours: number,
): Date[] {
  if (!nextSendAt || remainingOccurrences <= 0) {
    return [];
  }

  const slots: Date[] = [];
  for (let index = 0; index < remainingOccurrences; index += 1) {
    slots.push(new Date(nextSendAt.getTime() + index * cycleEveryHours * ONE_HOUR_MS));
  }
  return slots;
}

export function buildManagedBroadcastOccurrenceRows(
  broadcastId: string,
  sourceChatId: string,
  entityType: ChatEntityType,
  fromOccurrenceIndex: number,
  slots: Date[],
): Prisma.ManagedBroadcastOccurrenceCreateManyInput[] {
  return slots.map((scheduledAt, index) => ({
    broadcastId,
    sourceChatId,
    entityType,
    occurrenceIndex: fromOccurrenceIndex + index,
    scheduledAt,
    status: PrismaManagedBroadcastStatus.ACTIVE,
  }));
}

export function buildManagedBroadcastCalendarReservationRows(
  broadcastId: string,
  sourceChatId: string,
  entityType: ChatEntityType,
  fromOccurrenceIndex: number,
  slots: Date[],
  targetChatIds: string[],
): Prisma.ManagedBroadcastCalendarReservationCreateManyInput[] {
  const normalizedTargetChatIds = normalizeManagedBroadcastTargetChatIds(targetChatIds);
  return slots.flatMap((scheduledAt, slotIndex) =>
    normalizedTargetChatIds.map((targetChatId) => ({
      broadcastId,
      sourceChatId,
      entityType,
      occurrenceIndex: fromOccurrenceIndex + slotIndex,
      targetChatId,
      scheduledAt,
    })),
  );
}

export function parseManagedBroadcastSendAt(
  sendAt: string | null,
  options: { required: boolean; sentCount: number },
  nowMs = Date.now(),
): Date | null {
  if (!sendAt) {
    if (options.required) {
      throw new BadRequestException('Укажите следующее время отправки.');
    }
    return null;
  }

  const scheduledAt = new Date(sendAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new BadRequestException('Некорректное время автопостинга.');
  }
  const calculatedDelayMs = scheduledAt.getTime() - nowMs;
  if (calculatedDelayMs < BROADCAST_MIN_DELAY_MS) {
    throw new BadRequestException(
      options.sentCount > 0
        ? 'Следующую отправку можно поставить минимум через 30 секунд.'
        : 'Укажите время автопостинга минимум через 30 секунд.',
    );
  }
  if (calculatedDelayMs > BROADCAST_MAX_DELAY_MS) {
    throw new BadRequestException('Максимальный таймер автопостинга: 31 день.');
  }
  return scheduledAt;
}

export function getDateKeyInTimeZone(value: Date, timeZone: string): string {
  const baseOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  };
  let formatter: Intl.DateTimeFormat;

  try {
    formatter = new Intl.DateTimeFormat('en-CA', { ...baseOptions, timeZone });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', baseOptions);
  }

  const parts = formatter.formatToParts(value);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  return `${year}-${month}-${day}`;
}

export function assertManagedBroadcastScheduleTimezone(value: string): void {
  try {
    Intl.DateTimeFormat('ru-RU', { timeZone: value }).format(new Date());
  } catch {
    throw new BadRequestException('Некорректный часовой пояс.');
  }
}

export function isManagedBroadcastCalendarSlotOnStep(value: Date, timeZone: string): boolean {
  const parts = Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(value);
  const readPart = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '');
  const minute = readPart('minute');
  const second = readPart('second');

  return (
    Number.isFinite(minute) &&
    Number.isFinite(second) &&
    minute % BROADCAST_CALENDAR_SLOT_MINUTES === 0 &&
    second === 0 &&
    value.getMilliseconds() === 0
  );
}

export function normalizeManagedBroadcastTargetChatIds(
  targetChatIds: readonly string[],
  fallbackChatId?: string,
): string[] {
  const normalized = Array.from(
    new Set(targetChatIds.map((item) => item.trim()).filter((item) => item.length > 0)),
  );
  if (normalized.length > 0) {
    return normalized;
  }
  return fallbackChatId?.trim() ? [fallbackChatId.trim()] : [];
}

export function parseManagedBroadcastTargetChatIds(
  value: Prisma.JsonValue,
  fallbackChatId?: string,
): string[] {
  return normalizeManagedBroadcastTargetChatIds(
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
    fallbackChatId,
  );
}

export function resolveManagedBroadcastTargetMode(params: {
  applyToAllChats: boolean;
  sourceChatId: string;
  targetChatIds: readonly string[];
}): BroadcastTargetMode {
  if (params.applyToAllChats) return 'all';
  if (params.targetChatIds.length === 1 && params.targetChatIds[0] === params.sourceChatId) {
    return 'current';
  }
  return 'selected';
}

export function resolveManagedBroadcastTargetsFromRow(row: {
  applyToAllChats: boolean;
  sourceChatId: string;
  targetChatIds: Prisma.JsonValue;
}): { targetMode: BroadcastTargetMode; targetChatIds: string[] } {
  const targetChatIds = parseManagedBroadcastTargetChatIds(row.targetChatIds, row.sourceChatId);
  return {
    targetMode: resolveManagedBroadcastTargetMode({
      applyToAllChats: row.applyToAllChats,
      sourceChatId: row.sourceChatId,
      targetChatIds,
    }),
    targetChatIds,
  };
}

export function fallbackManagedBroadcastTargetPreview(
  chatId: string,
  entityType: ManagedEntityType = 'chat',
): ManagedBroadcastTargetPreview {
  const normalizedChatId = chatId.trim();
  return {
    id: normalizedChatId,
    title: `${entityType === 'channel' ? 'Канал' : 'Чат'} ${normalizedChatId}`,
    entityType,
    link: null,
    avatarUrl: null,
  };
}

export function buildManagedBroadcastTargetPreviewBundle(
  targetChatIds: readonly string[],
  previewMap: ReadonlyMap<string, ManagedBroadcastTargetPreview>,
  fallbackEntityType: ManagedEntityType = 'chat',
): ManagedBroadcastTargetPreviewBundle {
  const normalizedIds = normalizeManagedBroadcastTargetChatIds(targetChatIds);
  const previews = normalizedIds
    .slice(0, MANAGED_BROADCAST_TARGET_PREVIEW_LIMIT)
    .map(
      (chatId) =>
        previewMap.get(chatId) ?? fallbackManagedBroadcastTargetPreview(chatId, fallbackEntityType),
    );
  return { previews, overflowCount: Math.max(0, normalizedIds.length - previews.length) };
}

export function getCurrentManagedBroadcastOccurrence(row: PersistedManagedBroadcast): number {
  return Math.min(Math.max(1, row.sentCount + 1), Math.max(1, row.cycleCount));
}

export function normalizeManagedBroadcastCycleCount(
  row: Pick<PersistedManagedBroadcast, 'cycleCount'>,
): number {
  return Math.max(1, row.cycleCount);
}

export function toLegacyCycleEveryDays(cycleEveryHours: number): number | undefined {
  return cycleEveryHours % 24 === 0 ? cycleEveryHours / 24 : undefined;
}

export function buildManagedBroadcastDeliveryRows(
  broadcastId: string,
  targetChatIds: string[],
  fromOccurrenceIndex: number,
  cycleCount: number,
): Prisma.ManagedBroadcastDeliveryCreateManyInput[] {
  const rows: Prisma.ManagedBroadcastDeliveryCreateManyInput[] = [];
  for (
    let occurrenceIndex = fromOccurrenceIndex;
    occurrenceIndex <= cycleCount;
    occurrenceIndex += 1
  ) {
    for (const targetChatId of targetChatIds) {
      rows.push({
        broadcastId,
        occurrenceIndex,
        targetChatId,
        status: PrismaManagedBroadcastDeliveryStatus.PENDING,
      });
    }
  }
  return rows;
}
