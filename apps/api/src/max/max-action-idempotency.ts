import { createHash } from 'node:crypto';

const MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH = 48;
const MAX_ACTION_IDEMPOTENCY_KEY_READABLE_MAX_LENGTH = 160;

export function normalizeMaxActionIdempotencyKeyPart(value: string): string {
  const normalized = value.trim().toLowerCase();
  let readable = '';
  let separatorPending = false;

  for (const character of normalized) {
    const code = character.charCodeAt(0);
    const allowed = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-';
    if (!allowed) {
      separatorPending = true;
      continue;
    }

    if (separatorPending && readable.length > 0) {
      readable += '_';
      if (readable.length >= MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH) break;
    }
    separatorPending = false;
    readable += character;
    if (readable.length >= MAX_ACTION_IDEMPOTENCY_KEY_PART_MAX_LENGTH) break;
  }

  return readable;
}

// FLAG: These bytes define existing Redis, BullMQ and SQL identities. Keep their canonical
// separator, readable truncation and digest unchanged when sharing receipt validation.
export function buildMaxActionIdempotencyKey(namespace: string, parts: readonly string[]): string {
  const normalizedParts = [namespace, ...parts].map((part) => part.trim()).filter(Boolean);
  const canonical = normalizedParts.join('\u001f');
  const digest = createHash('sha256').update(canonical).digest('base64url').slice(0, 24);
  const readable = normalizedParts
    .map(normalizeMaxActionIdempotencyKeyPart)
    .filter(Boolean)
    .join('__')
    .slice(0, MAX_ACTION_IDEMPOTENCY_KEY_READABLE_MAX_LENGTH)
    .replace(/_+$/u, '');

  return readable ? `max-action__${readable}__${digest}` : `max-action__${digest}`;
}
