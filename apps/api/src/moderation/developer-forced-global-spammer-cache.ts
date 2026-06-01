export const DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC = 3650 * 24 * 60 * 60;
export const DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC = 5 * 60;
export const DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS =
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC * 1_000;

export function buildDeveloperForcedGlobalSpammerCacheKey(userId: string): string {
  return `global-spammer:developer-forced:${userId.trim()}`;
}

export function buildDeveloperForcedGlobalSpammerWarmMarkerKey(): string {
  return 'global-spammer:developer-forced:warm-marker';
}
