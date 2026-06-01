import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ManualModerationService } from './manual-moderation.service';
import { ADMIN_SUPER_BAN_QUEUE, type AdminSuperBanJob } from './admin-super-ban.queue';

@Processor(ADMIN_SUPER_BAN_QUEUE, {
  concurrency: 1,
})
export class AdminSuperBanProcessor extends WorkerHost {
  constructor(private readonly manualModerationService: ManualModerationService) {
    super();
  }

  async process(job: Job<AdminSuperBanJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.manualModerationService.processDeveloperSuperBanJob(job.data);
  }
}
