type MaxUserProfile = Record<string, unknown>;

const EXPLICIT_DISPLAY_NAME_KEYS = [
  'display_name',
  'displayName',
  'full_name',
  'fullName',
] as const;
const FIRST_NAME_KEYS = ['first_name', 'firstName', 'given_name', 'givenName'] as const;
const LAST_NAME_KEYS = ['last_name', 'lastName', 'family_name', 'familyName'] as const;
const LEGACY_DISPLAY_NAME_KEYS = ['name', 'nickname'] as const;

function asProfile(value: unknown): MaxUserProfile | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as MaxUserProfile)
    : null;
}

function readFirstString(
  profiles: readonly MaxUserProfile[],
  keys: readonly string[],
): string | null {
  for (const profile of profiles) {
    for (const key of keys) {
      const candidate = profile[key];
      if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }

  return null;
}

/** Resolves the best user-facing name available in MAX user payload variants. */
export function resolveMaxUserDisplayName(...sources: readonly unknown[]): string | null {
  const profiles = sources
    .map(asProfile)
    .filter((profile): profile is MaxUserProfile => profile !== null);

  const explicitDisplayName = readFirstString(profiles, EXPLICIT_DISPLAY_NAME_KEYS);
  if (explicitDisplayName) {
    return explicitDisplayName;
  }

  const firstName = readFirstString(profiles, FIRST_NAME_KEYS);
  const lastName = readFirstString(profiles, LAST_NAME_KEYS);
  const fullName = [firstName, lastName].filter(Boolean).join(' ');
  if (fullName) {
    return fullName;
  }

  return readFirstString(profiles, LEGACY_DISPLAY_NAME_KEYS);
}

/** Rejects MAX identifiers that occasionally arrive in fields used as display names. */
export function normalizeMaxUserDisplayName(value: unknown, userId?: string | null): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return null;
  }

  const normalizedUserId = typeof userId === 'string' ? userId.trim() : '';
  if (
    (normalizedUserId && normalized === normalizedUserId) ||
    (/^\d+$/u.test(normalized) && normalized.length >= 5)
  ) {
    return null;
  }

  return normalized;
}
