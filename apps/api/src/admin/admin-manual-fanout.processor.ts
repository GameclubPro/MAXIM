import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { AdminService } from './admin.service';
import {
  ADMIN_MANUAL_FANOUT_QUEUE,
  type AdminManualFanoutJob,
} from './admin-manual-fanout.queue';

@Processor(ADMIN_MANUAL_FANOUT_QUEUE, {
  concurrency: 2,
})
export class AdminManualFanoutProcessor extends WorkerHost {
  constructor(private readonly adminService: AdminService) {
    super();
  }

  async process(job: Job<AdminManualFanoutJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.adminService.processManualModerationFanoutJob(job.data);
  }
}
