import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE,
  PublisherAutoReplyAuthoringQueueService,
  type PublisherAutoReplyAuthoringJob,
} from '../publisher/publisher-auto-reply-authoring.queue';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { PublisherAutoReplyAuthoringDeliveryService } from './publisher-auto-reply-authoring-delivery.service';
import { PublisherAutoReplyAuthoringProcessingService } from './publisher-auto-reply-authoring-processing.service';

@Processor(PUBLISHER_AUTO_REPLY_AUTHORING_QUEUE, { concurrency: 3 })
export class PublisherAutoReplyAuthoringProcessor extends WorkerHost {
  constructor(
    private readonly processing: PublisherAutoReplyAuthoringProcessingService,
    private readonly delivery: PublisherAutoReplyAuthoringDeliveryService,
    private readonly queue: PublisherAutoReplyAuthoringQueueService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {
    super();
  }

  async process(job: Job<PublisherAutoReplyAuthoringJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher auto-reply authoring job claimed outside api-publisher');
    }
    if (job.data.version !== 1) {
      throw new Error('Unsupported Publisher auto-reply authoring job version');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    if (job.data.kind === 'notify') {
      await this.delivery.deliver(job.data);
      return;
    }

    const maxAttempts =
      typeof job.opts.attempts === 'number' && Number.isFinite(job.opts.attempts)
        ? Math.max(1, Math.trunc(job.opts.attempts))
        : 1;
    try {
      const result =
        job.data.kind === 'activate'
          ? await this.processing.activate(job.data.sessionId)
          : await this.processing.processContent(job.data.sessionId);
      if (
        result === 'ready' ||
        result === 'conflict' ||
        result === 'failed' ||
        result === 'activated'
      ) {
        await this.queue.enqueueNotification({
          sessionId: job.data.sessionId,
          notification: result,
          ...(job.data.kind === 'activate' && job.data.callbackId
            ? { callbackId: job.data.callbackId }
            : {}),
          dedupeKey: `${result}-${job.data.requestedAt}`,
        });
      }
    } catch (error: unknown) {
      if (job.attemptsMade + 1 >= maxAttempts) {
        const failed = await this.processing.failInternalAfterFinalAttempt(job.data.sessionId);
        if (failed) {
          await this.queue.enqueueNotification({
            sessionId: job.data.sessionId,
            notification: 'failed',
            dedupeKey: 'terminal-internal-error',
          });
        }
      }
      throw error;
    }
  }
}
