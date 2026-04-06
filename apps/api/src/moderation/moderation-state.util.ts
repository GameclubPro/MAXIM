export const ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC = 10;
export const ACTIVE_MUTE_CACHE_SLACK_SEC = 60;

export type CachedActiveMuteState = {
  eventId: string;
  issuedAt: string;
  expiresAt: string;
  durationHours: number;
};

export function buildActiveMuteStateKey(chatId: string, userId: string): string {
  return `moderation:active-mute:v1:${chatId}:${userId}`;
}
