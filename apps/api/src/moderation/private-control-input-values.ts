import { BadRequestException } from '@nestjs/common';
import type { ChannelSettings, ChatSettings } from '@maxim/contracts';
import { compactPrivateText } from './private-control-launcher-renderer';
import type { SettingFieldType } from './private-control.types';

type PrivateControlDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export function parsePrivateControlInputValue(
  type: SettingFieldType,
  min: number | undefined,
  max: number | undefined,
  rawText: string,
): ChatSettings[keyof ChatSettings] | ChannelSettings[keyof ChannelSettings] {
  if (type === 'number') {
    return parsePrivateControlIntegerInput(rawText, min ?? 0, max ?? 1_000_000);
  }

  if (type === 'time') {
    return parsePrivateControlTimeToMinutes(rawText);
  }

  if (type === 'timezone') {
    return rawText === '-' ? '' : rawText;
  }

  if (type === 'url' || type === 'text') {
    return rawText === '-' ? '' : rawText;
  }

  throw new BadRequestException('Unsupported field type for input');
}

export function parsePrivateControlRemovalDateInput(rawText: string): string | null {
  if (!rawText || rawText === '-') {
    return null;
  }

  return parsePrivateControlDateInput(rawText).toISOString();
}

export function parsePrivateControlBroadcastSendAt(
  rawText: string,
  timeZone?: string | null,
): string | null {
  if (!rawText || rawText === '-') {
    return null;
  }

  return parsePrivateControlDateInput(rawText, timeZone).toISOString();
}

export function parsePrivateControlDateInput(rawText: string, timeZone?: string | null): Date {
  const trimmed = rawText.trim();
  const dotDateMatch = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/.exec(trimmed);

  if (dotDateMatch) {
    const [, dd, mm, yyyy, hh, min] = dotDateMatch;
    const parsed = timeZone?.trim()
      ? parseDateTimeInTimeZone(
          {
            year: Number.parseInt(yyyy, 10),
            month: Number.parseInt(mm, 10),
            day: Number.parseInt(dd, 10),
            hour: Number.parseInt(hh, 10),
            minute: Number.parseInt(min, 10),
          },
          timeZone.trim(),
        )
      : new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00+03:00`);
    if (parsed && !Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }

  const iso = new Date(trimmed);
  if (Number.isNaN(iso.getTime())) {
    throw new BadRequestException('Не удалось распознать дату и время.');
  }

  return iso;
}

function parseDateTimeInTimeZone(
  value: PrivateControlDateTimeParts,
  timeZone: string,
): Date | null {
  const targetUtc = Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    0,
    0,
  );
  let candidate = new Date(targetUtc);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getDateTimePartsInTimeZone(candidate, timeZone);
    if (!parts) {
      return null;
    }

    const partsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      0,
      0,
    );
    const diffMs = targetUtc - partsUtc;
    if (diffMs === 0) {
      return candidate;
    }

    candidate = new Date(candidate.getTime() + diffMs);
  }

  const resolved = getDateTimePartsInTimeZone(candidate, timeZone);
  if (
    !resolved ||
    resolved.year !== value.year ||
    resolved.month !== value.month ||
    resolved.day !== value.day ||
    resolved.hour !== value.hour ||
    resolved.minute !== value.minute
  ) {
    return null;
  }

  return candidate;
}

function getDateTimePartsInTimeZone(
  value: Date,
  timeZone: string,
): PrivateControlDateTimeParts | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(value);
    const year = Number(parts.find((item) => item.type === 'year')?.value ?? '');
    const month = Number(parts.find((item) => item.type === 'month')?.value ?? '');
    const day = Number(parts.find((item) => item.type === 'day')?.value ?? '');
    const hour = Number(parts.find((item) => item.type === 'hour')?.value ?? '');
    const minute = Number(parts.find((item) => item.type === 'minute')?.value ?? '');

    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      !Number.isInteger(day) ||
      !Number.isInteger(hour) ||
      !Number.isInteger(minute)
    ) {
      return null;
    }

    return {
      year,
      month,
      day,
      hour,
      minute,
    };
  } catch {
    return null;
  }
}

export function parsePrivateControlIntegerInput(rawText: string, min: number, max: number): number {
  const parsed = Number.parseInt(rawText, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    throw new BadRequestException('Введите целое число.');
  }

  if (parsed < min || parsed > max) {
    throw new BadRequestException(`Число должно быть от ${min} до ${max}.`);
  }

  return parsed;
}

export function parsePrivateControlTimeToMinutes(rawText: string): number {
  const normalized = rawText.trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (!match) {
    throw new BadRequestException('Введите время в формате HH:MM.');
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    throw new BadRequestException('Время вне допустимого диапазона.');
  }

  return hours * 60 + minutes;
}

export function formatPrivateControlTime(minutes: number): string {
  const normalized = Math.max(0, Math.min(1439, Math.trunc(minutes)));
  const hours = Math.floor(normalized / 60)
    .toString()
    .padStart(2, '0');
  const mins = (normalized % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

export function formatPrivateControlSettingValue(value: unknown, type: SettingFieldType): string {
  if (type === 'boolean') {
    return value ? 'Включено' : 'Выключено';
  }

  if (type === 'time' && typeof value === 'number') {
    return formatPrivateControlTime(value);
  }

  if (type === 'enum' && typeof value === 'string') {
    return formatPrivateControlEnumValue(value);
  }

  if (value === null || value === undefined) {
    return '—';
  }

  if (typeof value === 'string') {
    return value.trim() ? compactPrivateText(value, 64) : '—';
  }

  return String(value);
}

export function formatPrivateControlEnumValue(value: string): string {
  if (value === 'ALLOWLIST_ONLY') {
    return 'Разрешать только цели из списка разрешённых';
  }
  if (value === 'BLOCKLIST_ONLY') {
    return 'Удалять все кликабельные ссылки';
  }
  if (value === 'ALERT_ONLY') {
    return 'Только предупреждать';
  }
  if (value === 'BALANCED') {
    return 'Сбалансированный';
  }
  if (value === 'STRICT') {
    return 'Строгий';
  }
  if (value === 'SAME_IMAGE') {
    return 'Та же картинка';
  }
  if (value === 'MINOR_EDITS') {
    return 'С небольшими изменениями';
  }
  if (value === 'SAME_AUTHOR') {
    return 'У одного автора';
  }
  if (value === 'CHAT') {
    return 'Во всём чате';
  }
  return value;
}
