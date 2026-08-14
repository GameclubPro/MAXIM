import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

const MAX_APPROVAL_PUBLIC_KEY_BASE64_LENGTH = 4_096;

export function parseCanonicalCommercialOcrApprovalPublicKeyBase64(
  value: unknown,
): KeyObject | null {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > MAX_APPROVAL_PUBLIC_KEY_BASE64_LENGTH
  ) {
    return null;
  }
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.byteLength < 1 || bytes.toString('base64') !== value) {
      return null;
    }
    const key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    const canonicalDer = key.export({ format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519' || !canonicalDer.equals(bytes)) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

export function resolveCommercialOcrApprovalKeyIdSha256(value: unknown): string | null {
  const key = parseCanonicalCommercialOcrApprovalPublicKeyBase64(value);
  if (!key) {
    return null;
  }
  return createHash('sha256')
    .update(key.export({ format: 'der', type: 'spki' }))
    .digest('hex');
}
