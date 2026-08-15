export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED';
export const WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX =
  'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED';
export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_LEASE_MS = 5 * 60_000;
export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS = 60_000;
export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS = 15 * 60_000;
export const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS = 1_000;

const WEBHOOK_EVENT_ERROR_MESSAGE_MAX_LENGTH = 500;

export function buildPendingWebhookTimeoutQuarantineMessage(
  nonce: string,
  errorMessage: string,
): string {
  return `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:${nonce}: ${errorMessage}`.slice(
    0,
    WEBHOOK_EVENT_ERROR_MESSAGE_MAX_LENGTH,
  );
}

export function buildTerminalWebhookTimeoutQuarantineMessage(errorMessage: string): string {
  return `${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}: ${errorMessage}`.slice(
    0,
    WEBHOOK_EVENT_ERROR_MESSAGE_MAX_LENGTH,
  );
}

export function isPendingWebhookTimeoutQuarantineMessage(
  errorMessage: string | null | undefined,
): boolean {
  return (
    typeof errorMessage === 'string' &&
    errorMessage.startsWith(`${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`)
  );
}

export function isTerminalWebhookTimeoutQuarantineMessage(
  errorMessage: string | null | undefined,
): boolean {
  return (
    typeof errorMessage === 'string' &&
    errorMessage.startsWith(`${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}:`)
  );
}
