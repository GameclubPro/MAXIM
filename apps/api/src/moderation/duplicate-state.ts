// v6 stores event timestamps in rolling histories. Do not mix them with v5 processing-time scores.
export const DUPLICATE_COUNTER_KEY_PREFIX = 'dup:v6';
export const DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS = 60_000;

export function resolveDuplicateHistoryRetentionSeconds(windowSeconds: number): number {
  return windowSeconds * 2 + Math.ceil(DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS / 1_000) + 1;
}

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
