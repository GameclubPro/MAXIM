import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterSyncJob,
} from './max-chat-admin-roster-sync.queue';
import { MaxChatAdminRosterSyncService } from './max-chat-admin-roster-sync.service';

@Processor(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE, {
  concurrency: 1,
})
export class MaxChatAdminRosterSyncProcessor extends WorkerHost {
  constructor(private readonly maxChatAdminRosterSyncService: MaxChatAdminRosterSyncService) {
    super();
  }

  async process(job: Job<MaxChatAdminRosterSyncJob>) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    await this.maxChatAdminRosterSyncService.processJob(job.data);
  }
}
