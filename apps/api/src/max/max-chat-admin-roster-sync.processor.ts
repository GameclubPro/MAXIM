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

const MEMBERSHIP_CHURN_PREWARM_MAX_AGE_MS = 2 * 60 * 1_000;

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

    if (
      job.data.source === 'webhook_membership_churn' &&
      typeof job.timestamp === 'number' &&
      job.timestamp + MEMBERSHIP_CHURN_PREWARM_MAX_AGE_MS < Date.now()
    ) {
      return;
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
