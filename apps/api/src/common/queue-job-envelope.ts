export type QueueRetryPolicyName =
  | 'webhook-ingress'
  | 'webhook-repair'
  | 'max-action'
  | 'manual-fanout'
  | 'managed-entities-refresh'
  | 'suggestion-delivery'
  | 'chat-admin-roster-sync'
  | 'vk-parsing-sync';

export type QueueJobMetadata = {
  idempotencyKey?: string;
  sourceTag?: string;
  retryPolicyName?: QueueRetryPolicyName;
  createdAt?: string;
};

export type QueueJobEnvelope<
  TPayload extends object,
  TMetadata extends QueueJobMetadata = QueueJobMetadata,
> = Readonly<TPayload & TMetadata>;
