import { ChatBotAccessState, ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';

export const PUBLISHER_CONFIRMED_CONNECTION_STATES = [
  ChatBotAccessState.CONFIRMED_MEMBER,
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
  lastSeenAt?: Date | null;
  lastWebhookAt: Date | null;
};

export function publisherConnectedBindingWhere(
  publisherBotId: string,
): Prisma.PublisherEntityBindingWhereInput {
  return {
    publisherBotId,
    status: ChatBotMembershipStatus.ACTIVE,
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
  if (!isExactActiveBinding(binding, publisherBotId)) {
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
