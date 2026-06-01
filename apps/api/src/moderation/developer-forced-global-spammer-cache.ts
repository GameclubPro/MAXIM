export const DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC = 3650 * 24 * 60 * 60;

export function buildDeveloperForcedGlobalSpammerCacheKey(userId: string): string {
  return `global-spammer:developer-forced:${userId.trim()}`;
}
