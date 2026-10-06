import type { MaxUpdate } from '@maxim/contracts';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

// FLAG: Publisher observation completion is independent from moderation execution.
// Keep its receipts outside moderation's semantic anchors and prior-effect proofs;
// moderation claims and their original keys must never be renamed or ignored.
export function buildWebhookReceiptSemanticKey(
  update: MaxUpdate,
  publisherBotId: string,
): string | null {
  const key = buildWebhookSemanticEventKey(update);
  if (!key || update.botId?.trim() !== publisherBotId) return key;
  return `publisher-observation:v1:${publisherBotId}:${key}`;
}
