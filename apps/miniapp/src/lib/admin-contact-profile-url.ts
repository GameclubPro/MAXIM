export type AdminContactProfileUrlSource = {
  username?: string | null;
  displayName?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};

function normalizeAdminContactProfileLabel(source: AdminContactProfileUrlSource): string | null {
  const displayName = source.displayName?.replace(/\s+/gu, ' ').trim() ?? '';
  if (displayName) {
    return displayName;
  }

  const username = source.username?.replace(/^@+/u, '').trim() ?? '';
  return username || null;
}

export function normalizeAdminContactProfileUrl(
  profileUrl: string | null | undefined,
): string | null {
  const normalizedUrl = profileUrl?.trim() ?? '';
  if (!normalizedUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
  } catch {
    return null;
  }

  return normalizedUrl;
}

function normalizeAdminContactProfileHandoffUrl(
  source: AdminContactProfileUrlSource,
): string | null {
  const normalizedUrl = normalizeAdminContactProfileUrl(source.profileHandoffUrl);
  if (!normalizedUrl) {
    return null;
  }

  try {
    const parsed = new URL(normalizedUrl);
    const startPayload = parsed.searchParams.get('start')?.trim() ?? '';
    if (!startPayload.startsWith('pm2_') && !startPayload.startsWith('pmh-')) {
      return normalizedUrl;
    }

    if (parsed.searchParams.get('profile_label')?.trim()) {
      return parsed.toString();
    }

    const profileLabel = normalizeAdminContactProfileLabel(source);
    if (!profileLabel) {
      return null;
    }

    parsed.searchParams.set('profile_label', profileLabel);
    return parsed.toString();
  } catch {
    return null;
  }
}

export function resolveAdminContactProfileUrl(source: AdminContactProfileUrlSource): string | null {
  return (
    normalizeAdminContactProfileUrl(source.profileUrl) ??
    normalizeAdminContactProfileHandoffUrl(source)
  );
}
