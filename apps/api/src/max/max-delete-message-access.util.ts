import { ChatEntityType } from '../prisma/prisma-client';
import {
  normalizePermissionName,
  type MembershipAccessSnapshot,
} from './max-bot-access-policy.util';

const CHAT_DELETE_MESSAGE_PERMISSIONS = new Set(['write', 'post_edit_delete_message']);
const CHANNEL_DELETE_MESSAGE_PERMISSIONS = new Set(['delete', 'delete_message']);

export type MaxDeleteMessageAccessFailureReason =
  | 'snapshot_missing'
  | 'not_admin_or_owner'
  | 'missing_chat_delete_permission'
  | 'missing_channel_delete_permission';

export function hasConfirmedDeleteMessageAccess(
  snapshot: MembershipAccessSnapshot | null,
  entityType: ChatEntityType | null,
): boolean {
  return resolveDeleteMessageAccessFailure(snapshot, entityType) === null;
}

export function resolveDeleteMessageAccessFailure(
  snapshot: MembershipAccessSnapshot | null,
  entityType: ChatEntityType | null,
): MaxDeleteMessageAccessFailureReason | null {
  if (!snapshot) {
    return 'snapshot_missing';
  }
  if (!snapshot.isAdmin && !snapshot.isOwner) {
    return 'not_admin_or_owner';
  }

  const permissions = new Set(snapshot.permissions.map(normalizePermissionName));
  const isChannel = entityType === ChatEntityType.CHANNEL;
  const deletePermissions = isChannel
    ? CHANNEL_DELETE_MESSAGE_PERMISSIONS
    : CHAT_DELETE_MESSAGE_PERMISSIONS;
  if (![...deletePermissions].some((permission) => permissions.has(permission))) {
    return isChannel ? 'missing_channel_delete_permission' : 'missing_chat_delete_permission';
  }

  return null;
}
