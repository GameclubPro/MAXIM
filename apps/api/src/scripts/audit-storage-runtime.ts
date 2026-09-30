import Redis from 'ioredis';
import { readStorageRuntimeFleet } from '../system/storage-runtime-metrics.service';

// FLAG: Read only fixed Redis metric keys in the existing admin container.
// Do not bootstrap Nest workers, fetch MAX, inspect queues, or query PostgreSQL.
async function main(): Promise<void> {
  if (process.env.APP_ROLE !== 'admin' || process.argv.length !== 2 || !process.env.REDIS_URL)
    throw new Error('invalid_runtime');
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 1_000,
    commandTimeout: 1_000,
  });
  redis.on('error', () => undefined);
  try {
    await redis.connect();
    const report = await readStorageRuntimeFleet(redis);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.available) process.exitCode = 1;
  } finally {
    redis.disconnect();
  }
}

void main().catch(() => {
  process.stdout.write(`${JSON.stringify({ available: false, collectionError: true })}\n`);
  process.exitCode = 1;
});
