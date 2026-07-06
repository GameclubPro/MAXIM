export function isAmbiguousMaxMutationError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 408 || status === 504) {
    return true;
  }

  if (typeof status === 'number') {
    return false;
  }

  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.trim().length > 0) {
    const normalizedCode = code.trim().toLowerCase();
    if (
      normalizedCode === 'econnreset' ||
      normalizedCode === 'econnaborted' ||
      normalizedCode === 'etimedout' ||
      normalizedCode === 'epipe'
    ) {
      return true;
    }
  }

  const message = error instanceof Error && error.message.trim() ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('terminated') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('econnaborted') ||
    normalized.includes('socket hang up') ||
    normalized.includes('network')
  );
}

export function isAmbiguousMaxSendError(error: unknown): boolean {
  return isAmbiguousMaxMutationError(error);
}
