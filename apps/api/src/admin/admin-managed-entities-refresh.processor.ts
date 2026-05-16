import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { ManagedEntitiesService } from './managed-entities.service';

@Processor(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, {
  concurrency: 1,
})
export class AdminManagedEntitiesRefreshProcessor extends WorkerHost {
  constructor(private readonly managedEntitiesService: ManagedEntitiesService) {
    super();
  }

  async process(job: Job<AdminManagedEntitiesRefreshJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    const outcome = await this.managedEntitiesService.processManagedEntitiesRefreshJob(job.data);
    if (!outcome) {
      return;
    }

    await job.moveToDelayed(Date.now() + outcome.continueAfterMs, job.token);
    throw new DelayedError();
  }
}
