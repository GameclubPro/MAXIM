import { z } from 'zod';
import type { BroadcastScheduleMode, BroadcastTargetMode } from './broadcast-common.js';

const BROADCAST_CYCLE_MAX_WINDOW_HOURS = 31 * 24;

export function normalizeBroadcastScheduledSlots(values: string[]): string[] {
  const slotsByInstant = new Map<number, string>();
  const rawSlots = new Set<string>();

  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const parsed = new Date(trimmed);
    if (!Number.isFinite(parsed.getTime())) {
      rawSlots.add(trimmed);
      continue;
    }

    slotsByInstant.set(parsed.getTime(), parsed.toISOString());
  }

  return [
    ...Array.from(slotsByInstant.entries())
      .sort(([left], [right]) => left - right)
      .map(([, value]) => value),
    ...Array.from(rawSlots).sort((a, b) => a.localeCompare(b)),
  ];
}

export function normalizeBroadcastTargetChatIds(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function resolveBroadcastTargetMode(value: {
  targetMode?: BroadcastTargetMode;
  applyToAllChats?: boolean;
  targetChatIds?: string[];
}): BroadcastTargetMode {
  if (value.targetMode === 'all' || value.applyToAllChats) {
    return 'all';
  }

  if (value.targetMode === 'selected') {
    return 'selected';
  }

  if (value.targetMode === 'current') {
    return 'current';
  }

  if (normalizeBroadcastTargetChatIds(value.targetChatIds ?? []).length > 0) {
    return 'selected';
  }

  return 'current';
}

export function addBroadcastAudienceIssues(
  value: {
    targetMode?: BroadcastTargetMode;
    applyToAllChats?: boolean;
    targetChatIds?: string[];
  },
  ctx: z.RefinementCtx,
): void {
  const targetMode = resolveBroadcastTargetMode(value);
  const targetChatIds = normalizeBroadcastTargetChatIds(value.targetChatIds ?? []);
  if (targetMode !== 'selected' || targetChatIds.length > 0) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['targetChatIds'],
    message: 'Выберите хотя бы один чат.',
  });
}

export function buildBroadcastAudienceState(value: {
  targetMode?: BroadcastTargetMode;
  applyToAllChats?: boolean;
  targetChatIds?: string[];
}): {
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
} {
  const targetMode = resolveBroadcastTargetMode(value);

  return {
    targetMode,
    targetChatIds: normalizeBroadcastTargetChatIds(value.targetChatIds ?? []),
    applyToAllChats: targetMode === 'all',
  };
}

export function addBroadcastScheduleIssues(
  value: {
    scheduleMode?: BroadcastScheduleMode;
    scheduledSlots: string[];
    sendAt?: string | null;
    cycleEnabled: boolean;
    cycleEveryHours?: number;
    cycleEveryDays?: number;
    cycleCount: number;
  },
  ctx: z.RefinementCtx,
): void {
  const normalizedSlots = normalizeBroadcastScheduledSlots(value.scheduledSlots);
  const scheduleMode =
    value.scheduleMode ?? (normalizedSlots.length > 0 ? 'calendar' : 'legacy');
  if (scheduleMode === 'calendar') {
    if (normalizedSlots.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledSlots'],
        message: 'Добавьте хотя бы один слот публикации.',
      });
    }
    return;
  }

  if (value.cycleEnabled && value.cycleCount < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cycleCount'],
      message: 'Для цикла укажите минимум 2 отправки.',
    });
  }

  if (value.cycleEnabled && value.cycleEveryHours == null && value.cycleEveryDays == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['cycleEveryHours'],
      message: 'Укажите интервал циклического автопостинга.',
    });
    return;
  }

  if (value.cycleEnabled) {
    const cycleEveryHours = value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24;
    const firstSendAtMs = value.sendAt ? new Date(value.sendAt).getTime() : Date.now();
    const cycleWindowHours =
      (Number.isFinite(firstSendAtMs) ? Math.max(0, firstSendAtMs - Date.now()) / 3_600_000 : 0) +
      (value.cycleCount - 1) * cycleEveryHours;
    if (cycleWindowHours > BROADCAST_CYCLE_MAX_WINDOW_HOURS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cycleCount'],
        message: 'Цикл должен уложиться в 31 день.',
      });
    }
  }
}

export function buildBroadcastScheduleState(value: {
  scheduleMode?: BroadcastScheduleMode;
  scheduledSlots: string[];
  replaceConflictingSlots?: boolean;
  sendAt?: string | null;
  cycleEnabled: boolean;
  cycleEveryHours?: number;
  cycleEveryDays?: number;
  cycleCount: number;
}): {
  cycleEveryHours: number;
  cycleCount: number;
  sendAt: string | null;
  scheduledSlots: string[];
  cycleEnabled: boolean;
  replaceConflictingSlots: boolean;
} {
  const scheduledSlots = normalizeBroadcastScheduledSlots(value.scheduledSlots);
  const scheduleMode =
    value.scheduleMode ?? (scheduledSlots.length > 0 ? 'calendar' : 'legacy');
  if (scheduleMode === 'calendar') {
    return {
      cycleEveryHours: 1,
      cycleCount: Math.max(1, scheduledSlots.length),
      sendAt: null,
      scheduledSlots,
      cycleEnabled: false,
      replaceConflictingSlots: value.replaceConflictingSlots === true,
    };
  }

  if (!value.cycleEnabled) {
    return {
      cycleEveryHours: 1,
      cycleCount: 1,
      sendAt: value.sendAt ?? null,
      scheduledSlots: [],
      cycleEnabled: false,
      replaceConflictingSlots: false,
    };
  }

  return {
    cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
    cycleCount: value.cycleCount,
    sendAt: value.sendAt ?? null,
    scheduledSlots: [],
    cycleEnabled: true,
    replaceConflictingSlots: false,
  };
}
