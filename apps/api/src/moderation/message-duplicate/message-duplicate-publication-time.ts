import type { MaxUpdate } from '@maxim/contracts';

// FLAG: Update.timestamp orders edits; Message.timestamp anchors the duplicate window.
// An edit without a verifiable publication date cannot create a new original.
export function duplicatePublicationTime(update: MaxUpdate): number | undefined {
  const raw = update.raw as { message?: { timestamp?: unknown; createdAt?: unknown } } | undefined;
  const value = raw?.message?.timestamp ?? raw?.message?.createdAt;
  let timestamp =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? /^\d+$/.test(value)
          ? Number(value)
          : Date.parse(value)
        : NaN;
  if (timestamp < 10_000_000_000) timestamp *= 1000;
  if (Number.isSafeInteger(timestamp) && timestamp > 0) return timestamp;
  if (update.type === 'message_created') {
    timestamp = Date.parse(update.message?.createdAt ?? '');
    if (Number.isSafeInteger(timestamp) && timestamp > 0) return timestamp;
  }
  return undefined;
}
