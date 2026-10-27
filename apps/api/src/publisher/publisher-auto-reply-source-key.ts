import { createHash } from 'node:crypto';

export type PublisherAutoReplySourceIdentity = {
  publisherBotId: string;
  chatId: string;
  sourceMessageId: string;
};

// FLAG: Claim admission and held-removal absence checks must use the same source alias.
export function buildPublisherAutoReplySourceSemanticKey(
  params: PublisherAutoReplySourceIdentity,
): string {
  const values = (['publisherBotId', 'chatId', 'sourceMessageId'] as const).map((label) => {
    const value = params[label].trim();
    if (!value) throw new Error(`Publisher auto-reply source fence ${label} is required`);
    return value;
  });
  const digest = createHash('sha256').update(JSON.stringify(values)).digest('hex');
  return `publisher-auto-reply-source:${digest}`;
}
