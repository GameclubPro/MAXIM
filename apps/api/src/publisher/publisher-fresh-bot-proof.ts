import { isPublisherManagedEntityActivationRequired } from './publisher-entity-connection.util';
import type { MaxChatMemberAccess } from '../max/max-client.service';
import { ChatBotAccessState, ChatBotMembershipStatus } from '../prisma/prisma-client';
import { publisherAccessProbeLifecycleSuperseded } from './publisher-access-probe-fence';

export function readPublisherFreshBotProof(
  binding: {
    publisherBotId: string;
    status: ChatBotMembershipStatus;
    botAccessState: ChatBotAccessState;
    botAccessCheckedAt: Date | null;
    botAccessExpiresAt?: Date | null;
    lifecycleEventAt: Date | null;
    lifecycleEventType?: string | null;
    permissionsSnapshot: unknown;
    botAccessSource?: string | null;
  } | null,
  botId: string,
  now: Date,
): MaxChatMemberAccess | null {
  if (
    !binding ||
    isPublisherManagedEntityActivationRequired(binding) ||
    binding.publisherBotId !== botId ||
    binding.status !== ChatBotMembershipStatus.ACTIVE ||
    !binding.botAccessCheckedAt ||
    !binding.botAccessExpiresAt ||
    binding.botAccessCheckedAt > now ||
    binding.botAccessCheckedAt.getTime() <= now.getTime() - 15 * 60_000 ||
    binding.botAccessExpiresAt.getTime() <= now.getTime() + 30_000 ||
    publisherAccessProbeLifecycleSuperseded(binding, binding.botAccessCheckedAt)
  )
    return null;
  const raw = binding.permissionsSnapshot;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const snapshot = raw as Record<string, unknown>;
  if (
    snapshot.checkedAt !== binding.botAccessCheckedAt.toISOString() ||
    !Array.isArray(snapshot.permissions) ||
    !snapshot.permissions.every((p) => typeof p === 'string') ||
    (binding.botAccessState !== ChatBotAccessState.CONFIRMED_ADMIN &&
      binding.botAccessState !== ChatBotAccessState.CONFIRMED_OWNER) ||
    (binding.botAccessState === ChatBotAccessState.CONFIRMED_OWNER
      ? snapshot.isOwner !== true
      : snapshot.isAdmin !== true || snapshot.isOwner === true)
  )
    return null;
  // FLAG: Only this exact SQL snapshot may replace the duplicate remote bot probe.
  // The actor commit independently fences lifecycle, expiry and the same checkedAt.
  return {
    userId: null,
    isAdmin: snapshot.isAdmin === true,
    isOwner: snapshot.isOwner === true,
    permissions: snapshot.permissions as string[],
    permissionsKnown: snapshot.permissionsKnown === true,
  };
}

export class PublisherBotProofSupersededError extends Error {
  constructor() {
    super('Publisher actor verification must retry after bot proof supersession');
    this.name = 'PublisherBotProofSupersededError';
  }
}
