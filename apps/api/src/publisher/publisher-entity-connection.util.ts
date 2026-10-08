import { ChatBotAccessState, ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';
import {
  normalizeMembershipAccessSnapshot,
  normalizePermissionName,
} from '../max/max-bot-access-policy.util';
import { isManagedEntityActivationRequired } from '../max/managed-entity-activation.util';

export const PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE = 'publisher_explicit_activation_pending';

export const PUBLISHER_CONFIRMED_CONNECTION_STATES = [
  ChatBotAccessState.CONFIRMED_ADMIN,
  ChatBotAccessState.CONFIRMED_OWNER,
] as const;

const PUBLISHER_CONFIRMED_CONNECTION_STATE_SET = new Set<ChatBotAccessState>(
  PUBLISHER_CONFIRMED_CONNECTION_STATES,
);

type PublisherConnectionBinding = {
  publisherBotId: string;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  permissionsSnapshot?: unknown;
  botAccessSource?: string | null;
  lastSeenAt?: Date | null;
  lastWebhookAt: Date | null;
};

export function publisherConnectedBindingWhere(
  publisherBotId: string,
): Prisma.PublisherEntityBindingWhereInput {
  return {
    publisherBotId,
    status: ChatBotMembershipStatus.ACTIVE,
    AND: [
      {
        OR: [
          { botAccessSource: null },
          { botAccessSource: { not: PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE } },
        ],
      },
    ],
    OR: [
      { botAccessState: { in: [...PUBLISHER_CONFIRMED_CONNECTION_STATES] } },
      {
        botAccessState: ChatBotAccessState.UNKNOWN,
        lastWebhookAt: { not: null },
      },
    ],
  };
}

export function isPublisherBindingConnected(
  binding: PublisherConnectionBinding | null,
  publisherBotId: string,
): boolean {
  if (
    !isExactActiveBinding(binding, publisherBotId) ||
    isPublisherManagedEntityActivationRequired(binding)
  ) {
    return false;
  }
  return (
    PUBLISHER_CONFIRMED_CONNECTION_STATE_SET.has(binding.botAccessState) ||
    (binding.botAccessState === ChatBotAccessState.UNKNOWN && binding.lastWebhookAt !== null)
  );
}

export function publisherRefreshEvidenceWhere(
  publisherBotId: string,
): Prisma.PublisherEntityBindingWhereInput {
  return {
    publisherBotId,
    status: ChatBotMembershipStatus.ACTIVE,
    AND: [
      {
        OR: [
          { botAccessSource: null },
          { botAccessSource: { not: PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE } },
        ],
      },
    ],
    botAccessState: {
      notIn: [
        ChatBotAccessState.DENIED,
        ChatBotAccessState.LOST,
        ChatBotAccessState.CONFIRMED_MEMBER,
      ],
    },
    OR: [
      { botAccessState: { in: [...PUBLISHER_CONFIRMED_CONNECTION_STATES] } },
      { lastWebhookAt: { not: null } },
    ],
  };
}

export function hasPublisherRefreshEvidence(
  binding: PublisherConnectionBinding | null,
  publisherBotId: string,
): boolean {
  return (
    isExactActiveBinding(binding, publisherBotId) &&
    !isPublisherManagedEntityActivationRequired(binding) &&
    (PUBLISHER_CONFIRMED_CONNECTION_STATE_SET.has(binding.botAccessState) ||
      binding.lastWebhookAt !== null)
  );
}

function isExactActiveBinding(
  binding: PublisherConnectionBinding | null,
  publisherBotId: string,
): binding is PublisherConnectionBinding {
  return (
    binding !== null &&
    binding.publisherBotId === publisherBotId &&
    binding.status === ChatBotMembershipStatus.ACTIVE
  );
}

const PUBLISHER_WRITE_PERMISSIONS = new Set([
  'write',
  'can_write',
  'post_edit_delete_message',
  'post_edit_delete_messages',
  'can_post_edit_delete_message',
  'can_post_edit_delete_messages',
]);

type PublisherWriteAccess = {
  isOwner?: boolean;
  isAdmin?: boolean;
  permissionsKnown?: boolean;
  permissions?: readonly string[];
};

export function hasPublisherWriteAccess(access: PublisherWriteAccess | null | undefined): boolean {
  return Boolean(
    access?.isOwner ||
    (access?.isAdmin &&
      access.permissionsKnown === true &&
      access.permissions?.some((permission) =>
        PUBLISHER_WRITE_PERMISSIONS.has(normalizePermissionName(permission)),
      )),
  );
}

export function hasPublisherKnownWriteDenial(
  access: PublisherWriteAccess | null | undefined,
): boolean {
  return Boolean(
    access &&
    !access.isOwner &&
    access.isAdmin &&
    access.permissionsKnown === true &&
    !hasPublisherWriteAccess(access),
  );
}

export function isPublisherManagedEntityActivationRequired(
  row:
    | {
        status?: string | null;
        botAccessState?: string | null;
        permissionsSnapshot?: unknown;
        botAccessSource?: string | null;
      }
    | null
    | undefined,
): boolean {
  // FLAG: A known missing publication right is persistent denial even when MAX reports admin.
  // Unknown permissions and transport failures remain eligible for ordinary revalidation.
  return (
    isPublisherExplicitActivationPending(row) ||
    isManagedEntityActivationRequired(row) ||
    (row?.botAccessState === ChatBotAccessState.CONFIRMED_ADMIN &&
      hasPublisherKnownWriteDenial(normalizeMembershipAccessSnapshot(row.permissionsSnapshot)))
  );
}

export function isPublisherExplicitActivationPending(
  row: { botAccessSource?: string | null } | null | undefined,
): boolean {
  return row?.botAccessSource === PUBLISHER_EXPLICIT_ACTIVATION_PENDING_SOURCE;
}

export function isPublisherActivationSourceAfterEpoch(
  row:
    | {
        status?: string | null;
        botAccessState?: string | null;
        botAccessSource?: string | null;
        permissionsSnapshot?: unknown;
        botAccessCheckedAt?: Date | null;
        lifecycleEventAt?: Date | null;
      }
    | null
    | undefined,
  sourceAt: Date,
): boolean {
  // FLAG: The first Start may itself create a pending shell at the same event time.
  // Confirmed denial/removal always requires a strictly newer activation source.
  const allowsSamePendingSource =
    isPublisherExplicitActivationPending(row) &&
    !isManagedEntityActivationRequired(row) &&
    !hasPublisherKnownWriteDenial(normalizeMembershipAccessSnapshot(row?.permissionsSnapshot));
  return (
    Number.isFinite(sourceAt.getTime()) &&
    [row?.botAccessCheckedAt, row?.lifecycleEventAt].every(
      (at) =>
        !at ||
        (Number.isFinite(at.getTime()) &&
          (allowsSamePendingSource
            ? sourceAt.getTime() >= at.getTime()
            : sourceAt.getTime() > at.getTime())),
    )
  );
}
