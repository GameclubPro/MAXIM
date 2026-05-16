import { z } from 'zod';
import { botSpeechPersonaSchema } from '@maxim/contracts/bot-speech';
import { parseAdditionalMaxBotsJson } from '../max/max-bot-config.util';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';

const PRODUCTION_WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const DISALLOWED_PRODUCTION_WEBHOOK_SECRETS = new Set([
  'change-me',
  'changeme',
  'secret-path',
  'secret-header',
  'header-secret',
  'replace-me',
  'replace-with-random-url-safe-secret',
]);

const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function envBoolean(defaultValue: boolean) {
  return z
    .preprocess((value) => {
      if (typeof value !== 'string') {
        return value;
      }

      const normalized = value.trim().toLowerCase();
      if (!normalized) {
        return undefined;
      }
      if (BOOLEAN_TRUE_VALUES.has(normalized)) {
        return true;
      }
      if (BOOLEAN_FALSE_VALUES.has(normalized)) {
        return false;
      }

      return value;
    }, z.boolean().optional())
    .transform((value) => value ?? defaultValue);
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: z.string().url(),
  MAX_WEBHOOK_BASE_URL: z.string().url().optional(),

  MAX_BOT_ID: z.string().min(3),
  MAX_BOT_LABEL: z.string().min(1).max(64).optional(),
  MAX_BOT_CHARACTER_NAME: z.string().min(1).max(128).optional(),
  MAX_BOT_SPEECH_PERSONA: botSpeechPersonaSchema.optional(),
  MAX_BOT_CONTACT_ID: z.string().regex(/^\d+$/).optional(),
  MAX_ENTRY_BOT_ID: z.string().min(3).optional(),
  MAX_BOT_TOKEN: z.string().min(10),
  MAX_BOT_TOKEN_PREVIOUS: z.string().min(10).optional(),
  MAX_WEBHOOK_SECRET_PATH: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET_PREVIOUS: z.string().min(8).optional(),
  MAX_BOTS_JSON: z.string().optional(),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api.max.ru'),
  MAX_JOIN_DENY_CHAT_IDS: z.string().optional(),

  DATABASE_URL: z.string().min(10),
  REDIS_URL: z.string().url(),

  INIT_DATA_HMAC_SECRET: z.string().optional(),
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(3600),
  SYSTEM_ADMIN_USER_IDS: z.string().optional(),

  WEBHOOK_GLOBAL_RPS_LIMIT: z.coerce.number().int().positive().default(300),
  WEBHOOK_BURST_LIMIT: z.coerce.number().int().positive().default(450),
  ENQUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  ENQUEUE_BATCH_SIZE: z.coerce.number().int().positive().default(400),
  ENQUEUE_CONCURRENCY: z.coerce.number().int().positive().default(32),
  ENQUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(120),
  WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC: z.coerce.number().int().positive().default(90),
  WEBHOOK_ROUTING_QUEUE_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_MIN_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_SHARE: z.coerce
    .number()
    .min(0.5)
    .max(1)
    .default(0.7),
  WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_MIN: z.coerce.number().int().positive().default(4),
  MAX_WEBHOOK_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  MAX_WEBHOOK_STALE_INGRESS_MS: z.coerce.number().int().positive().default(300_000),
  MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS: z.coerce.number().int().positive().default(600_000),
  WEBHOOK_DYNAMIC_LEASES_MODE: z.enum(['off', 'shadow', 'canary', 'on']).default('off'),
  WEBHOOK_DYNAMIC_LEASES_WORKER_GROUP: z
    .enum([
      'api-moderation',
      'api-moderation-realtime-b',
      'api-moderation-realtime-c',
      'api-moderation-realtime-d',
    ])
    .optional(),
  WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS: z.string().optional(),
  WEBHOOK_DYNAMIC_LEASES_HEARTBEAT_MS: z.coerce.number().int().positive().default(3_000),
  WEBHOOK_DYNAMIC_LEASES_LEASE_TTL_MS: z.coerce.number().int().positive().default(12_000),
  WEBHOOK_DYNAMIC_LEASES_HANDOFF_TTL_MS: z.coerce.number().int().positive().default(12_000),
  WEBHOOK_DYNAMIC_LEASES_REBALANCE_COOLDOWN_MS: z.coerce.number().int().positive().default(30_000),
  WEBHOOK_DYNAMIC_LEASES_SUPPRESS_LAG_SEC: z.coerce.number().int().positive().default(10),
  WEBHOOK_DYNAMIC_LEASES_SUMMARY_TTL_MS: z.coerce.number().int().positive().default(20_000),
  QUEUE_LAG_DEGRADE_SEC: z.coerce.number().int().positive().default(10),
  READY_QUEUE_LAG_SUSTAIN_SEC: z.coerce.number().int().positive().default(20),
  READY_QUEUE_LAG_SEVERE_SEC: z.coerce.number().int().positive().default(30),
  READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS: z.coerce.number().int().positive().default(2_000),
  READINESS_BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(2_500),
  READINESS_DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
  READINESS_STALE_FALLBACK_MAX_AGE_MS: z.coerce.number().int().positive().default(30_000),
  DEGRADE_STABILIZE_SEC: z.coerce.number().int().positive().default(300),
  RAW_PAYLOAD_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.01),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  WEBHOOK_FAILED_RETENTION_HOURS: z.coerce.number().int().positive().default(24),
  MODERATION_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  MAX_API_GLOBAL_RPS: z.coerce.number().int().positive().default(30),
  MAX_API_GLOBAL_RPS_CRITICAL: z.coerce.number().int().positive().optional(),
  MAX_API_GLOBAL_RPS_INTERACTIVE: z.coerce.number().int().positive().optional(),
  MAX_API_GLOBAL_RPS_BACKGROUND: z.coerce.number().int().positive().optional(),
  MAX_API_CHAT_RPS: z.coerce.number().int().positive().default(5),
  MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: z.coerce.number().int().min(0).default(1_000),
  MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: z.coerce.number().int().min(0).default(1_500),
  MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: z.coerce.number().int().min(0).default(5_000),
  MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: z.coerce.number().int().positive().default(25),
  MAX_API_LIST_BOT_CHATS_CACHE_SEC: z.coerce.number().int().min(0).default(120),
  MAX_API_CHAT_SNAPSHOT_CACHE_SEC: z.coerce.number().int().min(0).default(300),
  MANAGED_ENTITY_HEADER_CACHE_SEC: z.coerce.number().int().positive().default(3600),
  MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: z.coerce.number().int().min(0).default(12),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL: z.coerce.number().int().positive().default(2_000),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE: z.coerce.number().int().positive().default(3_000),
  MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_BACKGROUND: z.coerce.number().int().positive().default(5_000),
  CHAT_ADMIN_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(2_000),
  CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN: envBoolean(false),
  SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
  WEBHOOK_USER_FACING_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_RESET_MS: z.coerce.number().int().positive().default(45_000),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_FAILURE_THRESHOLD: z.coerce
    .number()
    .int()
    .positive()
    .default(2),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_WINDOW_MS: z.coerce.number().int().positive().default(45_000),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_DURATION_SEC: z.coerce.number().int().positive().default(120),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_POSITIVE_TTL_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(90),
  MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(25),
  MAX_API_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_OPEN_SEC: z.coerce.number().int().positive().default(20),
  BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC: z.coerce.number().int().positive().default(60),
  BACKGROUND_GOVERNOR_CACHE_TTL_MS: z.coerce.number().int().positive().default(2_000),
  BACKGROUND_GOVERNOR_SOFT_QUEUE_LAG_SEC: z.coerce.number().positive().default(3),
  BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.3),
  BACKGROUND_GOVERNOR_WORKER_SKEW_PRESSURE: z.coerce.number().int().positive().default(4),
  BACKGROUND_GOVERNOR_WORKER_SKEW_SHARE: z.coerce.number().min(0.5).max(1).default(0.75),
  BACKGROUND_GOVERNOR_SLOW_RETRY_AFTER_MS: z.coerce.number().int().positive().default(45_000),
  BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  BACKGROUND_GOVERNOR_BOT_LOAD_SLOW_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.35),
  BACKGROUND_GOVERNOR_BOT_LOAD_PAUSE_THRESHOLD: z.coerce.number().min(0.05).max(1).default(0.7),
  SYSTEM_RUNTIME_DIAGNOSTICS_PROBLEM_CHAT_WINDOW_SEC: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  SYSTEM_WEBHOOK_SLO_WINDOW_SEC: z.coerce.number().int().positive().default(900),
  SYSTEM_WEBHOOK_SLO_TARGET_MS: z.coerce.number().int().positive().default(1000),
  SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT: z.coerce.number().int().positive().default(5000),
  MAX_ACTION_DISPATCH_ENABLED: envBoolean(true),
  APP_ROLE: z.enum(['all', 'ingress', 'admin', 'enqueue', 'moderation', 'action']).default('all'),
  APP_SERVICE_NAME: z.enum(RUNTIME_SERVICE_NAMES).optional(),
  BOT_OWNERSHIP_FOUNDATION_ENABLED: envBoolean(true),
  BOT_OWNERSHIP_REPAIR_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  BOT_OWNERSHIP_REPAIR_LOCK_TTL_MS: z.coerce.number().int().positive().default(60_000),
  BOT_OWNERSHIP_REPAIR_BATCH_SIZE: z.coerce.number().int().positive().default(250),
  MODERATION_ENABLED_QUEUES: z.string().optional(),
  MODERATION_BACKGROUND_TASKS_ENABLED: envBoolean(true),
  MODERATION_CONCURRENCY_LEGACY: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_CRITICAL: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_JOIN: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_0: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_1: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_2: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_3: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_4: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_5: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_6: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_7: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_8: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_9: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_10: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_11: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_12: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_13: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_14: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_15: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_BACKGROUND: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY: z.coerce.number().int().positive().default(8),
  REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY: z.coerce.number().int().positive().default(2),
  CHANNEL_AUTO_POST_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS: z.coerce.number().int().min(0).default(8),
  CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS: z.coerce.number().int().min(0).default(150),
  CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  CHANNEL_AUTO_POST_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  CHANNEL_AUTO_POST_STARTUP_JITTER_MS: z.coerce.number().int().min(0).default(15_000),
  CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN: z.coerce.number().int().positive().default(3),
  CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  MANUAL_GROUP_CLOSE_SCAN_MAX_MESSAGE_AGE_MS: z.coerce.number().int().positive().default(120_000),
  BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC: z.coerce.number().int().positive().default(5),
  BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE: z.coerce.number().int().positive().default(4),
  BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE: z.coerce.number().min(0.5).max(1).default(0.75),
  NIGHT_MODE_SCHEDULED_NOTICE_SPACING_MS: z.coerce.number().int().min(0).default(150),
  ACTION_CONCURRENCY: z.coerce.number().int().positive().default(8),
  CHANNEL_STATS_STARTUP_SYNC_ENABLED: envBoolean(false),
  CHANNEL_STATS_STARTUP_MAX_CHANNELS: z.coerce.number().int().min(0).default(6),
  CHANNEL_STATS_STARTUP_STALE_MS: z.coerce.number().int().positive().default(21_600_000),
  CHANNEL_STATS_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  CHANNEL_STATS_STARTUP_JITTER_MS: z.coerce.number().int().min(0).default(15_000),
  CHANNEL_STATS_STARTUP_MAX_PAGES: z.coerce.number().int().positive().default(20),
  MANUAL_FANOUT_LOOKUP_SPACING_MS: z.coerce.number().int().min(0).default(180),
  MANUAL_FANOUT_ACTION_SPACING_MS: z.coerce.number().int().min(0).default(120),
  JSON_BODY_LIMIT: z.coerce.number().int().positive().default(33_554_432),
});

export type EnvSchema = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvSchema {
  const parsed = envSchema.safeParse(config);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Environment validation failed: ${details}`);
  }

  if (parsed.data.NODE_ENV === 'production') {
    for (const [key, value] of [
      ['MAX_WEBHOOK_SECRET_PATH', parsed.data.MAX_WEBHOOK_SECRET_PATH],
      ['MAX_WEBHOOK_HEADER_SECRET', parsed.data.MAX_WEBHOOK_HEADER_SECRET],
      ['MAX_WEBHOOK_HEADER_SECRET_PREVIOUS', parsed.data.MAX_WEBHOOK_HEADER_SECRET_PREVIOUS],
    ] as const) {
      if (!value) {
        continue;
      }
      const normalized = value.trim();
      if (
        !PRODUCTION_WEBHOOK_SECRET_PATTERN.test(normalized) ||
        DISALLOWED_PRODUCTION_WEBHOOK_SECRETS.has(normalized.toLowerCase())
      ) {
        throw new Error(
          `Environment validation failed: ${key} must be a non-default URL-safe secret (16-128 chars, A-Z/a-z/0-9/_/-) in production`,
        );
      }
    }
  }

  try {
    const additionalBots = parseAdditionalMaxBotsJson(parsed.data.MAX_BOTS_JSON);
    const configuredBotIds = new Set<string>([
      parsed.data.MAX_BOT_ID.trim(),
      ...additionalBots.map((bot) => bot.id),
    ]);
    const normalizedEntryBotId =
      typeof parsed.data.MAX_ENTRY_BOT_ID === 'string' ? parsed.data.MAX_ENTRY_BOT_ID.trim() : '';

    if (normalizedEntryBotId) {
      if (!configuredBotIds.has(normalizedEntryBotId)) {
        throw new Error(
          `MAX_ENTRY_BOT_ID must match MAX_BOT_ID or one of MAX_BOTS_JSON ids (got "${normalizedEntryBotId}")`,
        );
      }

      const additionalEntryBot =
        additionalBots.find((bot) => bot.id === normalizedEntryBotId) ?? null;
      if (additionalEntryBot && additionalEntryBot.state !== 'active') {
        throw new Error(
          `MAX_ENTRY_BOT_ID must reference an active bot; got "${normalizedEntryBotId}" with state "${additionalEntryBot.state}"`,
        );
      }
    }

    if (parsed.data.NODE_ENV === 'production') {
      for (const bot of additionalBots) {
        for (const [key, value] of [
          [`MAX_BOTS_JSON.${bot.id}.webhookSecretPath`, bot.webhookSecretPath],
          [`MAX_BOTS_JSON.${bot.id}.webhookHeaderSecret`, bot.webhookHeaderSecret],
          [`MAX_BOTS_JSON.${bot.id}.webhookHeaderSecretPrevious`, bot.webhookHeaderSecretPrevious],
        ] as const) {
          if (!value) {
            continue;
          }

          const normalized = value.trim();
          if (
            !PRODUCTION_WEBHOOK_SECRET_PATTERN.test(normalized) ||
            DISALLOWED_PRODUCTION_WEBHOOK_SECRETS.has(normalized.toLowerCase())
          ) {
            throw new Error(
              `Environment validation failed: ${key} must be a non-default URL-safe secret (16-128 chars, A-Z/a-z/0-9/_/-) in production`,
            );
          }
        }
      }
    }
  } catch (error: unknown) {
    throw new Error(
      `Environment validation failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parsed.data;
}
