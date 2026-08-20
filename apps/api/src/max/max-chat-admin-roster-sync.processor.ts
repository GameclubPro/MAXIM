import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  isManagedEntityAccessLossCleanupJob,
  MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE,
  type MaxChatAdminRosterQueueJob,
} from './max-chat-admin-roster-sync.queue';
import { ManagedEntityAccessLossService } from './managed-entity-access-loss.service';
import {
  MaxChatAdminRosterSyncService,
  MaxChatAdminRosterSyncSourceBackoffError,
} from './max-chat-admin-roster-sync.service';

@Processor(MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE, {
  concurrency: 1,
})
export class MaxChatAdminRosterSyncProcessor extends WorkerHost {
  constructor(
    private readonly maxChatAdminRosterSyncService: MaxChatAdminRosterSyncService,
    private readonly managedEntityAccessLossService: ManagedEntityAccessLossService,
  ) {
    super();
  }

  async process(job: Job<MaxChatAdminRosterQueueJob>, token?: string) {
    if (!roleRunsAction(getAppRole())) {
      return;
    }

    if (isManagedEntityAccessLossCleanupJob(job.data)) {
      return this.managedEntityAccessLossService.processDeferredRuntimeCleanup(job.data);
    }

    try {
      await this.maxChatAdminRosterSyncService.processJob(job.data);
    } catch (error: unknown) {
      if (error instanceof MaxChatAdminRosterSyncSourceBackoffError) {
        await job.moveToDelayed(Date.now() + error.delayMs, token);
        throw new DelayedError();
      }

      throw error;
    }
  }
}
