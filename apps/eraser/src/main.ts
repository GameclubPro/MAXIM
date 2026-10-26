import pg from 'pg';
import { Redis } from 'ioredis';
import { config } from './config.js';
import { Store } from './store.js';
import { HttpLimiter } from './limiter.js';
import { MaxClient } from './max.js';
import { CleanupRuntime } from './runtime.js';
import { createHttpServer } from './http.js';

const settings = config();
const pool = new pg.Pool({
  connectionString: settings.databaseUrl,
  max: 4,
  connectionTimeoutMillis: 2000,
  application_name: 'lastik',
  options: '-c timezone=UTC -c statement_timeout=5000 -c lock_timeout=2000',
});
const redis = new Redis(settings.redisUrl, { maxRetriesPerRequest: 1 });
redis.on('error', () => {});
const store = new Store(pool, settings.enabled);
const max = new MaxClient(settings, new HttpLimiter(redis, settings.maxRps));
const runtime = new CleanupRuntime(store, max, settings);
const server = createHttpServer(store, max, runtime, settings, () => redis.ping());
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close();
    await redis.quit();
    await pool.end();
    clearTimeout(deadline);
  } catch {
    process.exitCode = 1;
  }
}
process.on('SIGTERM', () => {
  void close();
});
process.on('SIGINT', () => {
  void close();
});
await pool.query('SELECT 1 FROM eraser_migrations LIMIT 1');
await redis.ping();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(settings.port, '0.0.0.0', resolve);
});
try {
  if (settings.enabled) await max.subscribe();
  await runtime.start();
} catch {
  await close();
  process.exitCode = 1;
  throw new Error('Eraser startup prerequisites unavailable');
}
process.stdout.write(
  JSON.stringify({
    service: 'eraser',
    event: 'started',
    commitSha: settings.commitSha,
    enabled: settings.enabled,
  }) + '\n',
);
