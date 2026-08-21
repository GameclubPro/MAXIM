export const MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX =
  'channel-suggestion:publish:v1:';
export const MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG = 'suggestion_delivery';

export function buildMaxActionChannelSuggestionPublicationJobId(suggestionId: string): string {
  return `${MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX}${suggestionId.trim()}`;
}

export function isMaxActionChannelSuggestionPublicationLedger(params: {
  jobId: string;
  actionType: string;
  sourceTag: string | null;
}): boolean {
  const jobId = params.jobId.trim();
  return (
    params.actionType === 'SEND_MESSAGE' &&
    params.sourceTag === MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG &&
    jobId.startsWith(MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX) &&
    jobId.length > MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_LEDGER_PREFIX.length
  );
}
