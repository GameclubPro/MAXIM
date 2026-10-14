export function collectMaxRetryErrorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current && !visited.has(current); depth += 1) {
    chain.push(current);
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

export function readMaxRetryAfterMs(error: unknown, nowMs: number): number {
  let requestedDelayMs = 0;
  const addDelay = (rawValue: unknown, factor: number): boolean => {
    if (typeof rawValue !== 'number' && typeof rawValue !== 'string') return false;
    if (typeof rawValue === 'string' && !/^\d+(?:\.\d+)?$/.test(rawValue.trim())) return false;
    const delayMs = Math.ceil(Number(rawValue) * factor);
    if (
      !Number.isFinite(delayMs) ||
      delayMs < 0 ||
      delayMs > 8_640_000_000_000_000 - 5_000 - nowMs
    ) {
      return false;
    }
    requestedDelayMs = Math.max(requestedDelayMs, delayMs);
    return true;
  };
  for (const current of collectMaxRetryErrorChain(error)) {
    const record = current as {
      retryAfterMs?: unknown;
      response?: {
        data?: { retry_after_ms?: unknown; retryAfterMs?: unknown };
        headers?: Record<string, unknown>;
      };
    };
    for (const rawValue of [
      record.retryAfterMs,
      record.response?.data?.retry_after_ms,
      record.response?.data?.retryAfterMs,
    ]) {
      addDelay(rawValue, 1);
    }

    const headers = record.response?.headers;
    const rawHeader = headers?.['retry-after'] ?? headers?.['Retry-After'];
    for (const header of Array.isArray(rawHeader) ? rawHeader : [rawHeader]) {
      if (addDelay(header, 1_000)) continue;
      if (typeof header !== 'string' || !/[A-Za-z]/.test(header)) continue;
      const retryAtMs = Date.parse(header);
      if (Number.isFinite(retryAtMs)) {
        addDelay(Math.max(0, retryAtMs - nowMs), 1);
      }
    }
  }
  return requestedDelayMs;
}
