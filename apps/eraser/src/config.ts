export type Config = {
  databaseUrl: string;
  redisUrl: string;
  controlToken: string;
  webhookSecret: string;
  botToken: string;
  botId: string;
  apiBaseUrl: string;
  port: number;
  enabled: boolean;
  maxRps: number;
  commitSha: string;
  webhookUrl: string | null;
};
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const enabled = env.ERASER_ENABLED === 'true';
  const required = (key: string) => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const controlToken = required('ERASER_CONTROL_TOKEN');
  if (controlToken.length < 32)
    throw new Error('ERASER_CONTROL_TOKEN must have at least 32 characters');
  const apiBaseUrl = env.MAX_API_BASE_URL ?? 'https://platform-api2.max.ru';
  const api = new URL(apiBaseUrl);
  if (
    api.username ||
    api.password ||
    api.search ||
    api.hash ||
    api.pathname !== '/' ||
    api.protocol !== 'https:' ||
    api.hostname !== 'platform-api2.max.ru'
  )
    throw new Error('Unsupported MAX_API_BASE_URL');
  const maxRps = Number(env.ERASER_MAX_RPS ?? '20');
  if (!Number.isInteger(maxRps) || maxRps < 1 || maxRps > 30)
    throw new Error('ERASER_MAX_RPS must be between 1 and 30');
  const botToken = env.ERASER_BOT_TOKEN ?? '',
    botId = env.ERASER_BOT_ID ?? '',
    webhookSecret = env.ERASER_WEBHOOK_SECRET ?? '';
  if (enabled && (!botToken || !/^\d+$/.test(botId) || webhookSecret.length < 32))
    throw new Error('Enabled eraser requires its exact bot identity and webhook secret');
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const webhookUrl = env.ERASER_WEBHOOK_URL ?? null;
  if (webhookUrl) {
    const url = new URL(webhookUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new Error('Webhook requires a clean HTTPS URL');
  }
  return {
    databaseUrl: required('ERASER_DATABASE_URL'),
    redisUrl: required('ERASER_REDIS_URL'),
    controlToken,
    webhookSecret,
    botToken,
    botId,
    apiBaseUrl,
    port,
    enabled,
    maxRps,
    commitSha: env.COMMIT_SHA ?? 'development',
    webhookUrl,
  };
}
