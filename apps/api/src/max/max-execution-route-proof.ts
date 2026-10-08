import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import {
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from './max-bot-access-policy.util';
import {
  hasConfirmedDeleteMessageAccess,
  hasConfirmedEditMessageAccess,
} from './max-delete-message-access.util';
import {
  isManagedEntityActivationRequired,
  isMajorManagedEntityActivationRequired,
} from './managed-entity-activation.util';

export type MaxExecutionPurpose =
  | 'moderation'
  | 'delete_message'
  | 'edit_message'
  | 'moderate_member'
  | 'send_message';
export const MAX_EXECUTION_ACCESS_MAX_AGE_MS = 5 * 60_000;
export type MaxExecutionAccessEpoch = { checkedAt: Date; source: string };
export type MaxExecutionMembershipProof = {
  botId: string;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessCheckedAt: Date | null;
  botAccessExpiresAt: Date | null;
  botAccessSource: string | null;
  permissionsSnapshot: unknown;
};
export type MaxExecutionOwnerState = {
  chatId: string;
  entityType: ChatEntityType | null;
  primaryBotId: string | null;
  routingVersion: number;
  candidates: MaxExecutionMembershipProof[];
};
export type MaxExecutionRouteProof = {
  botId: string;
  routingVersion: number;
  accessEpoch: MaxExecutionAccessEpoch;
  changed: boolean;
};

const MEMBER_PERMISSIONS = new Set([
  'add_remove_members',
  'can_add_remove_members',
  'remove_members',
  'can_remove_members',
  'manage_members',
  'can_manage_members',
  'kick_members',
  'can_kick_members',
  'ban_members',
  'can_ban_members',
  'ban_users',
  'can_ban_users',
  'delete_members',
  'can_delete_members',
]);

export function hasExecutionCapability(
  membership: MaxExecutionMembershipProof,
  entityType: ChatEntityType | null,
  purpose: MaxExecutionPurpose,
): boolean {
  const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
  if (entityType === null) return false;
  if (
    snapshot?.activationCapabilityCeiling &&
    !snapshot.activationCapabilityCeiling.includes(purpose)
  )
    return false;
  if (!snapshot || (!snapshot.isAdmin && !snapshot.isOwner) || snapshot.permissionsKnown !== true)
    return false;
  if (purpose === 'delete_message') return hasConfirmedDeleteMessageAccess(snapshot, entityType);
  if (purpose === 'edit_message') return hasConfirmedEditMessageAccess(snapshot, entityType);
  const permissions = new Set(snapshot.permissions.map(normalizePermissionName));
  if (purpose === 'moderate_member')
    return [...MEMBER_PERMISSIONS].some((permission) => permissions.has(permission));
  if (purpose === 'send_message')
    return [
      'write',
      'can_write',
      'send_messages',
      'can_send_messages',
      'post_edit_delete_message',
      'post_edit_delete_messages',
    ].some((permission) => permissions.has(permission));
  if (entityType === ChatEntityType.CHANNEL) {
    const raw = membership.permissionsSnapshot as {
      channelReadProof?: { kind?: unknown; checkedAt?: unknown; source?: unknown };
    };
    const proof = raw.channelReadProof;
    // FLAG: MAX channel admin permissions do not declare read-all. An exact successful
    // channel GET recorded with this same access epoch proves reads, never mutation rights.
    return (
      proof?.kind === 'MAX_CHANNEL_GET' &&
      proof.checkedAt === membership.botAccessCheckedAt?.toISOString() &&
      proof.source === membership.botAccessSource
    );
  }
  // FLAG: An administrator role or an omitted permission list cannot prove that this bot
  // receives every user message. Shared stateful moderation needs explicit read-all access.
  return permissions.has('read_all_messages') || permissions.has('can_read_all_messages');
}

export function hasFreshExecutionAccess(
  membership: MaxExecutionMembershipProof,
  nowMs = Date.now(),
  maxAgeMs = MAX_EXECUTION_ACCESS_MAX_AGE_MS,
): boolean {
  const checkedAt = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
  const expiresAt = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
  return (
    membership.status === ChatBotMembershipStatus.ACTIVE &&
    !isManagedEntityActivationRequired(membership) &&
    Number.isFinite(checkedAt) &&
    checkedAt <= nowMs &&
    checkedAt + maxAgeMs > nowMs &&
    Number.isFinite(expiresAt) &&
    expiresAt > nowMs &&
    Boolean(membership.botAccessSource)
  );
}

export function executionRouteProof(
  state: MaxExecutionOwnerState,
  botId: string,
  purpose: MaxExecutionPurpose = 'moderation',
  maxAgeMs = MAX_EXECUTION_ACCESS_MAX_AGE_MS,
): MaxExecutionRouteProof | null {
  const membership = state.candidates.find((candidate) => candidate.botId === botId);
  if (
    !membership ||
    isMajorManagedEntityActivationRequired(membership, state.entityType) ||
    !hasFreshExecutionAccess(membership, Date.now(), maxAgeMs) ||
    (membership.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      membership.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER) ||
    !hasExecutionCapability(membership, state.entityType, purpose)
  )
    return null;
  return {
    botId,
    routingVersion: state.routingVersion,
    accessEpoch: { checkedAt: membership.botAccessCheckedAt!, source: membership.botAccessSource! },
    changed: false,
  };
}
