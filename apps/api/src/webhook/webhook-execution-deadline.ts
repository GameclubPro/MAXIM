import type { MaxUpdate } from '@maxim/contracts';
import {
  extractDuplicateMessageContent,
  isExactImageContent,
} from '../moderation/message-duplicate/message-duplicate-content';
import { readWebhookEventTimestamp } from './webhook-semantic-event-key';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';

export const WEBHOOK_NO_EXECUTABLE_OWNER = 'NO_EXECUTABLE_OWNER';
const TEXT_PENDING_READINESS_MS = 5 * 60_000;
const IMAGE_PENDING_READINESS_MS = 10 * 60_000;

export function buildWebhookExecutionDeadlineAt(
  update: MaxUpdate,
  receiptCreatedAt: Date,
): Date | null {
  const eventType = update.type.trim().toLowerCase();
  if (eventType !== 'message_created' && eventType !== 'message_edited') return null;
  const source = readWebhookEventTimestamp(update) ?? receiptCreatedAt;
  const sourceMs = Math.min(source.getTime(), receiptCreatedAt.getTime());
  if (!Number.isFinite(sourceMs)) return null;
  // FLAG: This bounds only unstarted executor readiness. Rule-specific source deadlines
  // remain stricter; retrying or choosing another bot never starts a new time window.
  const lifetime = isExactImageContent(extractDuplicateMessageContent(update.raw))
    ? IMAGE_PENDING_READINESS_MS
    : TEXT_PENDING_READINESS_MS;
  return new Date(sourceMs + lifetime);
}

export function hasWebhookReplayFence(event: {
  errorMessage: string | null;
  timeoutQuarantineExpiresAt: Date | null;
}): boolean {
  return (
    event.timeoutQuarantineExpiresAt !== null ||
    Boolean(
      event.errorMessage?.startsWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX) ||
      event.errorMessage?.startsWith(WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX) ||
      event.errorMessage?.toLowerCase().includes('ambiguous'),
    )
  );
}

export function hasExpiredWebhookReadinessWait(
  result: unknown,
  webhookEventId: string,
  semanticKey: string,
  deadlineAt: Date | null,
): boolean {
  const row = result as Record<string, unknown> | null;
  return Boolean(
    deadlineAt &&
    deadlineAt.getTime() <= Date.now() &&
    row?.kind === 'EXECUTION_WAITING' &&
    row.authorityVersion === MULTIBOT_EXECUTION_AUTHORITY_VERSION &&
    row.webhookEventId === webhookEventId &&
    row.semanticKey === semanticKey &&
    row.deadlineAt === deadlineAt.toISOString(),
  );
}
