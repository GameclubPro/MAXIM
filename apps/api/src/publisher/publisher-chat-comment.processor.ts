import { Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherChatCommentDeliveryService } from './publisher-chat-comment-delivery.service';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from './publisher-dispatch-job-guard';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherSetupRequiredException } from './publisher-errors';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from './publisher-identity-attestation-job-guard';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import {
  PUBLISHER_CHAT_COMMENT_QUEUE,
  type PublisherChatCommentJob,
} from './publisher-chat-comment.queue';

@Processor(PUBLISHER_CHAT_COMMENT_QUEUE, {
  concurrency: 2,
})
export class PublisherChatCommentProcessor extends WorkerHost {
  constructor(
    private readonly delivery: PublisherChatCommentDeliveryService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {
    super();
  }

  async process(job: Job<PublisherChatCommentJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher chat-comment job received outside api-publisher');
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
      if (
        job.data.kind === 'attach_chat_reply' &&
        error instanceof PublisherSetupRequiredException
      ) {
        throw new UnrecoverableError(
          `Publisher chat-comment setup blocked: ${error.blockerCode}`,
        );
      }
      throw error;
    }
  }
}
