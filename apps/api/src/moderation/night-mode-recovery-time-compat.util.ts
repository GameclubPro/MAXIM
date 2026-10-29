import {
  parseNightModeTransitionSessionKey,
  resolveNightModeTransitionSessionCloseAt,
  resolveNightModeTransitionSessionOpenAt,
  type NightModeTransitionKind,
} from './night-mode-transition-time.util';

/** FLAG: Historical metadata only. This converter preserves the old four-iteration
 * interpretation and must never authorize a SEND, retry or sticky route probe. */
export function resolveNightModeLegacyRecoveryTime(
  sessionKey: string,
  transition: NightModeTransitionKind,
): Date | null {
  const parsed = parseNightModeTransitionSessionKey(sessionKey);
  if (!parsed || parsed.startMinutes === parsed.endMinutes) return null;
  const day = new Date(`${parsed.sessionDateKey}T00:00:00.000Z`);
  if (transition === 'open' && parsed.startMinutes > parsed.endMinutes)
    day.setUTCDate(day.getUTCDate() + 1);
  const minutes = transition === 'close' ? parsed.startMinutes : parsed.endMinutes;
  const target = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    Math.floor(minutes / 60),
    minutes % 60,
  );
  let instant = target;
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: parsed.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    const actual = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
    );
    const delta = target - actual;
    if (delta === 0) break;
    instant += delta;
  }
  return new Date(instant);
}

/** Metadata consistency only; exact durable identity and effect evidence remain mandatory. */
export function matchesNightModeRecoveryBoundaryTime(input: {
  sessionKey: string;
  transition: NightModeTransitionKind;
  scheduledFor: string;
}): boolean {
  const current =
    input.transition === 'close'
      ? resolveNightModeTransitionSessionCloseAt(input.sessionKey)
      : resolveNightModeTransitionSessionOpenAt(input.sessionKey);
  return (
    current?.toISOString() === input.scheduledFor ||
    resolveNightModeLegacyRecoveryTime(input.sessionKey, input.transition)?.toISOString() ===
      input.scheduledFor
  );
}
