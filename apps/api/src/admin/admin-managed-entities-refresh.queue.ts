import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE = 'admin-managed-entities-refresh';

export type AdminManagedEntitiesRefreshJob = QueueJobEnvelope<
  {
    userId: string;
    entityType: 'chat' | 'channel' | 'all';
    bypassRemoteCache: boolean;
    resetRefreshCursor: boolean;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'managed-entities-refresh'>;
  }
>;
