import { createHash } from 'node:crypto';
import type { QueueJobEnvelope } from '../../common/queue-job-envelope';

export const PHOTO_DUPLICATE_QUEUE = 'photo-duplicates';
export const PHOTO_DUPLICATE_JOB_NAME = 'photo-duplicate-analysis';
export const PHOTO_DUPLICATE_ALGORITHM_VERSION = 2 as const;
export const PHOTO_DUPLICATE_JOB_ATTEMPTS = 5;
export const PHOTO_DUPLICATE_JOB_BACKOFF_MS = 5_000;
export const PHOTO_DUPLICATE_ORDERING_GRACE_MS = 5_000;
export const PHOTO_DUPLICATE_ORDERING_DEFER_MS = 1_000;
export const PHOTO_DUPLICATE_SOURCE_READY_DEFER_MS = 5_000;
export const PHOTO_DUPLICATE_SOURCE_READY_MAX_WAIT_MS = 5 * 60_000;

export class PhotoDuplicateSourceNotReadyError extends Error {
  readonly code = 'PHOTO_DUPLICATE_SOURCE_NOT_READY';

  constructor(webhookEventId: string) {
    super(`Photo duplicate source webhook ${webhookEventId} is not processed yet`);
    this.name = 'PhotoDuplicateSourceNotReadyError';
  }
}

export type PhotoDuplicateJob = QueueJobEnvelope<{
  webhookEventId: string;
  chatId: string;
  messageId: string;
  sourceCreatedAt: string;
  algorithmVersion: typeof PHOTO_DUPLICATE_ALGORITHM_VERSION;
  actionEligible: boolean;
}>;

// FLAG: Only an explicit boolean true permits actions. Missing or malformed values from an old or
// damaged queue payload must remain observation-only instead of being upgraded during processing.
export function normalizePhotoDuplicateActionEligibility(value: unknown): boolean {
  return value === true;
}

export function buildPhotoDuplicateJobId(params: {
  chatId: string;
  messageId: string;
  algorithmVersion?: number;
  actionEligible?: boolean;
}): string {
  // FLAG: Action eligibility is intentionally absent from the identity. A stricter replay must
  // address the same BullMQ job and ordering record, so a later permissive replay cannot fork it.
  const digest = createHash('sha256')
    .update(
      `${params.chatId}\n${params.messageId}\n${params.algorithmVersion ?? PHOTO_DUPLICATE_ALGORITHM_VERSION}`,
    )
    .digest('hex');
  return `photo-duplicate__${digest}`;
}
