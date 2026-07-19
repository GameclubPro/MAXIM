type BootTraceCrypto = {
  randomUUID?: () => string;
  getRandomValues?: (array: Uint8Array) => Uint8Array;
};

let fallbackSequence = 0;

function readGlobalCrypto(): BootTraceCrypto | null {
  return typeof crypto === 'undefined' ? null : crypto;
}

export function createMiniappBootTraceSessionId(
  cryptoSource: BootTraceCrypto | null = readGlobalCrypto(),
  now: () => number = Date.now,
): string {
  if (typeof cryptoSource?.randomUUID === 'function') {
    try {
      const uuid = cryptoSource.randomUUID();
      if (uuid) {
        return uuid;
      }
    } catch {
      // Continue with the next available source.
    }
  }

  if (typeof cryptoSource?.getRandomValues === 'function') {
    try {
      const bytes = new Uint8Array(16);
      cryptoSource.getRandomValues(bytes);
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    } catch {
      // Continue with the monotonic process-local fallback.
    }
  }

  fallbackSequence += 1;
  return `${now().toString(36)}-${fallbackSequence.toString(36)}`;
}
