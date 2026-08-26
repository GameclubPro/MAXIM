export const PUBLISHER_SUGGESTION_PUBLICATION_QUEUE = 'publisher-suggestion-publication';
export const PUBLISHER_SUGGESTION_PUBLICATION_JOB = 'publish-approved-suggestion';

export type PublisherSuggestionPublicationJob = {
  suggestionId: string;
  claimToken: string;
  createdAt: string;
};

export const PUBLISHER_SUGGESTION_PUBLICATION_RETRY_POLICY = Object.freeze({
  attempts: 100,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 1_000,
  removeOnFail: 5_000,
});
