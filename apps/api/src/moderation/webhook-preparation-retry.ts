import { DelayedError, type Job } from 'bullmq';

import type { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import type { ProcessWebhookJob } from '../webhook/webhook-queues';

const WEBHOOK_PREPARATION_RETRY_JITTER_MS = 250;

export class WebhookPreparationRetryError extends Error {
  readonly code = 'WEBHOOK_PREPARATION_RETRY';
  readonly retryAfterMs: number;

  constructor(
    readonly webhookEventId: string,
    cause: WebhookPreparationDeferredError,
  ) {
    super(cause.message, { cause });
    this.name = 'WebhookPreparationRetryError';
    this.retryAfterMs = cause.retryAfterMs;
  }
}

export async function deferWebhookPreparationJob(
  job: Job<ProcessWebhookJob>,
  token: string | undefined,
  error: WebhookPreparationRetryError,
): Promise<never> {
  const lockToken = token ?? job.token;
  if (!lockToken || job.data.webhookEventId !== error.webhookEventId) throw error;

  let hash = 0;
  for (const character of String(job.id ?? error.webhookEventId))
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const jitterMs = hash % (WEBHOOK_PREPARATION_RETRY_JITTER_MS + 1);

  // FLAG: Delay only this locked job. The next attempt must re-enter canonical
  // preparation; never renew a source deadline, clear a claim or replay a started handler.
  try {
    await job.moveToDelayed(Date.now() + error.retryAfterMs + jitterMs, lockToken);
  } catch {
    throw error;
  }
  throw new DelayedError();
}
