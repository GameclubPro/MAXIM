export type ProcessWebhookJob = {
  webhookEventId: string;
};

export const LEGACY_WEBHOOK_QUEUE = 'moderation';
export const WEBHOOK_QUEUE_CRITICAL = 'moderation-critical';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_0 = 'moderation-default-0';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_1 = 'moderation-default-1';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_2 = 'moderation-default-2';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_3 = 'moderation-default-3';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_4 = 'moderation-default-4';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_5 = 'moderation-default-5';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_6 = 'moderation-default-6';
export const WEBHOOK_QUEUE_DEFAULT_SHARD_7 = 'moderation-default-7';
export const WEBHOOK_QUEUE_BACKGROUND = 'moderation-background';
export const DEFAULT_WEBHOOK_QUEUE_NAMES = [
  WEBHOOK_QUEUE_DEFAULT_SHARD_0,
  WEBHOOK_QUEUE_DEFAULT_SHARD_1,
  WEBHOOK_QUEUE_DEFAULT_SHARD_2,
  WEBHOOK_QUEUE_DEFAULT_SHARD_3,
  WEBHOOK_QUEUE_DEFAULT_SHARD_4,
  WEBHOOK_QUEUE_DEFAULT_SHARD_5,
  WEBHOOK_QUEUE_DEFAULT_SHARD_6,
  WEBHOOK_QUEUE_DEFAULT_SHARD_7,
] as const;

export const ACTIVE_WEBHOOK_QUEUE_NAMES = [
  WEBHOOK_QUEUE_CRITICAL,
  ...DEFAULT_WEBHOOK_QUEUE_NAMES,
  WEBHOOK_QUEUE_BACKGROUND,
] as const;

export const ALL_WEBHOOK_QUEUE_NAMES = [
  LEGACY_WEBHOOK_QUEUE,
  ...ACTIVE_WEBHOOK_QUEUE_NAMES,
] as const;

export type DefaultWebhookQueueName = (typeof DEFAULT_WEBHOOK_QUEUE_NAMES)[number];
export type ActiveWebhookQueueName = (typeof ACTIVE_WEBHOOK_QUEUE_NAMES)[number];
export type AnyWebhookQueueName = (typeof ALL_WEBHOOK_QUEUE_NAMES)[number];

export const WEBHOOK_JOB_PRIORITY = {
  callback: 1,
  membershipJoin: 2,
  message: 5,
  membershipLeave: 8,
  default: 6,
} as const;

export function resolveWebhookJobPriority(payload: unknown): number {
  switch (readWebhookType(payload)) {
    case 'message_callback':
      return WEBHOOK_JOB_PRIORITY.callback;
    case 'user_added':
    case 'bot_added':
    case 'bot_started':
      return WEBHOOK_JOB_PRIORITY.membershipJoin;
    case 'message_created':
      return WEBHOOK_JOB_PRIORITY.message;
    case 'user_removed':
    case 'bot_removed':
      return WEBHOOK_JOB_PRIORITY.membershipLeave;
    default:
      return WEBHOOK_JOB_PRIORITY.default;
  }
}

export function resolveWebhookQueueName(payload: unknown): ActiveWebhookQueueName {
  switch (readWebhookType(payload)) {
    case 'message_callback':
    case 'user_added':
    case 'bot_added':
    case 'bot_started':
      return WEBHOOK_QUEUE_CRITICAL;
    case 'user_removed':
    case 'bot_removed':
      return WEBHOOK_QUEUE_BACKGROUND;
    case 'message_created':
    default:
      return resolveDefaultWebhookQueueName(payload);
  }
}

function readWebhookType(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const rawType =
    (payload as { type?: unknown; update_type?: unknown }).type ??
    (payload as { update_type?: unknown }).update_type;
  return typeof rawType === 'string' ? rawType.trim().toLowerCase() : '';
}

function resolveDefaultWebhookQueueName(payload: unknown): DefaultWebhookQueueName {
  const chatId = readWebhookChatId(payload);
  if (!chatId) {
    return DEFAULT_WEBHOOK_QUEUE_NAMES[0];
  }

  return resolveDefaultWebhookQueueNameForChatId(chatId);
}

export function resolveDefaultWebhookQueueNameForChatId(chatId: string): DefaultWebhookQueueName {
  return DEFAULT_WEBHOOK_QUEUE_NAMES[resolveDefaultWebhookQueueIndexForChatId(chatId)]!;
}

export function resolveDefaultWebhookQueueIndexForChatId(chatId: string): number {
  return hashChatId(chatId) % DEFAULT_WEBHOOK_QUEUE_NAMES.length;
}

function readWebhookChatId(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  const row = payload as {
    message?: {
      chatId?: unknown;
    };
    chatId?: unknown;
  };
  const directCandidates = [row.message?.chatId, row.chatId];
  for (const value of directCandidates) {
    if (typeof value === 'string' || typeof value === 'number') {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  const record = payload as Record<string, unknown>;
  const nestedCandidates = [
    record.message,
    record.data,
    record.event,
    record.message_created,
    record.user_added,
    record.bot_added,
    record.user_removed,
    record.bot_removed,
    record.bot_started,
  ];

  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue;
    }

    const nestedChatId = readWebhookChatId(candidate);
    if (nestedChatId) {
      return nestedChatId;
    }
  }

  return '';
}

function hashChatId(chatId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < chatId.length; index += 1) {
    hash ^= chatId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}
