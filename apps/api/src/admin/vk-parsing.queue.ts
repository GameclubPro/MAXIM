import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const VK_PARSING_SYNC_QUEUE = 'vk-parsing-sync';
export const VK_PARSING_PUBLISH_QUEUE = 'vk-parsing-publish';

export const VK_PARSING_SYNC_RETRY_POLICY = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: true,
  removeOnFail: 500,
};

export const VK_PARSING_PUBLISH_RETRY_POLICY = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: 1_000,
};

export type VkParsingSyncReason = 'source-added' | 'manual' | 'scheduled' | 'startup';
export type VkParsingPublishReason = 'autopublish' | 'manual-retry';

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

export type VkParsingPublishJob = QueueJobEnvelope<
  {
    postId: string;
    chatId: string;
    reason: VkParsingPublishReason;
  },
  {
    idempotencyKey: string;
    retryPolicyName?: Extract<QueueRetryPolicyName, 'vk-parsing-publish'>;
    createdAt?: string;
  }
>;
