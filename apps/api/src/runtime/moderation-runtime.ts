import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  type AnyWebhookQueueName,
  type DefaultWebhookQueueName,
} from '../webhook/webhook-queues';

export type ModerationQueueAlias = 'legacy' | 'critical' | 'default' | 'background';
export type DefaultWebhookWorkerGroupName =
  | 'api-moderation'
  | 'api-moderation-realtime-b'
  | 'api-moderation-realtime-c'
  | 'api-moderation-realtime-d';

const ALL_MODERATION_QUEUE_NAMES: AnyWebhookQueueName[] = [
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_CRITICAL,
  ...DEFAULT_WEBHOOK_QUEUE_NAMES,
  WEBHOOK_QUEUE_BACKGROUND,
];

const MODERATION_QUEUE_NAME_BY_ALIAS: Record<ModerationQueueAlias, readonly AnyWebhookQueueName[]> = {
  legacy: [LEGACY_WEBHOOK_QUEUE],
  critical: [WEBHOOK_QUEUE_CRITICAL],
  default: DEFAULT_WEBHOOK_QUEUE_NAMES,
  background: [WEBHOOK_QUEUE_BACKGROUND],
};

export const DEFAULT_WEBHOOK_WORKER_GROUP_NAMES = Object.freeze(
  [
    'api-moderation',
    'api-moderation-realtime-b',
    'api-moderation-realtime-c',
    'api-moderation-realtime-d',
  ] as const satisfies readonly DefaultWebhookWorkerGroupName[],
);
const DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES = Object.freeze(
  Object.fromEntries(
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName, groupIndex) => [
      groupName,
      DEFAULT_WEBHOOK_QUEUE_NAMES.filter(
        (_, shardIndex) => shardIndex % DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.length === groupIndex,
      ),
    ]),
  ) as unknown as Record<DefaultWebhookWorkerGroupName, readonly DefaultWebhookQueueName[]>,
);

const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function normalizeBooleanEnv(rawValue: unknown, fallback: boolean): boolean {
  if (typeof rawValue === 'boolean') {
    return rawValue;
  }

  if (typeof rawValue !== 'string') {
    return fallback;
  }

  const normalized = rawValue.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (BOOLEAN_TRUE_VALUES.has(normalized)) {
    return true;
  }
  if (BOOLEAN_FALSE_VALUES.has(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeQueueToken(rawToken: string): AnyWebhookQueueName[] {
  const normalized = rawToken.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  if ((ALL_MODERATION_QUEUE_NAMES as readonly string[]).includes(normalized)) {
    return [normalized as AnyWebhookQueueName];
  }

  if (normalized in MODERATION_QUEUE_NAME_BY_ALIAS) {
    return [...MODERATION_QUEUE_NAME_BY_ALIAS[normalized as ModerationQueueAlias]];
  }

  return [];
}

export function getEnabledModerationProcessorQueues(
  rawValue = process.env.MODERATION_ENABLED_QUEUES,
): Set<AnyWebhookQueueName> {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    return new Set(ALL_MODERATION_QUEUE_NAMES);
  }

  const enabledQueues = new Set(
    rawValue
      .split(',')
      .flatMap((token) => normalizeQueueToken(token)),
  );

  return enabledQueues.size > 0 ? enabledQueues : new Set(ALL_MODERATION_QUEUE_NAMES);
}

export function moderationProcessorQueueEnabled(
  queueName: AnyWebhookQueueName,
  rawValue = process.env.MODERATION_ENABLED_QUEUES,
): boolean {
  return getEnabledModerationProcessorQueues(rawValue).has(queueName);
}

export function moderationBackgroundTasksEnabled(
  rawValue: unknown = process.env.MODERATION_BACKGROUND_TASKS_ENABLED,
): boolean {
  return normalizeBooleanEnv(rawValue, true);
}

export function getDefaultWebhookWorkerGroupQueues(): Readonly<
  Record<DefaultWebhookWorkerGroupName, readonly DefaultWebhookQueueName[]>
> {
  return DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES;
}
