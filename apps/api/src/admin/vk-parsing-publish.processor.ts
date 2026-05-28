import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { VK_PARSING_PUBLISH_QUEUE, type VkParsingPublishJob } from './vk-parsing.queue';
import { VkParsingService } from './vk-parsing.service';

@Processor(VK_PARSING_PUBLISH_QUEUE, {
  concurrency: 2,
})
export class VkParsingPublishProcessor extends WorkerHost {
  constructor(private readonly vkParsingService: VkParsingService) {
    super();
  }

  async process(job: Job<VkParsingPublishJob>): Promise<void> {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.vkParsingService.processPublishPostJob({
      postId: job.data.postId,
      chatId: job.data.chatId,
      reason: job.data.reason,
      idempotencyKey: job.data.idempotencyKey,
      attemptsMade: job.attemptsMade,
      maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : undefined,
    });
  }
}
