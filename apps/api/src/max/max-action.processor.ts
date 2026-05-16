import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import type { MaxActionJob } from './max-client.service';

@Processor('moderation-actions', {
  concurrency: Number(process.env.ACTION_CONCURRENCY ?? 24),
})
export class MaxActionProcessor extends WorkerHost {
  constructor(private readonly maxActionDispatchService: MaxActionDispatchService) {
    super();
  }

  async process(job: Job<MaxActionJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.maxActionDispatchService.execute({
      ...job.data,
      attempt: Math.max(1, job.attemptsMade + 1),
    });
  }
}
