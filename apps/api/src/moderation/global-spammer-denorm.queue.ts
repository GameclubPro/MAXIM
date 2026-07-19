import { createHash } from 'node:crypto';
import type { QueueJobEnvelope } from '../common/queue-job-envelope';

export const GLOBAL_SPAMMER_DENORM_QUEUE = 'global-spammer-denorm';
export const GLOBAL_SPAMMER_DENORM_JOB_NAME = 'global-spammer-denorm';

export const GLOBAL_SPAMMER_DENORM_JOB_ATTEMPTS = 3;
export const GLOBAL_SPAMMER_DENORM_JOB_BACKOFF_MS = 30_000;

export type GlobalSpammerDenormJob = QueueJobEnvelope<{
  userId: string;
  chatId?: string | null;
  observationId?: string | null;
  source: string;
  reason?: string | null;
  userLabel?: string | null;
  observedAt?: string | null;
  fastPath?: boolean;
  createdAt: string;
}>;

export function buildGlobalSpammerDenormDeduplicationId(userId: string): string {
  return `global-spammer-denorm__${hashQueueToken(userId)}`;
}

export function hashQueueToken(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
