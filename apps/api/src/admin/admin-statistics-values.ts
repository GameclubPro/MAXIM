import type { LogsDashboardRange } from '@maxim/contracts';

export function toSafeInteger(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  if (typeof value === 'bigint') {
    return value > 0n ? Number(value) : 0;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? 0 : Math.max(0, parsed);
  }

  if (value && typeof value === 'object') {
    const numericObject = value as {
      toNumber?: () => number;
      toString?: () => string;
    };
    if (typeof numericObject.toNumber === 'function') {
      const parsed = numericObject.toNumber();
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    }

    if (typeof numericObject.toString === 'function') {
      const stringValue = numericObject.toString();
      if (stringValue && stringValue !== '[object Object]') {
        const parsed = Number(stringValue);
        return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
      }
    }
  }

  return 0;
}

export function toIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }

    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function resolveLogsDashboardFrom(range: LogsDashboardRange, to: Date): Date {
  const toTimestamp = to.getTime();

  if (range === '24h') {
    return new Date(toTimestamp - 24 * 60 * 60 * 1000);
  }

  if (range === '30d') {
    return new Date(toTimestamp - 30 * 24 * 60 * 60 * 1000);
  }

  return new Date(toTimestamp - 7 * 24 * 60 * 60 * 1000);
}
