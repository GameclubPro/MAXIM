import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
  type JoinWebhookQueueName,
  type AnyWebhookQueueName,
  type DefaultWebhookQueueName,
} from '../webhook/webhook-queues';
import {
  ALL_MODERATION_QUEUE_NAMES,
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES,
  WEBHOOK_DYNAMIC_LEASES_MODES,
  normalizeDefaultWorkerGroupName,
  resolveRuntimeServiceProfile,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from './runtime-topology';

export type ModerationQueueAlias = 'legacy' | 'critical' | 'join' | 'default' | 'background';
export {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from './runtime-topology';

const MODERATION_QUEUE_NAME_BY_ALIAS: Record<ModerationQueueAlias, readonly AnyWebhookQueueName[]> =
  {
    legacy: [LEGACY_WEBHOOK_QUEUE],
    critical: [WEBHOOK_QUEUE_CRITICAL],
    join: JOIN_WEBHOOK_QUEUE_NAMES,
    default: DEFAULT_WEBHOOK_QUEUE_NAMES,
    background: [WEBHOOK_QUEUE_BACKGROUND],
  };

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

function readPositiveInt(rawValue: unknown, fallback: number): number {
  const parsed =
    typeof rawValue === 'number'
      ? rawValue
      : typeof rawValue === 'string' && rawValue.trim().length > 0
        ? Number(rawValue)
        : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function resolveModerationConcurrencySplit(total: number): {
  critical: number;
  join: number;
  default: number;
  background: number;
} {
  if (total <= 4) {
    return {
      critical: 1,
      join: 1,
      default: 1,
      background: 1,
    };
  }

  const background = total >= 8 ? 2 : 1;
  const join = total >= 8 ? 2 : 1;
  const critical = Math.max(1, Math.ceil(total * 0.25));
  const defaultQueue = Math.max(1, total - critical - join - background);

  return {
    critical,
    join,
    default: defaultQueue,
    background,
  };
}

function resolveShardConcurrencyDistribution(total: number, shardCount: number): number[] {
  if (shardCount <= 1) {
    return [Math.max(1, total)];
  }

  const sanitizedTotal = Math.max(shardCount, total);
  const baseConcurrency = Math.max(1, Math.floor(sanitizedTotal / shardCount));
  const remainder = sanitizedTotal % shardCount;

  return Array.from(
    { length: shardCount },
    (_, index) => baseConcurrency + (index < remainder ? 1 : 0),
  );
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
    const runtimeService = resolveRuntimeServiceProfile();
    if (runtimeService.source === 'declared-service') {
      return new Set(runtimeService.service.moderationQueues);
    }
    return new Set(ALL_MODERATION_QUEUE_NAMES);
  }

  const enabledQueues = new Set(rawValue.split(',').flatMap((token) => normalizeQueueToken(token)));

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

export function getDefaultWebhookHomeOwnerByQueue(): Readonly<
  Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName>
> {
  return Object.fromEntries(
    DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.flatMap((groupName) =>
      DEFAULT_WEBHOOK_WORKER_GROUP_QUEUES[groupName].map((queueName) => [queueName, groupName]),
    ),
  ) as Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName>;
}

export function getWebhookDynamicLeasesMode(
  rawValue: unknown = process.env.WEBHOOK_DYNAMIC_LEASES_MODE,
): WebhookDynamicLeasesMode {
  if (typeof rawValue === 'string') {
    const normalized = rawValue.trim().toLowerCase();
    if (WEBHOOK_DYNAMIC_LEASES_MODES.includes(normalized as WebhookDynamicLeasesMode)) {
      return normalized as WebhookDynamicLeasesMode;
    }
  }

  const runtimeService = resolveRuntimeServiceProfile();
  return runtimeService.source === 'declared-service'
    ? runtimeService.service.dynamicLeasesMode
    : 'off';
}

export function getWebhookDynamicLeasesWorkerGroup(
  rawValue: unknown = process.env.WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP,
): DefaultWebhookWorkerGroupName | null {
  const runtimeService = resolveRuntimeServiceProfile();
  return (
    normalizeDefaultWorkerGroupName(rawValue) ??
    (runtimeService.source === 'declared-service'
      ? runtimeService.service.dynamicLeasesWorkerGroup
      : null)
  );
}

export function getWebhookDynamicLeaseCanaryQueues(
  rawValue: unknown = process.env.WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS,
): Set<DefaultWebhookQueueName> {
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
    const runtimeService = resolveRuntimeServiceProfile();
    return new Set(
      runtimeService.source === 'declared-service' ? runtimeService.service.canaryShardIds : [],
    );
  }

  const queues = new Set<DefaultWebhookQueueName>();
  for (const rawToken of rawValue.split(',')) {
    const normalized = rawToken.trim().toLowerCase();
    if (!normalized) {
      continue;
    }

    if ((DEFAULT_WEBHOOK_QUEUE_NAMES as readonly string[]).includes(normalized)) {
      queues.add(normalized as DefaultWebhookQueueName);
      continue;
    }

    const shardIndex = Number(normalized);
    if (
      Number.isInteger(shardIndex) &&
      shardIndex >= 0 &&
      shardIndex < DEFAULT_WEBHOOK_QUEUE_NAMES.length
    ) {
      queues.add(DEFAULT_WEBHOOK_QUEUE_NAMES[shardIndex]!);
    }
  }

  return queues;
}

export function getDefaultWebhookShardConcurrencies(
  env: Record<string, unknown> = process.env,
): Record<DefaultWebhookQueueName, number> {
  const concurrencySplit = resolveModerationConcurrencySplit(
    readPositiveInt(env.MODERATION_CONCURRENCY, 24),
  );
  const defaultConcurrency = readPositiveInt(
    env.MODERATION_CONCURRENCY_DEFAULT,
    concurrencySplit.default,
  );
  const defaults = resolveShardConcurrencyDistribution(
    defaultConcurrency,
    DEFAULT_WEBHOOK_QUEUE_NAMES.length,
  );

  return Object.fromEntries(
    DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
      queueName,
      readPositiveInt(env[`MODERATION_CONCURRENCY_DEFAULT_SHARD_${index}`], defaults[index] ?? 1),
    ]),
  ) as Record<DefaultWebhookQueueName, number>;
}

export function getJoinWebhookShardConcurrencies(
  env: Record<string, unknown> = process.env,
): Record<JoinWebhookQueueName, number> {
  const concurrencySplit = resolveModerationConcurrencySplit(
    readPositiveInt(env.MODERATION_CONCURRENCY, 24),
  );
  const joinConcurrency = readPositiveInt(env.MODERATION_CONCURRENCY_JOIN, concurrencySplit.join);
  const distribution = resolveShardConcurrencyDistribution(
    joinConcurrency,
    JOIN_WEBHOOK_QUEUE_NAMES.length,
  );

  return Object.fromEntries(
    JOIN_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [queueName, distribution[index] ?? 1]),
  ) as Record<JoinWebhookQueueName, number>;
}
