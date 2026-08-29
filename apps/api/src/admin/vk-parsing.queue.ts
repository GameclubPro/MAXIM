import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const VK_PARSING_SYNC_QUEUE = 'vk-parsing-sync';
export const VK_PARSING_PUBLISHER_QUEUE = 'vk-parsing-publisher';

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
export type VkParsingPublishReason = 'autopublish' | 'manual-retry' | 'manual-schedule';

export type VkParsingSyncJob = QueueJobEnvelope<
  {
    sourceId: string;
    reason: VkParsingSyncReason;
    ownerProfile: 'PUBLISHER';
    ownerBotId: string;
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

export type VkParsingPublisherJob = QueueJobEnvelope<
  {
    kind: 'publish' | 'rollback-delete';
    postId: string;
    chatId: string;
    requiredBotId: string;
    dispatchProfile?: 'PUBLIK_V1';
    reason?: VkParsingPublishReason;
    messageId?: string;
  },
  {
    idempotencyKey: string;
    retryPolicyName?: Extract<QueueRetryPolicyName, 'vk-parsing-publish'>;
    createdAt?: string;
  }
>;

export type VkParsingPublisherPublishJob = VkParsingPublisherJob & {
  kind: 'publish';
  dispatchProfile: 'PUBLIK_V1';
  reason: VkParsingPublishReason;
  requiredBotId: string;
};

export type VkParsingPublisherRollbackJob = VkParsingPublisherJob & {
  kind: 'rollback-delete';
  messageId: string;
};
