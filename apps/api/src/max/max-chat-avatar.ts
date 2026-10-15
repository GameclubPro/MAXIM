export type MaxChatAvatar = {
  avatarUrl: string | null;
  avatarState: 'unknown' | 'present' | 'absent';
};

export function readMaxChatAvatar(row: Record<string, unknown>): MaxChatAvatar {
  const icon =
    row.icon && typeof row.icon === 'object' && !Array.isArray(row.icon)
      ? (row.icon as Record<string, unknown>)
      : null;
  const candidates = [
    row.full_icon_url,
    row.fullIconUrl,
    row.icon_url,
    row.iconUrl,
    row.avatar_url,
    row.avatarUrl,
    icon?.url,
    icon?.icon_url,
    icon?.iconUrl,
    icon?.full_url,
    icon?.fullUrl,
    icon?.full_icon_url,
    icon?.fullIconUrl,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const url = new URL(candidate.trim());
      if (url.protocol === 'https:' && !url.username && !url.password) {
        return { avatarUrl: url.href, avatarState: 'present' };
      }
    } catch {
      /* A malformed optional image never invalidates the whole chat snapshot. */
    }
  }
  // FLAG: Only an explicit null icon with no contradictory image value proves absence.
  // An omitted field, empty object, invalid URL or failed request must preserve the last image.
  return {
    avatarUrl: null,
    avatarState:
      row.icon === null && candidates.every((value) => value == null) ? 'absent' : 'unknown',
  };
}
