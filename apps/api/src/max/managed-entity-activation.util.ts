import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { extractManagedEntityForwardedRecoveryCandidate } from '../common/managed-entity-forwarded-recovery.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedEntityAccessState,
  ManagedEntityAccessRole,
  type Prisma,
} from '../prisma/prisma-client';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { hasConfirmedDeleteMessageAccess } from './max-delete-message-access.util';
import {
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from './max-bot-access-policy.util';
import type { BotAccessSnapshotInput } from './bot-access-snapshot.util';

export const MANAGED_ENTITY_ACTIVATION_READER_VERSION = 1;
export const MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE = 'major_explicit_activation_pending';

export const MANAGED_ENTITY_DORMANT_ACCESS_STATES = [
  ChatBotAccessState.DENIED,
  ChatBotAccessState.LOST,
  ChatBotAccessState.CONFIRMED_MEMBER,
] as const;

export type ManagedEntityExplicitActivation = {
  kind: 'start_in_chat' | 'forwarded_message';
  sourceAt: Date;
  updateId: string;
  actorUserId: string;
  botId: string;
  chatId: string;
};

export class ManagedEntityActivationRequiredError extends Error {
  constructor() {
    super('An explicit administrator Start or forwarded message is required');
    this.name = 'ManagedEntityActivationRequiredError';
  }
}

export function isManagedEntityReceiptAfterActivation(
  permissionsSnapshot: unknown,
  receiptSourceAt: Date,
): boolean {
  const snapshot = normalizeMembershipAccessSnapshot(permissionsSnapshot);
  // FLAG: Legacy healthy memberships have no activation cutline. A present malformed
  // cutline fails closed; passive access freshness must never replace this source epoch.
  if (!snapshot || !Object.hasOwn(snapshot, 'explicitActivationSourceAt')) return true;
  const activatedAt = snapshot.explicitActivationSourceAt;
  return Boolean(
    activatedAt &&
    Number.isFinite(receiptSourceAt.getTime()) &&
    Date.parse(activatedAt) <= receiptSourceAt.getTime(),
  );
}

export function hasExplicitManagedEntityPrivilege(row: Record<string, unknown>): boolean {
  const flags = [
    'is_admin',
    'isAdmin',
    'admin',
    'is_owner',
    'isOwner',
    'owner',
    'is_creator',
    'isCreator',
    'creator',
  ];
  const roles = [
    'role',
    'member_role',
    'memberRole',
    'chat_role',
    'chatRole',
    'status',
    'member_status',
    'memberStatus',
  ];
  const privileged = new Set(['admin', 'administrator', 'owner', 'creator']);
  return (
    flags.some((key) => row[key] === true) ||
    roles.some(
      (key) => typeof row[key] === 'string' && privileged.has(row[key].trim().toLowerCase()),
    )
  );
}

export function isManagedEntityActivationRequired(
  row:
    | { status?: string | null; botAccessState?: string | null; botAccessSource?: string | null }
    | null
    | undefined,
): boolean {
  // FLAG: Confirmed denial is persistent intent, not a cache entry with an expiry.
  return Boolean(
    row &&
    (row.botAccessSource === MAJOR_EXPLICIT_ACTIVATION_PENDING_SOURCE ||
      row.status === ChatBotMembershipStatus.REMOVED ||
      MANAGED_ENTITY_DORMANT_ACCESS_STATES.some((state) => state === row.botAccessState)),
  );
}

export function isMajorManagedEntityActivationRequired(
  row:
    | {
        status?: string | null;
        botAccessState?: string | null;
        botAccessSource?: string | null;
        permissionsSnapshot?: unknown;
      }
    | null
    | undefined,
  entityType: ChatEntityType | null | undefined,
): boolean {
  if (isManagedEntityActivationRequired(row)) return true;
  const access = normalizeMembershipAccessSnapshot(row?.permissionsSnapshot);
  if (!access || !entityType) return false;
  if (
    access.activationCapabilityCeiling &&
    (!access.activationCapabilityCeiling.includes('delete_message') ||
      (entityType === ChatEntityType.CHAT &&
        !access.activationCapabilityCeiling.includes('moderation')))
  )
    return true;
  if (access.permissionsKnown !== true) return false;
  // FLAG: Known insufficient capabilities remain denied after TTL expiry. An absent
  // channel GET proof is unknown read access, not evidence of lost permission.
  return (
    !hasConfirmedDeleteMessageAccess(access, entityType) ||
    (entityType === ChatEntityType.CHAT &&
      !access.permissions.some((permission) =>
        ['read_all_messages', 'can_read_all_messages'].includes(
          normalizePermissionName(permission),
        ),
      ))
  );
}

export function hasMajorActivationCapabilities(
  access: BotAccessSnapshotInput,
  entityType: ChatEntityType,
  channelReadVerified: boolean | undefined,
): boolean {
  if (
    !access ||
    access.explicitPrivilegeEvidence !== true ||
    !(access.isAdmin || access.isOwner) ||
    access.permissionsKnown !== true
  )
    return false;
  const permissions = (access.permissions ?? []).map(normalizePermissionName);
  return (
    hasConfirmedDeleteMessageAccess({ ...access, checkedAt: null, permissions }, entityType) &&
    (entityType === ChatEntityType.CHANNEL
      ? channelReadVerified === true
      : permissions.includes('read_all_messages') || permissions.includes('can_read_all_messages'))
  );
}

export function hasExplicitHumanAdministrator(
  access:
    | {
        userId?: string | null;
        isBot?: boolean | null;
        isAdmin: boolean;
        isOwner: boolean;
        explicitPrivilegeEvidence?: boolean;
      }
    | undefined,
  actorUserId: string,
): boolean {
  const identity = (value: string | null | undefined) =>
    value
      ?.trim()
      .toLowerCase()
      .replace(/^id(?=\d)/u, '') ?? '';
  return Boolean(
    access &&
    access.explicitPrivilegeEvidence === true &&
    access.isBot === false &&
    (access.isAdmin || access.isOwner) &&
    identity(access.userId) &&
    identity(access.userId) === identity(actorUserId),
  );
}

export function isExplicitManagedEntityActivationCurrent(
  proof: ManagedEntityExplicitActivation | undefined,
  chatId: string,
  botId: string,
  now = new Date(),
): proof is ManagedEntityExplicitActivation {
  if (!proof || (proof.kind !== 'start_in_chat' && proof.kind !== 'forwarded_message'))
    return false;
  const sourceAt = proof.sourceAt instanceof Date ? proof.sourceAt.getTime() : Number.NaN;
  return (
    proof.chatId === chatId &&
    proof.botId === botId &&
    typeof proof.updateId === 'string' &&
    proof.updateId.trim().length > 0 &&
    typeof proof.actorUserId === 'string' &&
    proof.actorUserId.trim().length > 0 &&
    Number.isFinite(sourceAt) &&
    sourceAt <= now.getTime() &&
    sourceAt + 5 * 60_000 > now.getTime()
  );
}

export async function hasPersistedManagedEntityActivationSource(
  client: Pick<Prisma.TransactionClient, 'webhookEvent'>,
  proof: ManagedEntityExplicitActivation,
): Promise<boolean> {
  if (!isExplicitManagedEntityActivationCurrent(proof, proof.chatId, proof.botId)) return false;
  // FLAG: Caller labels never grant activation. Read the exact authenticated receipt by
  // its unique bot/update key, then derive the outer actor, action and source again.
  const receipt = await client.webhookEvent.findUnique({
    where: { dedupKey: `${proof.botId}:${proof.updateId}` },
    select: { botId: true, normalizedPayload: true, createdAt: true },
  });
  if (
    !receipt ||
    receipt.botId !== proof.botId ||
    proof.sourceAt.getTime() > receipt.createdAt.getTime()
  )
    return false;
  const payload = receipt.normalizedPayload as Record<string, unknown>;
  if (
    !payload ||
    payload.botId !== proof.botId ||
    payload.updateId !== proof.updateId ||
    readWebhookEventTimestamp(payload)?.getTime() !== proof.sourceAt.getTime()
  )
    return false;
  if (proof.kind === 'forwarded_message') {
    const candidate = extractManagedEntityForwardedRecoveryCandidate(payload);
    return Boolean(
      candidate &&
      candidate.sourceChatId === proof.chatId &&
      candidate.forwarderUserId === proof.actorUserId,
    );
  }
  const message = payload.message as { chatId?: unknown; senderId?: unknown } | undefined;
  return (
    isManagedEntityHandshakeStartCommand(payload) &&
    message?.chatId === proof.chatId &&
    message.senderId === proof.actorUserId
  );
}

export function newerManagedEntityActorConflictWhere(
  chatId: string,
  userIds: string[],
  botId: string,
  probeStartedAt: Date,
): Prisma.ManagedEntityAccessEdgeWhereInput {
  // FLAG: Another verified bot may grant this same human concurrently. Its positive
  // admin/owner verdict or its bot-scoped denial cannot revoke our exact bot proof;
  // own newer epochs and negative/unknown actor verdicts still supersede activation.
  return {
    chatId,
    userId: { in: userIds },
    checkedAt: { gt: probeStartedAt },
    OR: [
      { botId },
      { state: ManagedEntityAccessState.USER_DENIED },
      { userRole: { notIn: [ManagedEntityAccessRole.ADMIN, ManagedEntityAccessRole.OWNER] } },
    ],
  };
}
