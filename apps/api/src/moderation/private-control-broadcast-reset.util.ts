import type { ManagedEntityType } from '@maxim/contracts';
import type { RedisCounterService } from './redis-counter.service';
import {
  BROADCAST_COMPOSER_CLIENT_RESET_KEY_PREFIX,
  BROADCAST_COMPOSER_CLIENT_RESET_TTL_SEC,
} from './private-control.constants';

export { BROADCAST_COMPOSER_CLIENT_RESET_TTL_SEC };

export function buildBroadcastComposerClientResetKey(
  userId: string,
  entityType: ManagedEntityType,
  sourceChatId: string,
): string {
  return `${BROADCAST_COMPOSER_CLIENT_RESET_KEY_PREFIX}:${entityType}:${sourceChatId}:${userId}`;
}

export function normalizeBroadcastComposerClientResetValue(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export async function rememberBroadcastComposerClientReset(
  redisCounter: RedisCounterService | null | undefined,
  userId: string,
  entityType: ManagedEntityType,
  sourceChatId: string,
): Promise<void> {
  if (!redisCounter) {
    return;
  }

  await redisCounter.setStringWithTtl(
    buildBroadcastComposerClientResetKey(userId, entityType, sourceChatId),
    new Date().toISOString(),
    BROADCAST_COMPOSER_CLIENT_RESET_TTL_SEC,
  );
}
