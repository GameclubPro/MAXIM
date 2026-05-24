import { z } from 'zod';
import type { BroadcastScheduleMode, BroadcastTargetMode } from './core.js';

export function normalizeBroadcastScheduledSlots(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
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
    scheduleMode: BroadcastScheduleMode;
    scheduledSlots: string[];
    cycleEnabled: boolean;
    cycleEveryHours?: number;
    cycleEveryDays?: number;
    cycleCount: number;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.scheduleMode === 'calendar') {
    if (normalizeBroadcastScheduledSlots(value.scheduledSlots).length === 0) {
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
  }
}

export function buildBroadcastScheduleState(value: {
  scheduledSlots: string[];
  cycleEveryHours?: number;
  cycleEveryDays?: number;
}): {
  cycleEveryHours: number;
  scheduledSlots: string[];
} {
  return {
    cycleEveryHours: value.cycleEveryHours ?? (value.cycleEveryDays ?? 1) * 24,
    scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
  };
}
