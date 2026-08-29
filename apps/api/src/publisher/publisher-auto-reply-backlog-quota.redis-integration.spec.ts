import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  PublisherAutoReplyBacklogQuota,
  PublisherAutoReplyBacklogQuotaError,
  type PublisherAutoReplyBacklogClaim,
} from './publisher-auto-reply-backlog-quota';
import type { PublisherAutoReplyJob } from './publisher-auto-reply.queue';

const redisIntegrationUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const isLocalRedisUrl = (() => {
  try {
    const hostname = new URL(redisIntegrationUrl).hostname;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
})();
const describeLocalRedis = isLocalRedisUrl ? describe : describe.skip;

describeLocalRedis('PublisherAutoReplyBacklogQuota Redis integration', () => {
  it('admits only the globally available operation slots across independent clients', async () => {
    const context = createContext(2);
    const claims: PublisherAutoReplyBacklogClaim[] = [];
    try {
      const results = await Promise.allSettled([
        context.quotaA.claimInflight('operation-a'),
        context.quotaB.claimInflight('operation-b'),
        context.quotaA.claimInflight('operation-c'),
      ]);
      for (const result of results) {
        if (result.status === 'fulfilled') {
          claims.push(result.value);
        }
      }

      expect(claims).toHaveLength(2);
      expect(results.find((result) => result.status === 'rejected')).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ reason: 'limit' }),
      });
    } finally {
      await Promise.all(claims.map((claim) => context.quotaA.release(claim)));
      await context.cleanup();
    }
  });

  it('keeps one slot for duplicate attempts and releases it only after the last fence', async () => {
    const context = createContext(1);
    const claims: PublisherAutoReplyBacklogClaim[] = [];
    try {
      claims.push(
        await context.quotaA.claimInflight('same-operation'),
        await context.quotaB.claimInflight('same-operation'),
      );
      expect(claims[0]?.operationId).toBe(claims[1]?.operationId);
      expect(claims[0]?.attemptToken).not.toBe(claims[1]?.attemptToken);
      await expect(context.quotaA.claimInflight('other-operation')).rejects.toMatchObject({
        reason: 'limit',
      });

      await context.quotaA.release(claims.shift()!);
      await expect(context.quotaA.claimInflight('other-operation')).rejects.toMatchObject({
        reason: 'limit',
      });

      await context.quotaB.release(claims.shift()!);
      const replacement = await context.quotaA.claimInflight('other-operation');
      claims.push(replacement);
    } finally {
      await Promise.all(claims.map((claim) => context.quotaA.release(claim)));
      await context.cleanup();
    }
  });

  it('counts a BullMQ job after its operation lease is released', async () => {
    const context = createContext(1);
    let claim: PublisherAutoReplyBacklogClaim | null = null;
    try {
      claim = await context.quotaA.claimInflight('integration-delivery-1');
      await context.queueA.add(
        'deliver',
        {
          version: 1,
          kind: 'deliver',
          retryPolicyName: 'publisher-auto-reply',
          deliveryId: 'integration-delivery-1',
        },
        { jobId: 'integration-delivery-1' },
      );
      await context.quotaA.release(claim);
      claim = null;

      await expect(context.quotaB.assertAvailable()).rejects.toMatchObject({ reason: 'limit' });
      await expect(context.quotaB.claimInflight('integration-delivery-2')).rejects.toMatchObject({
        reason: 'limit',
      });

      const job = await context.queueA.getJob('integration-delivery-1');
      await job?.remove();
      const replacement = await context.quotaB.claimInflight('integration-delivery-2');
      await context.quotaB.release(replacement);
    } finally {
      if (claim) {
        await context.quotaA.release(claim);
      }
      await context.cleanup();
    }
  });

  it('recovers a crashed lease and fences a delayed release from its old generation', async () => {
    const context = createContext(1, { inflightLeaseTtlMs: 100 });
    let current: PublisherAutoReplyBacklogClaim | null = null;
    try {
      const crashed = await context.quotaA.claimInflight('same-operation');
      await expect(context.quotaB.claimInflight('other-operation')).rejects.toMatchObject({
        reason: 'limit',
      });
      await wait(140);

      current = await context.quotaB.claimInflight('same-operation');
      expect(current.attemptToken).not.toBe(crashed.attemptToken);
      await context.quotaA.release(crashed);
      await expect(context.quotaA.claimInflight('other-operation')).rejects.toMatchObject({
        reason: 'limit',
      });

      await context.quotaB.release(current);
      current = null;
      const recovered = await context.quotaA.claimInflight('other-operation');
      await context.quotaA.release(recovered);
    } finally {
      if (current) {
        await context.quotaB.release(current);
      }
      await context.cleanup();
    }
  });

  it('cleans an exact attempt when claim commits but its response is lost', async () => {
    const context = createContext(1, {}, false);
    const client = (await context.queueA.client) as unknown as {
      eval: (...args: unknown[]) => Promise<unknown>;
    };
    const evaluate = client.eval.bind(client);
    let injected = false;
    client.eval = async (...args: unknown[]) => {
      const result = await evaluate(...args);
      if (!injected && String(args[0]).includes('BACKLOG_CLAIM_V2')) {
        injected = true;
        throw new Error('simulated response loss after claim commit');
      }
      return result;
    };

    try {
      await expect(context.quotaA.claimInflight('ambiguous-operation')).rejects.toMatchObject({
        reason: 'unavailable',
      });
      const replacement = await context.quotaB.claimInflight('replacement-operation');
      await context.quotaB.release(replacement);
    } finally {
      client.eval = evaluate;
      await context.cleanup();
    }
  });

  it('counts a legacy BullMQ wait-list marker conservatively', async () => {
    const context = createContext(1);
    try {
      await context.redis.rpush(context.queueA.keys.wait, '0:legacy-marker');

      await expect(context.quotaA.assertAvailable()).rejects.toBeInstanceOf(
        PublisherAutoReplyBacklogQuotaError,
      );
      await expect(context.quotaA.assertAvailable()).rejects.toMatchObject({ reason: 'limit' });
    } finally {
      await context.cleanup();
    }
  });

});

function createContext(
  limit: number,
  leaseOverrides: { inflightLeaseTtlMs?: number } = {},
  useOwnedRedis = true,
) {
  const queueName = `{maxim-auto-reply-backlog-${randomUUID()}}`;
  const connection = { url: redisIntegrationUrl };
  const queueA = new Queue<PublisherAutoReplyJob>(queueName, {
    connection,
    prefix: 'maxim-test',
  });
  const queueB = new Queue<PublisherAutoReplyJob>(queueName, {
    connection,
    prefix: 'maxim-test',
  });
  const quotaOptions = {
    commandTimeoutMs: 1_000,
    ...(useOwnedRedis ? { redisUrl: redisIntegrationUrl } : {}),
    ...leaseOverrides,
  };
  const quotaA = new PublisherAutoReplyBacklogQuota(queueA, limit, quotaOptions);
  const quotaB = new PublisherAutoReplyBacklogQuota(queueB, limit, quotaOptions);
  const redis = new Redis(redisIntegrationUrl);

  return {
    queueA,
    quotaA,
    quotaB,
    redis,
    cleanup: async () => {
      await Promise.all([quotaA.close(), quotaB.close()]);
      await queueA.obliterate({ force: true }).catch(() => undefined);
      await Promise.all([queueA.close(), queueB.close(), redis.quit()]);
    },
  };
}

async function wait(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
