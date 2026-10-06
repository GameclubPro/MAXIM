import { Queue } from 'bullmq';
import Redis from 'ioredis';
import {
  inventoryLegacyRecoveryLiveRedis,
  type LegacyRecoveryLiveRedis,
  type LegacyRecoveryLiveRedisAllowance,
} from './legacy-recovery-live-redis';
import type { LegacyRecoveryLiveRequest } from './legacy-recovery-live-protocol';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';

const url = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = url ? describe : describe.skip;
jest.setTimeout(60_000);

// FLAG: Only an empty localhost disposable Redis DB is owned by this fixture.
// Fixture setup may mutate it; the adapter under test only receives EVAL_RO.
native('Redis 7 / BullMQ native live inventory', () => {
  let redis: Redis;
  let fixtureUrl: string;
  let ownsDatabase = false;
  const queues: Queue[] = [];
  const request: LegacyRecoveryLiveRequest = {
    version: 1,
    operation: 'inventory_preview',
    binding: {
      maintenanceId: '11111111-1111-1111-1111-111111111111',
      queueFenceNonce: 'native-fence-nonce-0123456789',
      transitionJournalSha256: 'a'.repeat(64),
      sourceSha: 'b'.repeat(40),
      imageId: `sha256:${'c'.repeat(64)}`,
      stoppedGenerations: [],
    },
    selection: { ownerWebhookEventIds: ['selected-owner'], majorBotIds: ['major-1'] },
  };
  const sources = [
    {
      chatId: 'chat-a',
      messageId: 'message-a',
      userId: 'user-u',
      sourceAt: new Date('2026-10-01T00:00:00Z'),
    },
  ];
  const allowance = (): LegacyRecoveryLiveRedisAllowance => ({
    pages: 512,
    rows: 10_000,
    probes: 50_000,
    bytes: 8 * 1024 * 1024,
    deadlineAtMs: Date.now() + 60_000,
  });
  beforeAll(async () => {
    const target = new URL(url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw new Error('Native inventory requires disposable localhost Redis');
    target.pathname = '/13';
    fixtureUrl = target.toString();
    redis = new Redis(fixtureUrl, {
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      commandTimeout: 10_000,
    });
    const info = await redis.info('server');
    if (!/^redis_version:7\./mu.test(info)) throw new Error('Native inventory requires Redis 7');
    if (await redis.dbsize())
      throw new Error('Disposable native inventory database is already occupied');
    ownsDatabase = true;
  });
  beforeEach(async () => {
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set(
      'maxim:webhook-rollout:pause-owner:v1',
      `rollout:${request.binding.queueFenceNonce}`,
    );
    await pipeline.exec();
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    if (ownsDatabase) await redis.flushdb();
  });
  afterAll(async () => {
    redis?.disconnect();
  });
  const queue = async (name: string): Promise<Queue> => {
    const result = new Queue(name, { connection: { url: fixtureUrl } });
    queues.push(result);
    await result.pause();
    return result;
  };
  const observer = () => {
    const calls: Array<{ script: string; args: string[] }> = [];
    const reader: LegacyRecoveryLiveRedis = {
      eval_ro: async (script, keyCount, ...args) => {
        calls.push({ script, args });
        return redis.eval_ro(script, keyCount, ...args);
      },
    };
    return { reader, calls };
  };
  const action = (extra: Record<string, unknown> = {}) => ({
    actionType: 'DELETE_MESSAGE',
    chatId: 'chat-a',
    messageId: 'message-a',
    userId: 'user-u',
    idempotencyKey: 'effect-a',
    attempt: 0,
    createdAt: '2026-10-01T00:00:01Z',
    ...extra,
  });

  it('handles 10,000 unrelated real webhook jobs without a full payload census or writes', async () => {
    const q = await queue('moderation-default-0');
    await q.addBulk([
      {
        name: 'webhook',
        data: { webhookEventId: 'selected-owner' },
        opts: { jobId: 'selected-owner' },
      },
      ...Array.from({ length: 10_000 }, (_, i) => ({
        name: 'webhook',
        data: { webhookEventId: `unrelated-${i}` },
        opts: { jobId: `unrelated-${i}` },
      })),
    ]);
    const beforeKeys = (await redis.keys('*')).sort();
    const beforeOwner = await redis.hgetall('bull:moderation-default-0:selected-owner');
    const beforePaused = await redis.lrange('bull:moderation-default-0:paused', 0, -1);
    const { reader, calls } = observer();
    const result = await inventoryLegacyRecoveryLiveRedis(reader, request, sources, allowance());
    expect(result.issues).toEqual([]);
    expect(result.cost.rows).toBe(1);
    expect(result.cost.probes).toBeLessThanOrEqual(50_000);
    expect(calls.some((call) => call.script.startsWith('-- legacy-live:jobs'))).toBe(false);
    expect(
      calls
        .filter((call) => call.script.startsWith('-- legacy-live:owners'))
        .every((call) => call.args[1] === '["selected-owner"]'),
    ).toBe(true);
    expect((await redis.keys('*')).sort()).toEqual(beforeKeys);
    expect(await redis.hgetall('bull:moderation-default-0:selected-owner')).toEqual(beforeOwner);
    expect(await redis.lrange('bull:moderation-default-0:paused', 0, -1)).toEqual(beforePaused);
    expect(await q.getJobCounts('paused')).toEqual({ paused: 10_001 });
  });

  it('refuses 6,819 delayed plus 885 prioritized effect jobs before their payload census', async () => {
    const q = await queue('max-actions-background');
    await q.addBulk([
      ...Array.from({ length: 6_819 }, (_, i) => ({
        name: 'action',
        data: action({ idempotencyKey: `delayed-${i}`, userId: 'user-v', messageId: 'message-v' }),
        opts: { jobId: `delayed-${i}`, delay: 3_600_000 },
      })),
      ...Array.from({ length: 885 }, (_, i) => ({
        name: 'action',
        data: action({
          idempotencyKey: `prioritized-${i}`,
          userId: 'user-v',
          messageId: 'message-v',
        }),
        opts: { jobId: `prioritized-${i}`, priority: 1 },
      })),
    ]);
    expect(await q.getJobCounts('delayed', 'prioritized')).toEqual({
      delayed: 6_819,
      prioritized: 885,
    });
    const { reader, calls } = observer();
    const result = await inventoryLegacyRecoveryLiveRedis(reader, request, sources, allowance());
    expect(result.issues).toContainEqual({
      code: 'REDIS_DOUBLE_READ_ROW_BUDGET_EXCEEDED',
      descriptor: 'redis-headers',
    });
    expect(result.cost.rows).toBe(0);
    expect(calls).toHaveLength(1);
    expect(await q.getJobCounts('delayed', 'prioritized')).toEqual({
      delayed: 6_819,
      prioritized: 885,
    });
  });

  it('includes retained completed MAX children that a producer can recycle', async () => {
    const q = await queue('moderation-actions');
    await q.add('action', action(), { jobId: 'completed-child' });
    await redis.lrem('bull:moderation-actions:paused', 0, 'completed-child');
    await redis.zadd('bull:moderation-actions:completed', Date.now(), 'completed-child');
    const before = await redis.hgetall('bull:moderation-actions:completed-child');
    const result = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    expect(result.issues).toEqual([]);
    expect(result.children.map((child) => child.jobKey)).toEqual(['effect-a']);
    expect(await redis.hgetall('bull:moderation-actions:completed-child')).toEqual(before);
    expect(
      await redis.zscore('bull:moderation-actions:completed', 'completed-child'),
    ).not.toBeNull();
  });

  it('binds exact sorted-set scores when counters, counts and payloads stay unchanged', async () => {
    const q = await queue('max-actions-background');
    await q.add('action', action(), { jobId: 'rescheduled-child', delay: 3_600_000 });
    const hash = await redis.hgetall('bull:max-actions-background:rescheduled-child');
    const counter = await redis.get('bull:max-actions-background:id');
    const first = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    const oldScore = await redis.zscore('bull:max-actions-background:delayed', 'rescheduled-child');
    expect(oldScore).not.toBeNull();
    await redis.zadd(
      'bull:max-actions-background:delayed',
      Number(oldScore) + 4096,
      'rescheduled-child',
    );
    const second = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(second.stableDigest).not.toBe(first.stableDigest);
    expect(
      second.proofs.find((proof) => proof.descriptor === 'max-actions-background')?.sha256,
    ).not.toBe(first.proofs.find((proof) => proof.descriptor === 'max-actions-background')?.sha256);
    expect(await redis.hgetall('bull:max-actions-background:rescheduled-child')).toEqual(hash);
    expect(await redis.get('bull:max-actions-background:id')).toBe(counter);
    expect(await q.getJobCounts('delayed')).toEqual({ delayed: 1 });
  });

  it('refuses oversized hashes on the server and inconsistent retained states', async () => {
    const q = await queue('moderation-actions');
    await q.add('action', action({ text: 'x'.repeat(32 * 1024) }), { jobId: 'large-child' });
    const oversized = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    expect(oversized.issues.some((issue) => issue.code === 'JOB_PAYLOAD_OVERSIZED')).toBe(true);
    expect(oversized.cost.bytes).toBeLessThan(32 * 1024);
    await redis.hset('bull:moderation-actions:large-child', 'data', JSON.stringify(action()));
    await redis.zadd('bull:moderation-actions:completed', Date.now(), 'large-child');
    const inconsistent = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    expect(inconsistent.issues.some((issue) => issue.code === 'JOB_MULTIPLE_STATES')).toBe(true);
    expect(await redis.lrange('bull:moderation-actions:paused', 0, -1)).toContain('large-child');
  });

  it('denies a selected owner listed in a state after its hash disappeared', async () => {
    const q = await queue('moderation-default-0');
    await q.add('webhook', { webhookEventId: 'selected-owner' }, { jobId: 'selected-owner' });
    await redis.del('bull:moderation-default-0:selected-owner');
    const result = await inventoryLegacyRecoveryLiveRedis(
      observer().reader,
      request,
      sources,
      allowance(),
    );
    expect(result.issues.some((issue) => issue.code === 'WEBHOOK_OWNER_STATE_INCONSISTENT')).toBe(
      true,
    );
    expect(await redis.lrange('bull:moderation-default-0:paused', 0, -1)).toEqual([
      'selected-owner',
    ]);
  });
});
