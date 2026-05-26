import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const VK_PARSING_SYNC_QUEUE = 'vk-parsing-sync';
export const VK_PARSING_PUBLISH_QUEUE = 'vk-parsing-publish';

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
