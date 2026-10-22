import { z } from 'zod';
import type { BroadcastScheduleMode } from './broadcast-common.js';

export function isValidIanaTimeZone(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  try {
    Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export const broadcastScheduleTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .default('Europe/Moscow')
  .refine(isValidIanaTimeZone, 'Некорректный часовой пояс.');

export const BROADCAST_ISO_DATE_TIME_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

export const broadcastDateTimeSchema = z.preprocess((value) => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!BROADCAST_ISO_DATE_TIME_WITH_OFFSET_RE.test(trimmed)) {
    return trimmed;
  }
  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : trimmed;
}, z.string().datetime());

export function inferBroadcastScheduleMode(value: {
  scheduleMode?: BroadcastScheduleMode;
  scheduledSlots?: string[];
}): BroadcastScheduleMode {
  if (value.scheduleMode) {
    return value.scheduleMode;
  }
  return (value.scheduledSlots?.length ?? 0) > 0 ? 'calendar' : 'legacy';
}
