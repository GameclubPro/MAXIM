export function readMaxMemberActivity(value: unknown, nowMs = Date.now()): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const user =
    row.user && typeof row.user === 'object' && !Array.isArray(row.user)
      ? (row.user as Record<string, unknown>)
      : null;
  const timestamp = Object.hasOwn(row, 'last_activity_time')
    ? row.last_activity_time
    : user?.last_activity_time;
  // FLAG: Missing/private activity is unknown, never an epoch date or inferred from messages.
  if (
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < Date.UTC(2020, 0, 1) ||
    timestamp > nowMs
  )
    return null;
  return new Date(timestamp).toISOString();
}
