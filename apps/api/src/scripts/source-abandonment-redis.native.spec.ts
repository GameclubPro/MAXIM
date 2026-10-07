import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { inventorySourceAbandonmentNamespaces } from './source-abandonment-redis-catalog';
import { inventorySourceAbandonmentRedis } from './source-abandonment-live-redis';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';

const url = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = url ? describe : describe.skip;
jest.setTimeout(60_000);

// FLAG: Only this fixture's initially empty localhost Redis DB may be mutated.
// Production readers receive EVAL_RO and read-only cost transactions, no Queue/Worker.
native('modern full namespace census on Redis 7', () => {
  let redis: Redis;
  let fixtureUrl: string;
  let ownsDatabase = false;
  const queues: Queue[] = [];
  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Disposable localhost Redis required');
    target.pathname = '/12';
    fixtureUrl = target.toString();
    redis = new Redis(fixtureUrl, { maxRetriesPerRequest: 0, commandTimeout: 10_000 });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Native catalog DB is already occupied');
    ownsDatabase = true;
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    if (ownsDatabase) await redis.flushdb();
  });
  afterAll(() => redis?.disconnect());

  const reader = () => ({
    multi: () => redis.multi(),
    eval_ro: jest.fn((script: string, keys: number, ...args: string[]) =>
      redis.eval_ro(script, keys, ...args),
    ),
  });
  const deadline = () => Date.now() + 30_000;
  const selection = {
    protocol: 'source-abandonment-v1' as const,
    abandonBefore: '2026-10-07T00:00:00.000Z',
    ownerWebhookEventIds: ['selected-owner'],
    majorBotIds: ['major-1'],
  };
  const source = { chatId: 'chat-a', messageId: 'message-a', userId: 'user-a' };
  const resolve = async () => ({
    row: null,
    digest: 'f'.repeat(64),
    plans: [],
    cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
  });

  it('stops a paired scan on its first zero cursor and counts only that underlying page', async () => {
    expect(await inventorySourceAbandonmentNamespaces(reader(), deadline())).toMatchObject({
      complete: true,
      issue: null,
      cost: { pages: 1, scanCountHints: 4096, matchedKeys: 0 },
    });
    expect(await redis.dbsize()).toBe(0);
  });

  it('scans a sparse keyspace completely twice while retaining terminal history', async () => {
    for (let offset = 0; offset < 120_000; offset += 2000) {
      const pipeline = redis.pipeline();
      for (let i = offset; i < offset + 2000; i++)
        pipeline.set(
          i < 15_000 ? `bull:photo-duplicates:retained-${i}` : `cache:unrelated:${i}`,
          'kept',
        );
      await pipeline.exec();
    }
    // The terminal hash contains a large payload; the namespace reader must never fetch it.
    await redis.hset('bull:photo-duplicates:retained-hash', 'data', 'x'.repeat(128 * 1024));
    const before = await redis.dbsize();
    const first = await inventorySourceAbandonmentNamespaces(reader(), deadline());
    const second = await inventorySourceAbandonmentNamespaces(reader(), deadline());
    expect(first).toMatchObject({
      complete: true,
      issue: null,
      namespaceKeyCounts: { 'photo-duplicates': 15_001 },
    });
    expect(second.namespaceKeyCounts).toEqual(first.namespaceKeyCounts);
    expect(second.complete).toBe(true);
    expect(first.cost.pages).toBeGreaterThan(1);
    expect(first.cost.serverDurationUs).toBeGreaterThan(0);
    expect(first.cost.maxCallDurationUs).toBeGreaterThan(0);
    expect(first.cost.bytes).toBeLessThan(16 * 1024);
    expect(await redis.dbsize()).toBe(before);
    expect(await redis.hstrlen('bull:photo-duplicates:retained-hash', 'data')).toBe(128 * 1024);
  });

  it.each(['wait', 'orphan-job', 'stalled-check'])(
    'rejects unknown namespace without meta: %s',
    async (suffix) => {
      const key = `bull:retired-unknown:${suffix}`;
      if (suffix === 'wait') await redis.rpush(key, 'private-job-id');
      else if (suffix === 'orphan-job') await redis.hset(key, 'data', 'private-payload');
      else await redis.set(key, '1');
      const result = await inventorySourceAbandonmentNamespaces(reader(), deadline());
      expect(result).toMatchObject({ complete: false, issue: 'UNKNOWN_QUEUE_NAMESPACE' });
      expect(JSON.stringify(result)).not.toMatch(/private-job-id|private-payload|orphan-job/);
      expect(await redis.exists(key)).toBe(1);
    },
  );

  it('keeps generation, exact owner, action attribution and independent second-read proofs', async () => {
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set('maxim:webhook-rollout:pause-owner:v1', 'rollout:catalog-native-fence');
    await pipeline.exec();
    const ownerQueue = new Queue('moderation-default-0', { connection: { url: fixtureUrl } });
    const actionQueue = new Queue('max-actions-background', { connection: { url: fixtureUrl } });
    queues.push(ownerQueue, actionQueue);
    await ownerQueue.add(
      'webhook',
      { webhookEventId: 'selected-owner' },
      { jobId: 'selected-owner' },
    );
    await actionQueue.add(
      'action',
      { ...source, actionType: 'DELETE_MESSAGE', idempotencyKey: 'action-a' },
      { jobId: 'child-a', delay: 60_000 },
    );
    const observe = () =>
      inventorySourceAbandonmentRedis(
        reader(),
        selection,
        [source],
        {
          ...LEGACY_RECOVERY_LIVE_BUDGET,
          deadlineAtMs: deadline(),
        },
        resolve,
        'catalog-native-fence',
      );
    const first = await observe();
    const second = await observe();
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(first.catalog?.complete).toBe(true);
    expect(first.children).toMatchObject([{ jobKey: 'action-a', ...source }]);
    expect(second.stableDigest).toBe(first.stableDigest);
    const score = await redis.zscore('bull:max-actions-background:delayed', 'child-a');
    await redis.zadd('bull:max-actions-background:delayed', Number(score) + 4096, 'child-a');
    const changed = await observe();
    expect(changed.issues).toEqual([]);
    expect(changed.catalog?.namespaceKeyCounts).toEqual(first.catalog?.namespaceKeyCounts);
    expect(changed.stableDigest).not.toBe(first.stableDigest);
    await redis.incr('bull:max-actions-background:id');
    expect((await observe()).stableDigest).not.toBe(changed.stableDigest);
  });
});
