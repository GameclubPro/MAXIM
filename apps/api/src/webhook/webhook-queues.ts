export type ProcessWebhookJob = {
  webhookEventId: string;
};

export const LEGACY_WEBHOOK_QUEUE = 'moderation';
export const WEBHOOK_QUEUE_CRITICAL = 'moderation-critical';
export const WEBHOOK_QUEUE_DEFAULT = 'moderation-default';
export const WEBHOOK_QUEUE_BACKGROUND = 'moderation-background';

export const ACTIVE_WEBHOOK_QUEUE_NAMES = [
  WEBHOOK_QUEUE_CRITICAL,
  WEBHOOK_QUEUE_DEFAULT,
  WEBHOOK_QUEUE_BACKGROUND,
] as const;

export const ALL_WEBHOOK_QUEUE_NAMES = [
  LEGACY_WEBHOOK_QUEUE,
  ...ACTIVE_WEBHOOK_QUEUE_NAMES,
] as const;

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
      return WEBHOOK_QUEUE_DEFAULT;
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
