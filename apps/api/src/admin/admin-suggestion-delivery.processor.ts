import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  ADMIN_SUGGESTION_DELIVERY_QUEUE,
  type AdminSuggestionDeliveryJob,
} from './admin-suggestion-delivery.queue';
import { ChannelDialogService } from './channel-dialog.service';

@Processor(ADMIN_SUGGESTION_DELIVERY_QUEUE, {
  concurrency: 2,
})
export class AdminSuggestionDeliveryProcessor extends WorkerHost {
  constructor(private readonly channelDialogService: ChannelDialogService) {
    super();
  }

  async process(job: Job<AdminSuggestionDeliveryJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.channelDialogService.processChannelSuggestionDeliveryJob(job.data.auditLogId);
  }
}
