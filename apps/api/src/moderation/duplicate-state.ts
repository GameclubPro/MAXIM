export const DUPLICATE_COUNTER_KEY_PREFIX = 'dup:v5';

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

export function buildDuplicateMessageStateKey(
  chatId: string,
  userId: string,
  messageHash: string,
): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:message:${messageHash}`;
}

export function buildDuplicateFingerprintMembershipKey(
  chatId: string,
  userId: string,
  hash: string,
  fingerprintType: string,
): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:fingerprint:${fingerprintType}:${hash}`;
}

export function buildDuplicateUserPattern(chatId: string, userId: string): string {
  return `${DUPLICATE_COUNTER_KEY_PREFIX}:${chatId}:${userId}:*`;
}
