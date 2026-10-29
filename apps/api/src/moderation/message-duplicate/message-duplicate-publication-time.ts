import type { MaxUpdate } from '@maxim/contracts';
import { selectMaxMessageCandidate } from '../../max/max-message-candidate.util';

// FLAG: Update.timestamp orders edits; Message.timestamp anchors the duplicate window.
// An edit without a verifiable publication date cannot create a new original.
export function duplicatePublicationTime(update: MaxUpdate): number | undefined {
  const raw = update.raw;
  // FLAG: Read the publication clock from the same outer message as ingress, including
  // supported envelopes. An update/forward timestamp cannot renew the original's window.
  const message =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? selectMaxMessageCandidate(raw as Record<string, unknown>, update.type)?.node
      : undefined;
  const value = message?.timestamp ?? message?.createdAt ?? message?.created_at;
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
