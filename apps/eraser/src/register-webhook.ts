import { Redis } from 'ioredis';
import { config } from './config.js';
import { HttpLimiter } from './limiter.js';
import { MaxClient } from './max.js';

const settings = config();
if (
  !settings.webhookUrl ||
  !settings.botToken ||
  !settings.botId ||
  settings.webhookSecret.length < 32
)
  throw new Error('Webhook registration requires the configured bot, secret and HTTPS URL');
const redis = new Redis(settings.redisUrl, { maxRetriesPerRequest: 1 });
redis.on('error', () => {});
try {
  const client = new MaxClient(settings, new HttpLimiter(redis, settings.maxRps));
  await client.subscribe();
  process.stdout.write('Eraser webhook registration confirmed.\n');
} finally {
  await redis.quit();
}
