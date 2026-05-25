import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { VK_PARSING_SYNC_QUEUE, type VkParsingSyncJob } from './vk-parsing.queue';
import { VkParsingService } from './vk-parsing.service';

@Processor(VK_PARSING_SYNC_QUEUE, {
  concurrency: 2,
})
export class VkParsingSyncProcessor extends WorkerHost {
  constructor(private readonly vkParsingService: VkParsingService) {
    super();
  }

  async process(job: Job<VkParsingSyncJob>): Promise<void> {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.vkParsingService.processSyncSourceJob(job.data.sourceId, job.data.reason);
  }
}
