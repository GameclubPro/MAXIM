export function createHomeRefreshCooldownDeadline(
  retryAfterMs: number | null | undefined,
  observedAtMs: number,
): number | null {
  if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return null;
  }

  return observedAtMs + Math.ceil(retryAfterMs);
}

export function getHomeRefreshCooldownRemainingSec(
  deadlineAtMs: number | null,
  nowMs: number,
): number | null {
  if (deadlineAtMs === null) {
    return null;
  }

  const remainingMs = deadlineAtMs - nowMs;
  return remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / 1_000)) : null;
}
