import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  APP_BASE_URL: z.string().url(),

  MAX_BOT_ID: z.string().min(3),
  MAX_BOT_TOKEN: z.string().min(10),
  MAX_WEBHOOK_SECRET_PATH: z.string().min(8),
  MAX_WEBHOOK_HEADER_SECRET: z.string().min(8),
  MAX_API_BASE_URL: z.string().url().default('https://platform-api.max.ru'),

  DATABASE_URL: z.string().min(10),
  REDIS_URL: z.string().url(),

  INIT_DATA_HMAC_SECRET: z.string().optional(),

  WEBHOOK_RPS_LIMIT: z.coerce.number().int().positive().default(30),
  JSON_BODY_LIMIT: z.coerce.number().int().positive().default(1_048_576),
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

  return parsed.data;
}
