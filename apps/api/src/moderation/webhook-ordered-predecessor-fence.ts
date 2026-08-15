import { DelayedError, type Job } from 'bullmq';

import type { ProcessWebhookJob } from '../webhook/webhook-queues';

const WEBHOOK_ORDERED_PREDECESSOR_DELAY_BASE_MS = 2_000;
const WEBHOOK_ORDERED_PREDECESSOR_DELAY_JITTER_MS = 1_000;

export class WebhookOrderedPredecessorPendingError extends Error {
  readonly code = 'WEBHOOK_ORDERED_PREDECESSOR_PENDING';

  constructor(
    readonly webhookEventId: string,
    readonly predecessorWebhookEventId: string,
  ) {
    super(
      `Webhook ${webhookEventId} is waiting for ordered predecessor ${predecessorWebhookEventId}`,
    );
    this.name = 'WebhookOrderedPredecessorPendingError';
  }
}

export async function deferWebhookOrderedPredecessorJob(
  job: Job<ProcessWebhookJob>,
  token: string | undefined,
  error: WebhookOrderedPredecessorPendingError,
): Promise<never> {
  const lockToken = token ?? job.token;
  if (!lockToken) {
    throw error;
  }

  const jobId = String(job.id ?? error.webhookEventId);
  let hash = 0;
  for (const character of jobId) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  const jitterMs = hash % (WEBHOOK_ORDERED_PREDECESSOR_DELAY_JITTER_MS + 1);

  try {
    await job.moveToDelayed(
      Date.now() + WEBHOOK_ORDERED_PREDECESSOR_DELAY_BASE_MS + jitterMs,
      lockToken,
    );
  } catch {
    throw error;
  }
  throw new DelayedError();
}
