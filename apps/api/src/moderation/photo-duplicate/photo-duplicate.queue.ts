import { createHash } from 'node:crypto';
import type { QueueJobEnvelope } from '../../common/queue-job-envelope';

export const PHOTO_DUPLICATE_QUEUE = 'photo-duplicates';
export const PHOTO_DUPLICATE_JOB_NAME = 'photo-duplicate-analysis';
export const PHOTO_DUPLICATE_ALGORITHM_VERSION = 1 as const;
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
}>;

export function buildPhotoDuplicateJobId(params: {
  chatId: string;
  messageId: string;
  algorithmVersion?: number;
}): string {
  const digest = createHash('sha256')
    .update(
      `${params.chatId}\n${params.messageId}\n${params.algorithmVersion ?? PHOTO_DUPLICATE_ALGORITHM_VERSION}`,
    )
    .digest('hex');
  return `photo-duplicate__${digest}`;
}
