import { ChatEntityType } from '../prisma/prisma-client';
import {
  normalizePermissionName,
  type MembershipAccessSnapshot,
} from './max-bot-access-policy.util';

const CHAT_MESSAGE_MUTATION_PERMISSIONS = new Set([
  'write',
  'can_write',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);
const CHANNEL_EDIT_MESSAGE_PERMISSIONS = new Set([
  'edit',
  'edit_message',
  'edit_messages',
  'can_edit_message',
  'can_edit_messages',
]);
const CHANNEL_DELETE_MESSAGE_PERMISSIONS = new Set([
  'delete',
  'delete_message',
  'delete_messages',
  'can_delete_message',
  'can_delete_messages',
]);

export type MaxDeleteMessageAccessFailureReason =
  | 'snapshot_missing'
  | 'not_admin_or_owner'
  | 'entity_type_unknown'
  | 'missing_chat_delete_permission'
  | 'missing_channel_delete_permission';

export function hasConfirmedDeleteMessageAccess(
  snapshot: MembershipAccessSnapshot | null,
  entityType: ChatEntityType | null,
): boolean {
  return resolveDeleteMessageAccessFailure(snapshot, entityType) === null;
}

export function hasConfirmedEditMessageAccess(
  snapshot: MembershipAccessSnapshot | null,
  entityType: ChatEntityType | null,
): boolean {
  if (!snapshot || (!snapshot.isAdmin && !snapshot.isOwner)) {
    return false;
  }

  return hasEntityMessageMutationPermission(snapshot, entityType, 'edit_message');
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
  if (entityType === null) {
    return 'entity_type_unknown';
  }

  const isChannel = entityType === ChatEntityType.CHANNEL;
  if (!hasEntityMessageMutationPermission(snapshot, entityType, 'delete_message')) {
    return isChannel ? 'missing_channel_delete_permission' : 'missing_chat_delete_permission';
  }

  return null;
}

function hasEntityMessageMutationPermission(
  snapshot: MembershipAccessSnapshot,
  entityType: ChatEntityType | null,
  action: 'edit_message' | 'delete_message',
): boolean {
  if (entityType === null) {
    return false;
  }
  const permissions = new Set(snapshot.permissions.map(normalizePermissionName));
  const requiredPermissions =
    entityType === ChatEntityType.CHANNEL
      ? action === 'edit_message'
        ? CHANNEL_EDIT_MESSAGE_PERMISSIONS
        : CHANNEL_DELETE_MESSAGE_PERMISSIONS
      : CHAT_MESSAGE_MUTATION_PERMISSIONS;
  return [...requiredPermissions].some((permission) => permissions.has(permission));
}
