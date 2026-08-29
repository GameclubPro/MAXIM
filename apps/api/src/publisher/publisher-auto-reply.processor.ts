import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PublisherAutoReplyDeliveryService,
  PublisherAutoReplyDueError,
} from './publisher-auto-reply-delivery.service';
import {
  PUBLISHER_AUTO_REPLY_QUEUE,
  type PublisherAutoReplyJob,
} from './publisher-auto-reply.queue';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from './publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from './publisher-identity-attestation-job-guard';
import { delayPublisherJobOrRethrow } from './publisher-job-delay';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

@Processor(PUBLISHER_AUTO_REPLY_QUEUE, { concurrency: 4 })
export class PublisherAutoReplyProcessor extends WorkerHost {
  constructor(
    private readonly delivery: PublisherAutoReplyDeliveryService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {
    super();
  }

  async process(job: Job<PublisherAutoReplyJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher auto-reply job received outside api-publisher');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    const maxAttempts =
      typeof job.opts.attempts === 'number' && Number.isFinite(job.opts.attempts)
        ? Math.max(1, Math.trunc(job.opts.attempts))
        : 1;
    try {
      await this.delivery.process(job.data, {
        final: job.attemptsMade + 1 >= maxAttempts,
        attemptsMade: job.attemptsMade + 1,
        maxAttempts,
      });
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyDueError) {
        await delayPublisherJobOrRethrow(job, token, error.delayMs, error);
      }
      throw error;
    }
  }
}
