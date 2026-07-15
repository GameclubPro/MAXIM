import type { LogsDashboardRange } from '@maxim/contracts';

export type MembershipMovementSummary = {
  joined: number;
  left: number;
  total: number;
  balance: number;
};

export type MembershipMovementShares = {
  joined: number;
  left: number;
  hasMovement: boolean;
};

export function buildMembershipMovementSummary(
  joinedRaw: number | null | undefined,
  leftRaw: number | null | undefined,
): MembershipMovementSummary {
  const joined = Number.isFinite(joinedRaw) ? Math.max(0, Math.trunc(joinedRaw ?? 0)) : 0;
  const left = Number.isFinite(leftRaw) ? Math.max(0, Math.trunc(leftRaw ?? 0)) : 0;

  return {
    joined,
    left,
    total: joined + left,
    balance: joined - left,
  };
}

export function resolveMembershipMovementShares(
  joinedRaw: number | null | undefined,
  leftRaw: number | null | undefined,
): MembershipMovementShares {
  const { joined, total } = buildMembershipMovementSummary(joinedRaw, leftRaw);
  if (total === 0) {
    return { joined: 0, left: 0, hasMovement: false };
  }

  const joinedShare = Math.round((joined / total) * 100);
  return {
    joined: joinedShare,
    left: 100 - joinedShare,
    hasMovement: true,
  };
}

export function formatStatisticsRangeLabel(range: LogsDashboardRange): string {
  if (range === '24h') {
    return 'за 24 часа';
  }

  if (range === '30d') {
    return 'за 30 дней';
  }

  return 'за 7 дней';
}
