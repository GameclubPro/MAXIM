export const PUBLISHER_SUGGESTION_ADMISSION_ACTION =
  'PUBLISHER_CHANNEL_DIALOG_SUGGESTION_ADMISSION';
export const PUBLISHER_SUGGESTION_ADMISSION_PROTOCOL = 'publisher_suggestion_admission_v1';
export const PUBLISHER_SUGGESTION_ADMISSION_LEASE_MS = 5 * 60_000;
export const PUBLISHER_SUGGESTION_ADMISSION_RETENTION_MS = 25 * 60 * 60_000;
export const PUBLISHER_SUGGESTION_PENDING_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type PublisherSuggestionAdmissionStatus = 'processing' | 'retryable' | 'rejected';
