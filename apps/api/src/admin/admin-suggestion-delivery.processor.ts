import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { AdminService } from './admin.service';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';

@Processor(ADMIN_SUGGESTION_DELIVERY_QUEUE, {
  concurrency: 2,
})
export class AdminSuggestionDeliveryProcessor extends WorkerHost {
  constructor(private readonly adminService: AdminService) {
    super();
  }

  async process(job: Job<AdminSuggestionDeliveryJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.adminService.processChannelSuggestionDeliveryJob(job.data.auditLogId);
  }
}
