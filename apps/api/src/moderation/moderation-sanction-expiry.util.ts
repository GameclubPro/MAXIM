export function resolveModerationSanctionExpiry(
  action: string,
  value: unknown,
  createdAt: Date,
  fallbackHours?: number,
): { permanent: boolean; expiresAt: Date | null } {
  const metadata =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const hours = readHours(metadata.muteDurationHours) ?? readHours(metadata.banDurationHours);
  const permanent = metadata.mutePermanent === true || (action === 'BAN' && hours === null);
  if (permanent) return { permanent: true, expiresAt: null };
  // FLAG: Fanout preserves the original absolute expiry; later event persistence cannot extend it.
  const explicit =
    typeof metadata.muteExpiresAt === 'string' ? Date.parse(metadata.muteExpiresAt) : NaN;
  if (Number.isFinite(explicit)) return { permanent: false, expiresAt: new Date(explicit) };
  const duration = hours ?? readHours(fallbackHours);
  return {
    permanent: false,
    expiresAt: duration === null ? null : new Date(createdAt.getTime() + duration * 3_600_000),
  };
}

function readHours(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 336
    ? value
    : null;
}
