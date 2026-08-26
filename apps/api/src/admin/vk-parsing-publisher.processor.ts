import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { assertPublisherIdentityOrDelay } from '../publisher/publisher-identity-attestation-job-guard';
import { VK_PARSING_PUBLISHER_QUEUE, type VkParsingPublisherJob } from './vk-parsing.queue';
import { VkParsingService } from './vk-parsing.service';

@Processor(VK_PARSING_PUBLISHER_QUEUE, {
  concurrency: 2,
})
export class VkParsingPublisherProcessor extends WorkerHost {
  constructor(
    private readonly vkParsingService: VkParsingService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
  ) {
    super();
  }

  async process(job: Job<VkParsingPublisherJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('VK Publik queue may only be consumed by api-publisher');
    }
    await assertPublisherIdentityOrDelay(this.identityAttestation, job, token);

    if (job.data.kind === 'rollback-delete') {
      if (!job.data.messageId) {
        throw new Error('Publik VK rollback job is missing messageId');
      }
      await this.vkParsingService.processPublisherRollbackJob({
        postId: job.data.postId,
        chatId: job.data.chatId,
        messageId: job.data.messageId,
        requiredBotId: job.data.requiredBotId,
        idempotencyKey: job.data.idempotencyKey,
        attemptsMade: job.attemptsMade,
        maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined,
      });
      return;
    }

    if (!job.data.reason || job.data.dispatchProfile !== 'PUBLIK_V1') {
      throw new Error('Publik VK publish job has an invalid route payload');
    }

    await this.vkParsingService.processPublishPostJob({
      postId: job.data.postId,
      chatId: job.data.chatId,
      reason: job.data.reason,
      idempotencyKey: job.data.idempotencyKey,
      dispatchProfile: job.data.dispatchProfile,
      requiredBotId: job.data.requiredBotId,
      attemptsMade: job.attemptsMade,
      maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined,
    });
  }
}
