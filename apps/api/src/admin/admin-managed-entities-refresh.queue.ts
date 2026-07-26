import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const ADMIN_MANAGED_ENTITIES_REFRESH_QUEUE = 'admin-managed-entities-refresh';
export const ADMIN_MANAGED_ENTITIES_REFRESH_JOB_TTL_MS = 15 * 60_000;
export const ADMIN_MANAGED_ENTITIES_REFRESH_JITTER_MAX_MS = 5_000;

export function resolveAdminManagedEntitiesRefreshJitterMs(
  jobId: string,
  phase: 'enqueue' | 'defer',
): number {
  let hash = 2_166_136_261;
  for (const character of `${phase}:${jobId}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }

  return (hash >>> 0) % (ADMIN_MANAGED_ENTITIES_REFRESH_JITTER_MAX_MS + 1);
}

export type AdminManagedEntitiesRefreshJob = QueueJobEnvelope<
  {
    userId: string;
    entityType: 'chat' | 'channel' | 'all';
    bypassRemoteCache: boolean;
    resetRefreshCursor: boolean;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'managed-entities-refresh'>;
    createdAt?: string;
  }
>;
