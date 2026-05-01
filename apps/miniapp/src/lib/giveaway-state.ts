import type { ManagedGiveawayPublic, ManagedGiveawaySummary } from '@maxim/contracts';

type GiveawayWithTiming = Pick<
  ManagedGiveawayPublic | ManagedGiveawaySummary,
  'status' | 'startsAt' | 'endsAt'
>;

export type GiveawayDisplayPhase = GiveawayWithTiming['status'];

function parseTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveGiveawayDisplayPhase(
  giveaway: GiveawayWithTiming,
  nowMs: number,
): GiveawayDisplayPhase {
  const endsAtMs = parseTimestampMs(giveaway.endsAt);

  if (
    (giveaway.status === 'ACTIVE' || giveaway.status === 'SCHEDULED') &&
    endsAtMs !== null &&
    endsAtMs <= nowMs
  ) {
    return 'DRAWING';
  }

  if (giveaway.status === 'SCHEDULED') {
    const startsAtMs = parseTimestampMs(giveaway.startsAt);
    if (startsAtMs !== null && startsAtMs <= nowMs) {
      return 'ACTIVE';
    }
  }

  return giveaway.status;
}

export function isGiveawayEntryOpen(giveaway: GiveawayWithTiming, nowMs: number): boolean {
  if (resolveGiveawayDisplayPhase(giveaway, nowMs) !== 'ACTIVE') {
    return false;
  }

  const startsAtMs = parseTimestampMs(giveaway.startsAt);
  if (startsAtMs !== null && startsAtMs > nowMs) {
    return false;
  }

  const endsAtMs = parseTimestampMs(giveaway.endsAt);
  return endsAtMs === null || endsAtMs > nowMs;
}

export function shouldPollGiveawayFinalization(
  giveaway: GiveawayWithTiming,
  nowMs: number,
): boolean {
  return resolveGiveawayDisplayPhase(giveaway, nowMs) === 'DRAWING';
}

export function resolveNextGiveawayBoundaryMs(
  giveaway: GiveawayWithTiming,
  nowMs: number,
): number | null {
  if (giveaway.status === 'SCHEDULED') {
    const startsAtMs = parseTimestampMs(giveaway.startsAt);
    if (startsAtMs !== null && startsAtMs > nowMs) {
      return startsAtMs;
    }
  }

  if (giveaway.status === 'ACTIVE') {
    const endsAtMs = parseTimestampMs(giveaway.endsAt);
    if (endsAtMs !== null) {
      return Math.max(endsAtMs, nowMs);
    }
  }

  return null;
}
