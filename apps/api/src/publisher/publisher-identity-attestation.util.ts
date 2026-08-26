import { buildBotIdVariants } from '../max/max-bot-config.util';

export type PublisherRemoteIdentity = Readonly<{
  userIds: readonly string[];
  username: string | null;
}>;

export function extractPublisherRemoteIdentity(payload: unknown): PublisherRemoteIdentity {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { userIds: [], username: null };
  }

  const value = payload as Record<string, unknown>;
  const userIds = [
    ...new Set([value.user_id, value.userId, value.id].map(readTrimmedString)),
  ].filter((candidate): candidate is string => candidate !== null);
  return {
    userIds,
    username: readTrimmedString(value.username),
  };
}

export function matchesPublisherRemoteIdentity(
  expectedBotId: string,
  identity: PublisherRemoteIdentity,
): boolean {
  const expectedVariants = buildBotIdVariants(expectedBotId);
  if (expectedVariants.size === 0) {
    return false;
  }

  return [...identity.userIds, identity.username]
    .filter((candidate): candidate is string => candidate !== null)
    .some((candidate) =>
      [...buildBotIdVariants(candidate)].some((variant) => expectedVariants.has(variant)),
    );
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized || null;
}
