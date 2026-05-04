export function collectBotTokenSecrets(...candidates: Array<string | null | undefined>): string[] {
  const normalizedSecrets: string[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }

    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    normalizedSecrets.push(normalized);
  }

  return normalizedSecrets;
}
