// FLAG: Only managed_refresh probes use this classifier. Their local source budget
// and the remote token budget are bot-scoped; other source budgets keep their scope.
export function managedRefreshBackoffMs(error: unknown, now = Date.now()): number | null {
  const value = error as {
    code?: unknown;
    retryAfterMs?: unknown;
    response?: { status?: number; headers?: Record<string, unknown> };
  } | null;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    value?.response?.status !== 429 &&
    value?.code !== 'MAX_API_INTERNAL_RATE_LIMIT' &&
    !message.includes('rate limit exceeded') &&
    !message.includes('source limit exceeded')
  ) {
    return null;
  }
  const retryAfter = value?.response?.headers?.['retry-after'];
  const seconds =
    typeof retryAfter === 'string' || typeof retryAfter === 'number' ? Number(retryAfter) : NaN;
  const remoteMs = Number.isFinite(seconds)
    ? seconds * 1000
    : typeof retryAfter === 'string'
      ? Date.parse(retryAfter) - now
      : NaN;
  const localMs = typeof value?.retryAfterMs === 'number' ? value.retryAfterMs : NaN;
  return Math.max(
    10_000,
    Number.isFinite(remoteMs) ? remoteMs : 0,
    Number.isFinite(localMs) ? localMs : 0,
  );
}
