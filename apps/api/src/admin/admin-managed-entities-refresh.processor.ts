import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { AdminService } from './admin.service';
import {
  ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE,
  type AdminManagedEntitiesRefreshJob,
} from './admin-managed-entities-refresh.queue';

@Processor(ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE, {
  concurrency: 2,
})
export class AdminManagedEntitiesRefreshProcessor extends WorkerHost {
  constructor(private readonly adminService: AdminService) {
    super();
  }

  async process(job: Job<AdminManagedEntitiesRefreshJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.adminService.processManagedEntitiesRefreshJob(job.data);
  }
}
