import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import type { BotAccessSnapshotInput } from './bot-access-snapshot.util';
import {
  MANAGED_ENTITY_EXECUTION_PURPOSES,
  normalizeMembershipAccessSnapshot,
} from './max-bot-access-policy.util';
import { hasExecutionCapability, type MaxExecutionPurpose } from './max-execution-route-proof';

export function restrictPassiveManagedEntityAccess<T extends NonNullable<BotAccessSnapshotInput>>(
  access: T,
  previousSnapshot: unknown,
  entityType: ChatEntityType | null | undefined,
): T {
  if (!entityType) return access;
  const previous = normalizeMembershipAccessSnapshot(previousSnapshot);
  if (!previous || (!previous.activationCapabilityCeiling && previous.permissionsKnown !== true))
    return access;
  const permits = (snapshot: unknown, purpose: MaxExecutionPurpose) =>
    hasExecutionCapability(
      {
        botId: '',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: null,
        botAccessExpiresAt: null,
        botAccessSource: null,
        permissionsSnapshot: snapshot,
      },
      entityType,
      purpose,
    );
  const previousCeiling = MANAGED_ENTITY_EXECUTION_PURPOSES.filter(
    (purpose) =>
      (purpose === 'moderation' && entityType === ChatEntityType.CHANNEL) ||
      ((!previous.activationCapabilityCeiling ||
        previous.activationCapabilityCeiling.includes(purpose)) &&
        (previous.permissionsKnown !== true || permits(previous, purpose))),
  );
  const ceiling = previousCeiling.filter(
    (purpose) =>
      access.permissionsKnown !== true ||
      (purpose === 'moderation' && entityType === ChatEntityType.CHANNEL) ||
      permits(access, purpose),
  );
  // FLAG: Keep known absence across unknown replies and role/permission aliases. A
  // fresh positive response can renew retained rights, but only explicit activation adds rights.
  if (access.permissionsKnown !== true) return { ...access, activationCapabilityCeiling: ceiling };
  const effective = MANAGED_ENTITY_EXECUTION_PURPOSES.filter(
    (purpose) => ceiling.includes(purpose) && permits(access, purpose),
  );
  const gained = MANAGED_ENTITY_EXECUTION_PURPOSES.some(
    (purpose) => !previousCeiling.includes(purpose) && permits(access, purpose),
  );
  if (!gained) return { ...access, activationCapabilityCeiling: ceiling };
  const permissions = (access.permissions ?? []).filter(
    (permission) =>
      !MANAGED_ENTITY_EXECUTION_PURPOSES.some((purpose) =>
        permits({ ...access, permissions: [permission] }, purpose),
      ),
  );
  if (effective.includes('moderation') && entityType === ChatEntityType.CHAT)
    permissions.push('read_all_messages');
  if (effective.includes('send_message')) permissions.push('write');
  if (effective.includes('delete_message'))
    permissions.push(entityType === ChatEntityType.CHANNEL ? 'delete_message' : 'write');
  if (effective.includes('edit_message'))
    permissions.push(entityType === ChatEntityType.CHANNEL ? 'edit_message' : 'write');
  if (effective.includes('moderate_member')) permissions.push('add_remove_members');
  return {
    ...access,
    permissions: [...new Set(permissions)],
    activationCapabilityCeiling: ceiling,
  };
}
