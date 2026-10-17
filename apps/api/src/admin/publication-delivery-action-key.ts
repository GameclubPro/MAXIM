// FLAG: Saved publication content identity determines the existing SEND fence.
// This narrow helper cannot substitute current content or manufacture legacy hashes.
export function buildPublicationDeliveryActionKey(input: {
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  contentRevisionId: string;
  attemptCount?: number;
}): string {
  const base = `managed-broadcast:send:${input.broadcastId}:occurrence:${input.occurrenceIndex}:target:${input.targetChatId}:content:publication-${input.contentRevisionId}`;
  return (input.attemptCount ?? 1) <= 1 ? base : `${base}:attempt:${input.attemptCount}`;
}
