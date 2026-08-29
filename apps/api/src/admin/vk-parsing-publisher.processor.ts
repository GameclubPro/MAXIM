import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import {
  assertPublisherDispatchAllowedOrDelay,
  assertPublisherRuntimeEnabledOrDelay,
} from '../publisher/publisher-dispatch-job-guard';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import {
  VK_PARSING_PUBLISHER_QUEUE,
  type VkParsingPublisherJob,
  type VkParsingPublishReason,
} from './vk-parsing.queue';
import { VkParsingService } from './vk-parsing.service';

const VK_PARSING_PUBLISH_REASONS = new Set<VkParsingPublishReason>([
  'autopublish',
  'manual-retry',
  'manual-schedule',
]);

@Processor(VK_PARSING_PUBLISHER_QUEUE, {
  concurrency: 2,
})
export class VkParsingPublisherProcessor extends WorkerHost {
  constructor(
    private readonly vkParsingService: VkParsingService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly ownership: VkParsingOwnershipService,
  ) {
    super();
  }

  async process(job: Job<VkParsingPublisherJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('VK Publik queue may only be consumed by api-publisher');
    }
    const data =
      typeof job.data === 'object' && job.data !== null
        ? (job.data as Partial<VkParsingPublisherJob>)
        : null;
    const requiredBotId =
      typeof data?.requiredBotId === 'string' ? data.requiredBotId.trim() : '';
    if (!requiredBotId) {
      throw new Error('Publik VK queue job is missing requiredBotId');
    }
    if (requiredBotId !== this.ownership.getPublisherScope().ownerBotId) {
      return;
    }
    if (
      typeof data?.postId !== 'string' ||
      !data.postId.trim() ||
      typeof data.chatId !== 'string' ||
      !data.chatId.trim() ||
      typeof data.idempotencyKey !== 'string' ||
      !data.idempotencyKey.trim()
    ) {
      throw new Error('Publik VK queue job has an invalid base payload');
    }

    if (data.kind === 'rollback-delete') {
      if (typeof data.messageId !== 'string' || !data.messageId.trim()) {
        throw new Error('Publik VK rollback job is missing messageId');
      }
      await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
      await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
      await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);
      await this.vkParsingService.processPublisherRollbackJob({
        postId: data.postId,
        chatId: data.chatId,
        messageId: data.messageId,
        requiredBotId,
        idempotencyKey: data.idempotencyKey,
        attemptsMade: job.attemptsMade,
        maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined,
      });
      return;
    }

    if (
      data.kind !== 'publish' ||
      !data.reason ||
      !VK_PARSING_PUBLISH_REASONS.has(data.reason) ||
      data.dispatchProfile !== 'PUBLIK_V1'
    ) {
      throw new Error('Publik VK publish job has an invalid route payload');
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);
    await assertPublisherDispatchAllowedOrDelay(this.dispatchHealth, job, token);

    await this.vkParsingService.processPublishPostJob({
      postId: data.postId,
      chatId: data.chatId,
      reason: data.reason,
      idempotencyKey: data.idempotencyKey,
      dispatchProfile: data.dispatchProfile,
      requiredBotId,
      attemptsMade: job.attemptsMade,
      maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined,
    });
  }
}
