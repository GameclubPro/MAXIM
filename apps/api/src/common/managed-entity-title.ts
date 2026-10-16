// FLAG: Generated placeholders carry no rename evidence. Missing metadata must not
// replace a known name during connection/access refresh, including a late retry.
export function observedManagedEntityTitle(
  chatId: string,
  title: string | null | undefined,
): string | null {
  const normalized = title?.trim();
  return normalized && normalized !== `Chat ${chatId}` && normalized !== `Channel ${chatId}`
    ? normalized
    : null;
}

export function preserveManagedEntityTitle(
  chatId: string,
  incoming: string,
  previous?: string | null,
): string {
  return (
    observedManagedEntityTitle(chatId, incoming) ??
    observedManagedEntityTitle(chatId, previous) ??
    incoming
  );
}
