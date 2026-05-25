import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const VK_PARSING_SYNC_QUEUE = 'vk-parsing-sync';

export type VkParsingSyncReason = 'source-added' | 'manual' | 'scheduled' | 'startup';

export type VkParsingSyncJob = QueueJobEnvelope<
  {
    sourceId: string;
    reason: VkParsingSyncReason;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'vk-parsing-sync'>;
    createdAt?: string;
  }
>;
