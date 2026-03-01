import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { MaxClientService, type MaxActionJob } from './max-client.service';

@Processor('moderation-actions', {
  concurrency: Number(process.env.ACTION_CONCURRENCY ?? 24),
})
export class MaxActionProcessor extends WorkerHost {
  constructor(private readonly maxClient: MaxClientService) {
    super();
  }

  async process(job: Job<MaxActionJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.maxClient.executeActionJob({
      ...job.data,
      attempt: Math.max(1, job.attemptsMade + 1),
    });
  }
}
