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
  MAX_API_BASE_URL: z.string().url().default('https://platform-api.max.ru'),
  MAX_JOIN_DENY_CHAT_IDS: z.string().optional(),

  DATABASE_URL: z.string().min(10),
  REDIS_URL: z.string().url(),

  INIT_DATA_HMAC_SECRET: z.string().optional(),

  WEBHOOK_RPS_LIMIT: z.coerce.number().int().positive().default(30),
  WEBHOOK_GLOBAL_RPS_LIMIT: z.coerce.number().int().positive().default(300),
  WEBHOOK_BURST_LIMIT: z.coerce.number().int().positive().default(450),
  ENQUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(500),
  ENQUEUE_BATCH_SIZE: z.coerce.number().int().positive().default(200),
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
  MAX_API_CHAT_RPS: z.coerce.number().int().positive().default(10),
  MAX_API_LIST_BOT_CHATS_CACHE_SEC: z.coerce.number().int().min(0).default(15),
  MAX_API_CHAT_SNAPSHOT_CACHE_SEC: z.coerce.number().int().min(0).default(10),
  MAX_API_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_WINDOW_SEC: z.coerce.number().int().positive().default(30),
  MAX_API_CIRCUIT_OPEN_SEC: z.coerce.number().int().positive().default(20),
  MAX_ACTION_DISPATCH_ENABLED: z.coerce.boolean().default(true),
  APP_ROLE: z.enum(['all', 'ingress', 'enqueue', 'moderation', 'action']).default('all'),
  MODERATION_CONCURRENCY_LEGACY: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_CRITICAL: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_DEFAULT: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY_BACKGROUND: z.coerce.number().int().positive().optional(),
  MODERATION_CONCURRENCY: z.coerce.number().int().positive().default(24),
  ACTION_CONCURRENCY: z.coerce.number().int().positive().default(24),
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
    ] as const) {
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
