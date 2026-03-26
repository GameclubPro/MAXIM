export const DUPLICATE_COUNTER_KEY_PREFIX = 'dup:v4';

export function buildDuplicateHitKey(chatId: string, userId: string, hash: string): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:${hash}:hit`;
}

export function buildDuplicateStageKey(
  chatId: string,
  userId: string,
  hash: string,
  stageName: string,
): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:${hash}:${stageName}`;
}

export function buildDuplicateUserPattern(chatId: string, userId: string): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:*`;
}
