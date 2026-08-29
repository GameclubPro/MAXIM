import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { assertPublisherRuntimeEnabledOrDelay } from '../publisher/publisher-dispatch-job-guard';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import {
  VK_PARSING_SYNC_QUEUE,
  type VkParsingSyncJob,
  type VkParsingSyncReason,
} from './vk-parsing.queue';
import { VkParsingService } from './vk-parsing.service';

const VK_PARSING_SYNC_REASONS = new Set<VkParsingSyncReason>([
  'source-added',
  'manual',
  'scheduled',
  'startup',
]);

@Processor(VK_PARSING_SYNC_QUEUE, {
  concurrency: 2,
})
export class VkParsingSyncProcessor extends WorkerHost {
  constructor(
    private readonly vkParsingService: VkParsingService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly ownership: VkParsingOwnershipService,
  ) {
    super();
  }

  async process(job: Job<VkParsingSyncJob>, token?: string): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('VK parsing sync queue may only be consumed by api-publisher');
    }
    const data =
      typeof job.data === 'object' && job.data !== null
        ? (job.data as Partial<VkParsingSyncJob>)
        : null;
    const publisherScope = this.ownership.getPublisherScope();
    if (
      typeof data?.sourceId !== 'string' ||
      !data.sourceId.trim() ||
      !data.reason ||
      !VK_PARSING_SYNC_REASONS.has(data.reason) ||
      data.ownerProfile !== 'PUBLISHER' ||
      data.ownerBotId !== publisherScope.ownerBotId
    ) {
      return;
    }
    await assertPublisherRuntimeEnabledOrDelay(this.runtimeBoundary, job, token);

    await this.vkParsingService.processSyncSourceJob(data.sourceId, data.reason);
  }
}
