import { ChatBotMembershipRole, ChatBotMembershipStatus } from '../prisma/prisma-client';

export type MembershipAccessSnapshot = {
  checkedAt: string | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
};

export type PrimaryBotMembershipCandidate = {
  botId: string;
  role: ChatBotMembershipRole;
  status: ChatBotMembershipStatus;
  permissionsSnapshot?: unknown;
};

const PRIMARY_UNKNOWN_ACCESS_SCORE = 50_000;
const PRIMARY_ADMIN_BASE_SCORE = 100_000;
const PRIMARY_OWNER_BASE_SCORE = 1_000_000;
export const DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS = 24 * 60 * 60 * 1_000;
const PRIMARY_PERMISSION_WEIGHTS = new Map<string, number>([
  ['add_remove_members', 20_000],
  ['can_add_remove_members', 20_000],
  ['remove_members', 20_000],
  ['can_remove_members', 20_000],
  ['manage_members', 20_000],
  ['can_manage_members', 20_000],
  ['kick_members', 20_000],
  ['can_kick_members', 20_000],
  ['ban_members', 20_000],
  ['can_ban_members', 20_000],
  ['ban_users', 20_000],
  ['can_ban_users', 20_000],
  ['delete_members', 20_000],
  ['can_delete_members', 20_000],
  ['delete_message', 18_000],
  ['delete_messages', 18_000],
  ['can_delete_message', 18_000],
  ['can_delete_messages', 18_000],
  ['post_edit_delete_message', 18_000],
  ['post_edit_delete_messages', 18_000],
  ['can_post_edit_delete_message', 18_000],
  ['can_post_edit_delete_messages', 18_000],
  ['read_all_messages', 8_000],
  ['write', 5_000],
  ['edit_message', 4_000],
  ['can_edit_message', 4_000],
  ['add_admins', 3_000],
  ['can_add_admins', 3_000],
  ['change_chat_info', 2_000],
  ['can_change_chat_info', 2_000],
  ['pin_message', 1_500],
  ['can_pin_message', 1_500],
  ['edit_link', 1_000],
  ['can_edit_link', 1_000],
  ['can_call', 100],
]);

export function normalizePermissionName(permission: unknown): string {
  if (typeof permission !== 'string') {
    return '';
  }

  return permission
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, '_');
}

export function normalizeMembershipAccessSnapshot(value: unknown): MembershipAccessSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const row = value as Record<string, unknown>;
  const checkedAt =
    typeof row.checkedAt === 'string' && row.checkedAt.trim().length > 0
      ? row.checkedAt.trim()
      : null;
  const permissions = Array.isArray(row.permissions)
    ? Array.from(
        new Set(
          row.permissions
            .map((permission) => normalizePermissionName(permission))
            .filter((permission): permission is string => permission.length > 0),
        ),
      )
    : [];
  return {
    checkedAt,
    isAdmin: row.isAdmin === true,
    isOwner: row.isOwner === true,
    permissions,
  };
}

export function membershipExplicitlyLacksAccess(value: unknown): boolean {
  const snapshot = normalizeMembershipAccessSnapshot(value);
  return Boolean(snapshot && !snapshot.isAdmin && !snapshot.isOwner);
}

export function isFreshMembershipAccessSnapshot(
  snapshot: MembershipAccessSnapshot | null,
  options: { nowMs?: number; freshMs?: number } = {},
): boolean {
  if (!snapshot?.checkedAt) {
    return false;
  }

  const checkedAtMs = Date.parse(snapshot.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return false;
  }

  const nowMs =
    typeof options.nowMs === 'number' && Number.isFinite(options.nowMs)
      ? options.nowMs
      : Date.now();
  const freshMs =
    typeof options.freshMs === 'number' && Number.isFinite(options.freshMs)
      ? Math.max(0, Math.trunc(options.freshMs))
      : DEFAULT_PRIMARY_ACCESS_SNAPSHOT_FRESH_MS;
  return checkedAtMs <= nowMs && checkedAtMs + freshMs > nowMs;
}

export function calculatePrimaryAccessScore(snapshot: MembershipAccessSnapshot | null): number {
  if (!snapshot) {
    return PRIMARY_UNKNOWN_ACCESS_SCORE;
  }

  const baseScore = snapshot.isOwner
    ? PRIMARY_OWNER_BASE_SCORE
    : snapshot.isAdmin
      ? PRIMARY_ADMIN_BASE_SCORE
      : 0;
  const permissionScore =
    snapshot.isOwner || snapshot.isAdmin
      ? calculatePrimaryPermissionScore(snapshot.permissions)
      : 0;
  return baseScore + permissionScore;
}

export function calculatePrimaryPermissionScore(permissions: readonly string[]): number {
  let score = 0;
  for (const permission of new Set(
    permissions.map((item) => normalizePermissionName(item)).filter(Boolean),
  )) {
    score += PRIMARY_PERMISSION_WEIGHTS.get(permission) ?? 0;
  }
  return score;
}

export function resolvePreferredPrimaryBotId(
  currentPrimaryBotId: string | null,
  memberships: readonly PrimaryBotMembershipCandidate[],
  options: {
    requireFreshSnapshotForPromotion?: boolean;
    nowMs?: number;
    freshMs?: number;
  } = {},
): string | null {
  const activeMemberships = memberships.filter(
    (membership) => membership.status === ChatBotMembershipStatus.ACTIVE,
  );
  if (activeMemberships.length === 0) {
    return currentPrimaryBotId;
  }

  const accessEligibleMemberships = activeMemberships.filter(
    (membership) => !membershipExplicitlyLacksAccess(membership.permissionsSnapshot),
  );
  if (accessEligibleMemberships.length === 0) {
    return null;
  }

  const fallback =
    (currentPrimaryBotId &&
    accessEligibleMemberships.some((membership) => membership.botId === currentPrimaryBotId)
      ? currentPrimaryBotId
      : null) ??
    accessEligibleMemberships.find(
      (membership) => membership.role === ChatBotMembershipRole.PRIMARY,
    )?.botId ??
    accessEligibleMemberships[0]?.botId ??
    null;
  const scored = accessEligibleMemberships.map((membership, index) => {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    return {
      membership,
      index,
      hasSnapshot: snapshot !== null,
      hasFreshSnapshot: isFreshMembershipAccessSnapshot(snapshot, options),
      score: calculatePrimaryAccessScore(snapshot),
    };
  });

  if (!scored.some((candidate) => candidate.hasSnapshot)) {
    return fallback;
  }

  const selectable =
    options.requireFreshSnapshotForPromotion === true
      ? scored.filter(
          (candidate) =>
            (currentPrimaryBotId !== null &&
              currentPrimaryBotId !== undefined &&
              candidate.membership.botId === fallback) ||
            candidate.hasFreshSnapshot === true,
        )
      : scored;

  if (selectable.length === 0 || !selectable.some((candidate) => candidate.hasSnapshot)) {
    return fallback;
  }

  selectable.sort((left, right) => {
    const scoreDiff = right.score - left.score;
    if (scoreDiff !== 0) {
      return scoreDiff;
    }

    if (currentPrimaryBotId) {
      const leftIsCurrent = left.membership.botId === currentPrimaryBotId;
      const rightIsCurrent = right.membership.botId === currentPrimaryBotId;
      if (leftIsCurrent !== rightIsCurrent) {
        return leftIsCurrent ? -1 : 1;
      }
    }

    const leftIsPrimary = left.membership.role === ChatBotMembershipRole.PRIMARY;
    const rightIsPrimary = right.membership.role === ChatBotMembershipRole.PRIMARY;
    if (leftIsPrimary !== rightIsPrimary) {
      return leftIsPrimary ? -1 : 1;
    }

    return left.index - right.index;
  });

  return selectable[0]?.membership.botId ?? fallback;
}
