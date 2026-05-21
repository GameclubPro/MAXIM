import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';
import { ManagedEntitiesDiscoveryService } from './managed-entities-discovery.service';

@Processor(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, {
  concurrency: 1,
})
export class AdminManagedEntitiesRefreshProcessor extends WorkerHost {
  constructor(private readonly managedEntitiesDiscoveryService: ManagedEntitiesDiscoveryService) {
    super();
  }

  async process(job: Job<AdminManagedEntitiesRefreshJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    const outcome = await this.managedEntitiesDiscoveryService.processManagedEntitiesRefreshJob(
      job.data,
    );
    if (!outcome) {
      return;
    }

    await job.moveToDelayed(Date.now() + outcome.continueAfterMs, job.token);
    throw new DelayedError();
  }
}
