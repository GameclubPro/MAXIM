import type {
  ManagedGiveawayParticipantState,
  ManagedGiveawayPublic,
  ManagedGiveawaySummary,
} from '@maxim/contracts/giveaway';

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
  return endsAtMs !== null && endsAtMs > nowMs;
}

export type GiveawayConditionState = 'unknown' | 'checking' | 'verified' | 'missing';

export function buildGiveawayConditions(
  giveaway: ManagedGiveawayPublic,
  participant: ManagedGiveawayParticipantState | null,
  checking = false,
) {
  const channels = [
    { id: giveaway.sourceChatId, title: giveaway.sourceTitle, link: giveaway.sourceLink },
    ...giveaway.requiredChannels,
  ];
  const seen = new Set<string>();
  return channels
    .filter((channel) => {
      if (seen.has(channel.id)) return false;
      seen.add(channel.id);
      return true;
    })
    .map((channel) => {
      let state: GiveawayConditionState = 'unknown';
      if (checking) state = 'checking';
      else if (participant?.eligibilityState === 'VERIFIED') state = 'verified';
      else if (participant?.eligibilityState === 'REJECTED') {
        // FLAG: Empty legacy failure details are unknown, never proof of subscription.
        state = participant.missingChannelIds.includes(channel.id)
          ? 'missing'
          : participant.missingChannelIds.length > 0
            ? 'verified'
            : 'unknown';
      }
      return { ...channel, state };
    });
}

export function canClaimGiveaway(
  participant: ManagedGiveawayParticipantState | null,
  nowMs: number,
): boolean {
  if (!participant?.canClaim || participant.winnerStatus !== 'SELECTED') return false;
  if (participant.claimDeadlineAt === null) return true;
  const deadline = parseTimestampMs(participant.claimDeadlineAt);
  return deadline !== null && deadline > nowMs;
}

export function formatGiveawayCountdown(targetMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((targetMs - nowMs) / 1_000));
  const days = Math.floor(seconds / 86_400);
  const clock = [Math.floor(seconds / 3_600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
  return days > 0 ? `${days} д ${clock}` : clock;
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
