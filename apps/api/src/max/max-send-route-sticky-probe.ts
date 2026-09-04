import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  parseNightModeTransitionSessionKey,
  resolveNightModeTransitionSessionCloseAt,
} from '../moderation/night-mode-transition-time.util';
import { buildNightModeNoticeIdempotencyKey } from './max-action-idempotency.util';

export const MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND = 'future_night_close_v1' as const;

export type MaxFutureNightStickyRouteProbe = {
  kind: typeof MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND;
  authorizedAt: string;
  failureBefore: string;
  sessionKey: string;
  scheduleFingerprint: string;
};

type FutureNightStickyRouteProbeContext = {
  chatId: string;
  idempotencyKey: string;
  sourceTag: string | null | undefined;
  occurredAt: Date | string;
};

export function parseMaxFutureNightStickyRouteProbe(
  value: unknown,
  context: FutureNightStickyRouteProbeContext,
): MaxFutureNightStickyRouteProbe | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\u0000') !==
    ['authorizedAt', 'failureBefore', 'kind', 'scheduleFingerprint', 'sessionKey'].join('\u0000')
  ) {
    return null;
  }
  const chatId = context.chatId.trim();
  const sessionKey = readCanonicalString(record.sessionKey, 512);
  const authorizedAt = readCanonicalIso(record.authorizedAt);
  const failureBefore = readCanonicalIso(record.failureBefore);
  const scheduleFingerprint = readCanonicalString(record.scheduleFingerprint, 80);
  const occurredAt = readOccurredAt(context.occurredAt);
  const session = sessionKey ? parseNightModeTransitionSessionKey(sessionKey) : null;
  if (
    record.kind !== MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND ||
    context.sourceTag !== 'night_mode_transition' ||
    !chatId ||
    !sessionKey ||
    !authorizedAt ||
    !failureBefore ||
    !scheduleFingerprint ||
    !/^sha256:[a-f0-9]{64}$/u.test(scheduleFingerprint) ||
    !session ||
    session.startMinutes === session.endMinutes ||
    scheduleFingerprint !==
      buildNightModeTransitionScheduleFingerprint({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: session.startMinutes,
        nightModeEndTimeMinutes: session.endMinutes,
        nightModeTimezone: session.timezone,
      }) ||
    !occurredAt ||
    Date.parse(authorizedAt) >= Date.parse(failureBefore) ||
    Date.parse(failureBefore) > occurredAt.getTime() ||
    context.idempotencyKey !== buildNightModeNoticeIdempotencyKey('close', chatId, sessionKey) ||
    resolveNightModeTransitionSessionCloseAt(sessionKey)?.toISOString() !== failureBefore
  ) {
    return null;
  }
  return {
    kind: MAX_FUTURE_NIGHT_STICKY_ROUTE_PROBE_KIND,
    authorizedAt,
    failureBefore,
    sessionKey,
    scheduleFingerprint,
  };
}

function readCanonicalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' || !value || value.length > maxLength || value.trim() !== value) {
    return null;
  }
  return value;
}

function readCanonicalIso(value: unknown): string | null {
  const normalized = readCanonicalString(value, 64);
  if (!normalized) {
    return null;
  }
  const parsedMs = Date.parse(normalized);
  return Number.isFinite(parsedMs) && new Date(parsedMs).toISOString() === normalized
    ? normalized
    : null;
}

function readOccurredAt(value: Date | string): Date | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  const parsed = readCanonicalIso(value);
  return parsed ? new Date(parsed) : null;
}
