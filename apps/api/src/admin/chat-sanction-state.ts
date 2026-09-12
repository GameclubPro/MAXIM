import type { ChatSanctionItem } from '@maxim/contracts';

export type SanctionFeedRow = {
  id: string;
  userId: string;
  userDisplayName: string | null;
  action: 'MUTE' | 'BAN';
  ruleCode: string;
  operator: 'ADMIN' | 'BOT';
  metadata: unknown;
  createdAt: Date;
  nextEventAt: Date | null;
  nextRuleCode: string | null;
  sourceExists: boolean;
};

export function readSanctionMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function readSanctionString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function resolveSanctionState(
  row: SanctionFeedRow,
  nowMs: number,
): Pick<ChatSanctionItem, 'status' | 'expiresAt' | 'endedAt' | 'permanent' | 'releaseAction'> {
  const metadata = readSanctionMetadata(row.metadata);
  const permanent = row.action === 'BAN' || metadata.mutePermanent === true;
  let expiresAt: string | null = null;
  if (!permanent) {
    const explicit = readSanctionString(metadata.muteExpiresAt);
    const parsed = explicit ? Date.parse(explicit) : NaN;
    const hours = metadata.muteDurationHours;
    const at = Number.isFinite(parsed)
      ? parsed
      : typeof hours === 'number' && Number.isFinite(hours) && hours > 0 && hours <= 336
        ? row.createdAt.getTime() + hours * 3_600_000
        : NaN;
    if (Number.isFinite(at) && at > row.createdAt.getTime()) expiresAt = new Date(at).toISOString();
  }
  const expiryMs = expiresAt ? Date.parse(expiresAt) : null;
  const nextAt = row.nextEventAt?.getTime() ?? null;
  let status: ChatSanctionItem['status'];
  let endedAt: string | null = null;
  if (expiryMs !== null && expiryMs <= nowMs && (nextAt === null || expiryMs <= nextAt)) {
    status = 'expired';
    endedAt = expiresAt;
  } else if (row.nextEventAt) {
    status =
      row.nextRuleCode === 'MANUAL_UNMUTE' || row.nextRuleCode === 'MANUAL_UNBAN'
        ? 'released'
        : 'replaced';
    endedAt = row.nextEventAt.toISOString();
  } else if (
    !row.sourceExists ||
    (!permanent && expiresAt === null) ||
    metadata.sanctionApplied === false
  ) {
    status = 'review';
  } else {
    status = 'active';
  }
  return {
    status,
    expiresAt,
    endedAt,
    permanent,
    releaseAction: status === 'active' ? (row.action === 'MUTE' ? 'UNMUTE' : 'UNBAN') : null,
  };
}
