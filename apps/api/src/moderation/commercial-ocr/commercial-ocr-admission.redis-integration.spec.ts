import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import Redis from 'ioredis';

import { CommercialOcrAdmissionStore } from './commercial-ocr-admission.store';
import { buildCommercialOcrJobId } from './commercial-ocr.queue';

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
const namespace = 'commercial-ocr:admission:v2';
const globalKeys = {
  expiry: `${namespace}:global:expiry`,
  metadata: `${namespace}:global:metadata`,
  units: `${namespace}:global:units`,
};
const limits = {
  maxGlobalImageUnits: 12,
  maxChatImageUnits: 4,
  reservedActionableImageUnits: 4,
  maxJobAgeMs: 30_000,
  reservationTtlMs: 90_000,
};

describeLocalRedis('CommercialOcrAdmissionStore Redis integration', () => {
  it('keeps exactly one terminal after Redis committed but the first reply was lost', async () => {
    const context = await createContext('terminal-lost-reply');
    const digest = createHash('sha256').update(context.jobA).digest('hex');
    const scope = `tesseract-test:${digest.slice(0, 24)}`;
    const recording = {
      identitySha256: digest,
      releaseKey: `commercial-ocr:metrics:v2:release:${scope}`,
      bucketKey: `commercial-ocr:metrics:v2:window:${scope}:1`,
      startedAtMs: Date.now(),
    };
    const params = {
      jobId: context.jobA,
      chatId: context.chatA,
      context: recording,
      terminal: { outcome: 'EXPIRED' as const, reason: 'governor_pressure' as const },
    };
    try {
      await context.store.reserve(reservation(context.jobA, context.chatA, 2));
      Object.defineProperty(context.store, 'runRedisOperation', {
        configurable: true,
        value: async (operation: Promise<unknown>) => {
          await operation;
          throw new Error('reply lost');
        },
      });
      await expect(context.store.finalize(params)).resolves.toBe('unavailable');
      Reflect.deleteProperty(context.store, 'runRedisOperation');
      await expect(context.store.finalize(params)).resolves.toBe('duplicate');
      expect(await context.redis.hget(recording.releaseKey, 'counter:logical.terminal')).toBe('1');
      expect(
        await context.redis.hget(recording.releaseKey, 'counter:logical.outcome.EXPIRED'),
      ).toBe('1');
      expect(await context.redis.get(globalKeys.units)).toBeNull();
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('suppressed');
    } finally {
      Reflect.deleteProperty(context.store, 'runRedisOperation');
      await context.redis.del(
        `${namespace}:logical:${digest}`,
        recording.releaseKey,
        recording.bucketKey,
      );
      await context.cleanup();
    }
  });

  it('counts one logical start and terminal across concurrent mirrors and a worker restart', async () => {
    const context = await createContext('terminal-dedup');
    const digest = createHash('sha256').update(context.jobA).digest('hex');
    const scope = `tesseract-test:${digest.slice(0, 24)}`;
    const recording = {
      identitySha256: digest,
      releaseKey: `commercial-ocr:metrics:v2:release:${scope}`,
      bucketKey: `commercial-ocr:metrics:v2:window:${scope}:1`,
      startedAtMs: Date.now(),
    };
    const logicalKey = `${namespace}:logical:${digest}`;
    const params = { jobId: context.jobA, chatId: context.chatA, context: recording };
    const restarted = new CommercialOcrAdmissionStore({
      getOrThrow: () => redisIntegrationUrl,
    } as never);
    try {
      const restartedRedis = (restarted as unknown as { redis: Redis }).redis;
      if (restartedRedis.status !== 'ready') await once(restartedRedis, 'ready');
      await context.store.reserve(reservation(context.jobA, context.chatA, 2));
      await context.store.activate(activation(context.jobA));
      expect(
        (
          await Promise.all([context.store.recordStarted(params), restarted.recordStarted(params)])
        ).sort(),
      ).toEqual(['duplicate', 'recorded']);
      const terminal = {
        outcome: 'TECHNICAL_INCOMPLETE' as const,
        reason: 'source_unavailable' as const,
      };
      expect(
        (
          await Promise.all([
            context.store.finalize({ ...params, terminal }),
            restarted.finalize({ ...params, terminal }),
          ])
        ).sort(),
      ).toEqual(['duplicate', 'recorded']);
      expect(await context.redis.hget(recording.releaseKey, 'counter:logical.started')).toBe('1');
      expect(await context.redis.hget(recording.releaseKey, 'counter:logical.terminal')).toBe('1');
      expect(
        await context.redis.hget(
          recording.bucketKey,
          'counter:logical.outcome.TECHNICAL_INCOMPLETE',
        ),
      ).toBe('1');
      await expect(
        restarted.finalize({
          ...params,
          terminal: { outcome: 'COMPLETE_DELETE_CANDIDATE', reason: 'complete' },
        }),
      ).resolves.toBe('duplicate');
      expect(
        await context.redis.hget(
          recording.releaseKey,
          'counter:logical.outcome.COMPLETE_DELETE_CANDIDATE',
        ),
      ).toBeNull();
      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBe(
        `${chatKeys(context.chatA).hash}|2|O|0`,
      );
      expect(await context.redis.get(globalKeys.units)).toBeNull();
      await expect(restarted.activate(activation(context.jobA))).resolves.toBe('suppressed');
      expect(await context.redis.pttl(logicalKey)).toBeGreaterThan(0);
      expect(await context.redis.pttl(logicalKey)).toBeLessThanOrEqual(22 * 60_000);
      // After retained admission disappears, even losing the claim never invents a new denominator.
      await context.redis.hdel(globalKeys.metadata, context.jobA);
      await context.redis.del(logicalKey);
      await expect(restarted.finalize({ ...params, terminal })).resolves.toBe('missing');
      expect(await context.redis.hget(recording.releaseKey, 'counter:logical.terminal')).toBe('1');
    } finally {
      await context.redis.del(logicalKey, recording.releaseKey, recording.bucketKey);
      await restarted.onModuleDestroy();
      await context.cleanup();
    }
  });

  it('separates terminal claims for changed behavior/purposes without releasing capacity twice', async () => {
    const context = await createContext('terminal-behavior');
    const scope = `tesseract-test:${createHash('sha256').update(context.jobA).digest('hex').slice(0, 24)}`;
    const recording = {
      identitySha256: createHash('sha256').update(`${context.jobA}:v1`).digest('hex'),
      releaseKey: `commercial-ocr:metrics:v2:release:${scope}`,
      bucketKey: `commercial-ocr:metrics:v2:window:${scope}:1`,
      startedAtMs: Date.now(),
    };
    const second = {
      ...recording,
      identitySha256: createHash('sha256').update(`${context.jobA}:v2`).digest('hex'),
    };
    const terminal = { outcome: 'COMPLETE_KEEP' as const, reason: 'complete' as const };
    try {
      await context.store.reserve(reservation(context.jobA, context.chatA, 2));
      await expect(
        context.store.finalize({
          jobId: context.jobA,
          chatId: context.chatA,
          context: recording,
          terminal,
        }),
      ).resolves.toBe('recorded');
      await expect(
        context.store.finalize({
          jobId: context.jobA,
          chatId: context.chatA,
          context: second,
          terminal,
        }),
      ).resolves.toBe('recorded');
      expect(await context.redis.hget(recording.releaseKey, 'counter:logical.terminal')).toBe('2');
      expect(await context.redis.get(globalKeys.units)).toBeNull();
      expect(await context.redis.get(chatKeys(context.chatA).units)).toBeNull();
    } finally {
      await context.redis.del(
        `${namespace}:logical:${recording.identitySha256}`,
        `${namespace}:logical:${second.identitySha256}`,
        recording.releaseKey,
        recording.bucketKey,
      );
      await context.cleanup();
    }
  });
  it('recovers the durable-webhook crash window through the pending activation CAS', async () => {
    const context = await createContext('worker-crash-window-recovery');
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 2)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      await expect(context.store.resolveState(context.jobA)).resolves.toEqual({
        kind: 'available',
        state: 'pending',
      });

      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('activated');
      await expect(context.store.resolveState(context.jobA)).resolves.toEqual({
        kind: 'available',
        state: 'actionable',
      });
    } finally {
      await context.cleanup();
    }
  });

  it('keeps suppression absorbing when it wins before worker reconciliation', async () => {
    const context = await createContext('worker-suppression-race');
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 2)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      await expect(context.store.suppress(suppression(context.jobA, context.chatA))).resolves.toBe(
        'suppressed',
      );

      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('suppressed');
      await expect(context.store.resolveState(context.jobA)).resolves.toEqual({
        kind: 'available',
        state: 'observation',
      });
    } finally {
      await context.cleanup();
    }
  });

  it('reports a producer-won activation race without changing the actionable state again', async () => {
    const context = await createContext('worker-producer-activation-race');
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 2)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('activated');

      await expect(context.store.activate(activation(context.jobA))).resolves.toBe(
        'already_actionable',
      );
      await expect(context.store.resolveState(context.jobA)).resolves.toEqual({
        kind: 'available',
        state: 'actionable',
      });
    } finally {
      await context.cleanup();
    }
  });

  it('reserves global capacity from observations while admitting actionable work', async () => {
    const context = await createContext('actionable-reserve');
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 4, false)),
      ).resolves.toEqual({ kind: 'admitted', state: 'observation' });
      await expect(
        context.store.reserve(reservation(context.jobB, context.chatB, 3, false)),
      ).resolves.toEqual({ kind: 'admitted', state: 'observation' });
      await expect(
        context.store.reserve(reservation(context.jobD, context.chatC, 2, false)),
      ).resolves.toEqual({ kind: 'rejected_actionable_reserve' });

      await expect(
        context.store.reserve(reservation(context.jobD, context.chatC, 4, true)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      expect(Number(await context.redis.get(globalKeys.units))).toBe(11);
    } finally {
      await context.cleanup();
    }
  });

  it('atomically releases both capacities when pending activation has expired', async () => {
    const context = await createContext('activate-expired');
    const chat = chatKeys(context.chatA);
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 3)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      const globalUnitsAfterReserve = Number(await context.redis.get(globalKeys.units));
      await expireReservation(context.redis, context.jobA, chat.expiry);

      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('expired');

      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBe(
        `${chat.hash}|3|O|0`,
      );
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsAfterReserve - 3,
      );
      expect(await context.redis.get(chat.units)).toBeNull();
      expect(await context.redis.hget(chat.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chat.expiry, context.jobA)).toBeNull();
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 3)),
      ).resolves.toEqual({ kind: 'duplicate', state: 'observation' });
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsAfterReserve - 3,
      );
    } finally {
      await context.cleanup();
    }
  });

  it('absorbs an existing reservation when a replay reports another image count', async () => {
    const context = await createContext('suppress-changed-count');
    const chat = chatKeys(context.chatA);
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 3)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });

      await expect(
        context.store.suppress({
          jobId: context.jobA,
          chatId: context.chatA,
          imageCount: 1,
          tombstoneTtlMs: limits.reservationTtlMs,
        }),
      ).resolves.toBe('suppressed');

      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBe(
        `${chat.hash}|3|O|0`,
      );
      expect(await context.redis.get(globalKeys.units)).toBeNull();
      expect(await context.redis.get(chat.units)).toBeNull();
      expect(await context.redis.hget(chat.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chat.expiry, context.jobA)).toBeNull();
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('suppressed');
    } finally {
      await context.cleanup();
    }
  });

  it('releases capacity when a shadow replay absorbs an actionable reservation', async () => {
    const context = await createContext('shadow-replay-release');
    const chat = chatKeys(context.chatA);
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 3)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('activated');

      await expect(
        context.store.reserve({
          ...reservation(context.jobA, context.chatA, 3),
          actionEligible: false,
        }),
      ).resolves.toEqual({ kind: 'duplicate', state: 'observation' });

      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBe(
        `${chat.hash}|3|O|0`,
      );
      expect(await context.redis.get(globalKeys.units)).toBeNull();
      expect(await context.redis.get(chat.units)).toBeNull();
      expect(await context.redis.hget(chat.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chat.expiry, context.jobA)).toBeNull();
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('suppressed');
    } finally {
      await context.cleanup();
    }
  });

  it('expires an actionable reservation instead of reporting stale actionability', async () => {
    const context = await createContext('activate-actionable-expired');
    const chat = chatKeys(context.chatA);
    try {
      const globalUnitsBeforeReserve = Number((await context.redis.get(globalKeys.units)) ?? '0');
      await context.store.reserve(reservation(context.jobA, context.chatA, 2));
      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('activated');
      await expireReservation(context.redis, context.jobA, chat.expiry);

      await expect(context.store.activate(activation(context.jobA))).resolves.toBe('expired');
      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBe(
        `${chat.hash}|2|O|0`,
      );
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsBeforeReserve,
      );
      expect(await context.redis.get(chat.units)).toBeNull();
      expect(await context.redis.hget(chat.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chat.expiry, context.jobA)).toBeNull();
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 2)),
      ).resolves.toEqual({ kind: 'duplicate', state: 'observation' });
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsBeforeReserve,
      );
    } finally {
      await context.cleanup();
    }
  });

  it('global expiry cleanup releases the originating chat before another admission', async () => {
    const context = await createContext('cross-chat-cleanup');
    const chatA = chatKeys(context.chatA);
    try {
      await expect(
        context.store.reserve(reservation(context.jobA, context.chatA, 4)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      await expireReservation(context.redis, context.jobA, chatA.expiry);

      await expect(
        context.store.reserve(reservation(context.jobB, context.chatB, 4)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBeNull();
      expect(await context.redis.get(chatA.units)).toBeNull();
      expect(await context.redis.hget(chatA.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chatA.expiry, context.jobA)).toBeNull();

      await expect(
        context.store.reserve(reservation(context.jobC, context.chatA, 4)),
      ).resolves.toEqual({ kind: 'admitted', state: 'pending' });
    } finally {
      await context.cleanup();
    }
  });

  it('suppression-only traffic removes expired observation tombstones', async () => {
    const context = await createContext('suppress-cleanup');
    try {
      await expect(context.store.suppress(suppression(context.jobA, context.chatA))).resolves.toBe(
        'suppressed',
      );
      await context.redis.zadd(
        globalKeys.expiry,
        (await redisNowMs(context.redis)) - 1_000,
        context.jobA,
      );

      await expect(context.store.suppress(suppression(context.jobB, context.chatB))).resolves.toBe(
        'suppressed',
      );

      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBeNull();
      expect(await context.redis.zscore(globalKeys.expiry, context.jobA)).toBeNull();
      expect(await context.redis.hget(globalKeys.metadata, context.jobB)).toMatch(/\|1\|O\|0$/u);
    } finally {
      await context.cleanup();
    }
  });
});

async function createContext(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const chatA = `chat-a-${suffix}`;
  const chatB = `chat-b-${suffix}`;
  const chatC = `chat-c-${suffix}`;
  const jobA = jobId(`${suffix}-a`);
  const jobB = jobId(`${suffix}-b`);
  const jobC = jobId(`${suffix}-c`);
  const jobD = jobId(`${suffix}-d`);
  const store = new CommercialOcrAdmissionStore({
    getOrThrow: () => redisIntegrationUrl,
  } as never);
  const redis = new Redis(redisIntegrationUrl);
  // The store deliberately disables offline queuing; do not race its initial connection.
  const clients = [redis, (store as unknown as { redis: Redis }).redis];
  try {
    await Promise.all(
      clients.map(async (client) => {
        if (client.status !== 'ready') await once(client, 'ready');
      }),
    );
  } catch (error) {
    clients.forEach((client) => client.disconnect());
    throw error;
  }
  const owned = [
    { jobId: jobA, chatId: chatA },
    { jobId: jobB, chatId: chatB },
    { jobId: jobC, chatId: chatA },
    { jobId: jobD, chatId: chatC },
  ];
  return {
    chatA,
    chatB,
    chatC,
    jobA,
    jobB,
    jobC,
    jobD,
    store,
    redis,
    cleanup: async () => {
      for (const entry of owned) {
        await store.release({ jobId: entry.jobId, chatId: entry.chatId });
        const chat = chatKeys(entry.chatId);
        await redis.hdel(globalKeys.metadata, entry.jobId);
        await redis.zrem(globalKeys.expiry, entry.jobId);
        await redis.hdel(chat.weights, entry.jobId);
        await redis.zrem(chat.expiry, entry.jobId);
        await redis.del(chat.units, chat.weights, chat.expiry);
      }
      await redis.quit();
      await store.onModuleDestroy();
    },
  };
}

function reservation(
  jobIdValue: string,
  chatId: string,
  imageCount: number,
  actionEligible = true,
) {
  return {
    jobId: jobIdValue,
    chatId,
    sourceCreatedAt: new Date().toISOString(),
    imageCount,
    actionEligible,
    limits,
  };
}

function suppression(jobIdValue: string, chatId: string) {
  return { jobId: jobIdValue, chatId, imageCount: 1, tombstoneTtlMs: limits.reservationTtlMs };
}

function activation(jobIdValue: string) {
  return { jobId: jobIdValue, tombstoneTtlMs: limits.reservationTtlMs };
}

async function expireReservation(redis: Redis, jobIdValue: string, chatExpiryKey: string) {
  const expiredAt = (await redisNowMs(redis)) - 1;
  await redis.zadd(globalKeys.expiry, expiredAt, jobIdValue);
  await redis.zadd(chatExpiryKey, expiredAt, jobIdValue);
}

async function redisNowMs(redis: Redis): Promise<number> {
  const [seconds, micros] = await redis.time();
  return Number(seconds) * 1_000 + Math.floor(Number(micros) / 1_000);
}

function chatKeys(chatId: string) {
  const hash = createHash('sha256').update(chatId).digest('hex').slice(0, 32);
  const prefix = `${namespace}:chat:${hash}`;
  return {
    hash,
    expiry: `${prefix}:expiry`,
    weights: `${prefix}:weights`,
    units: `${prefix}:units`,
  };
}

function jobId(seed: string): string {
  return buildCommercialOcrJobId({
    chatId: seed,
    messageId: seed,
    sourceCreatedAt: '2026-08-12T08:00:00.000Z',
    ocrVersion: 'tesseract-rus-eng-v1',
  });
}
