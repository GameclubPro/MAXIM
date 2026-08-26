import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import {
  PUBLISHER_BINDING_REFRESH_QUEUE,
  type PublisherBindingRefreshJob,
} from './publisher-binding-refresh.queue';
import { PublisherBindingRefreshService } from './publisher-binding-refresh.service';

@Processor(PUBLISHER_BINDING_REFRESH_QUEUE, { concurrency: 2 })
export class PublisherBindingRefreshProcessor extends WorkerHost {
  constructor(private readonly refreshService: PublisherBindingRefreshService) {
    super();
  }

  async process(job: Job<PublisherBindingRefreshJob>): Promise<void> {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher') {
      throw new Error('Publisher binding refresh claimed outside api-publisher');
    }
    await this.refreshService.refresh(job.data);
  }
}
