import { z } from 'zod';

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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: z.string().url(),

  MAX_BOT_ID: z.string().min(3),
  MAX_BOT_CONTACT_ID: z.string().regex(/^\d+$/).optional(),
  MAX_BOT_TOKEN: z.string().min(10),
  MAX_BOT_TOKEN_PREVIOUS: z.string().min(10).optional(),
  MAX_WEBHOOK_SECRET_PATH: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET_PREVIOUS: z.string().min(8).optional(),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api.max.ru'),
  MAX_JOIN_DENY_CHAT_IDS: z.string().optional(),

  DATABASE_URL: z.string().min(10),
  REDIS_URL: z.string().url(),

  INIT_DATA_HMAC_SECRET: z.string().optional(),
  INIT_DATA_MAX_AGE_SEC: z.coerce.number().int().positive().default(300),
  SYSTEM_ADMIN_USER_IDS: z.string().optional(),

  WEBHOOK_GLOBAL_RPS_LIMIT: z.coerce.number().int().positive().default(300),
  WEBHOOK_BURST_LIMIT: z.coerce.number().int().positive().default(450),
  ENQUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(200),
  ENQUEUE_BATCH_SIZE: z.coerce.number().int().positive().default(400),
  ENQUEUE_CONCURRENCY: z.coerce.number().int().positive().default(32),
  ENQUEUE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(120),
  QUEUE_LAG_DEGRADE_SEC: z.coerce.number().int().positive().default(10),
  DEGRADE_STABILIZE_SEC: z.coerce.number().int().positive().default(300),
  RAW_PAYLOAD_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.01),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
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
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
  MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_RESET_MS: z.coerce.number().int().positive().default(45_000),
  MAX_API_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_OPEN_SEC: z.coerce.number().int().positive().default(20),
  MAX_ACTION_DISPATCH_ENABLED: z.coerce.boolean().default(true),
  APP_ROLE: z.enum(['all', 'ingress', 'admin', 'enqueue', 'moderation', 'action']).default('all'),
  MODERATION_ENABLED_QUEUES: z.string().optional(),
  MODERATION_BACKGROUND_TASKS_ENABLED: z.coerce.boolean().default(true),
  MODERATION_CONCURRENCY_LEGACY: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_CRITICAL: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_0: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_1: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_2: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT_SHARD_3: z.coerce.number().int().positive().optional(),
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
  NIGHT_MODE_SCHEDULED_NOTICE_SPACING_MS: z.coerce.number().int().min(0).default(150),
  ACTION_CONCURRENCY: z.coerce.number().int().positive().default(8),
  CHANNEL_STATS_STARTUP_SYNC_ENABLED: z.coerce.boolean().default(false),
  CHANNEL_STATS_STARTUP_MAX_CHANNELS: z.coerce.number().int().min(0).default(6),
  CHANNEL_STATS_STARTUP_STALE_MS: z.coerce.number().int().positive().default(21_600_000),
  CHANNEL_STATS_STARTUP_DELAY_MS: z.coerce.number().int().min(0).default(30_000),
  CHANNEL_STATS_STARTUP_JITTER_MS: z.coerce.number().int().min(0).default(15_000),
  CHANNEL_STATS_STARTUP_MAX_PAGES: z.coerce.number().int().positive().default(20),
  MANUAL_FANOUT_LOOKUP_SPACING_MS: z.coerce.number().int().min(0).default(180),
  MANUAL_FANOUT_ACTION_SPACING_MS: z.coerce.number().int().min(0).default(120),
  JSON_BODY_LIMIT: z.coerce.number().int().positive().default(6_291_456),
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

  return parsed.data;
}
