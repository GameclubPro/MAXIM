export type AdminContactProfileUrlSource = {
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
};

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

export function resolveAdminContactProfileUrl(source: AdminContactProfileUrlSource): string | null {
  return (
    normalizeAdminContactProfileUrl(source.profileUrl) ??
    normalizeAdminContactProfileUrl(source.profileHandoffUrl)
  );
}
