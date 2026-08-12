import { createHash, randomUUID } from 'node:crypto';
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
  maxJobAgeMs: 30_000,
  reservationTtlMs: 90_000,
};

describeLocalRedis('CommercialOcrAdmissionStore Redis integration', () => {
  it('atomically releases both capacities when pending activation has expired', async () => {
    const context = createContext('activate-expired');
    const chat = chatKeys(context.chatA);
    try {
      await expect(context.store.reserve(reservation(context.jobA, context.chatA, 3))).resolves.toEqual(
        { kind: 'admitted', state: 'pending' },
      );
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
      await expect(context.store.reserve(reservation(context.jobA, context.chatA, 3))).resolves.toEqual(
        { kind: 'duplicate', state: 'observation' },
      );
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsAfterReserve - 3,
      );
    } finally {
      await context.cleanup();
    }
  });

  it('expires an actionable reservation instead of reporting stale actionability', async () => {
    const context = createContext('activate-actionable-expired');
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
      await expect(context.store.reserve(reservation(context.jobA, context.chatA, 2))).resolves.toEqual(
        { kind: 'duplicate', state: 'observation' },
      );
      expect(Number((await context.redis.get(globalKeys.units)) ?? '0')).toBe(
        globalUnitsBeforeReserve,
      );
    } finally {
      await context.cleanup();
    }
  });

  it('global expiry cleanup releases the originating chat before another admission', async () => {
    const context = createContext('cross-chat-cleanup');
    const chatA = chatKeys(context.chatA);
    try {
      await expect(context.store.reserve(reservation(context.jobA, context.chatA, 4))).resolves.toEqual(
        { kind: 'admitted', state: 'pending' },
      );
      await expireReservation(context.redis, context.jobA, chatA.expiry);

      await expect(context.store.reserve(reservation(context.jobB, context.chatB, 4))).resolves.toEqual(
        { kind: 'admitted', state: 'pending' },
      );
      expect(await context.redis.hget(globalKeys.metadata, context.jobA)).toBeNull();
      expect(await context.redis.get(chatA.units)).toBeNull();
      expect(await context.redis.hget(chatA.weights, context.jobA)).toBeNull();
      expect(await context.redis.zscore(chatA.expiry, context.jobA)).toBeNull();

      await expect(context.store.reserve(reservation(context.jobC, context.chatA, 4))).resolves.toEqual(
        { kind: 'admitted', state: 'pending' },
      );
    } finally {
      await context.cleanup();
    }
  });

  it('suppression-only traffic removes expired observation tombstones', async () => {
    const context = createContext('suppress-cleanup');
    try {
      await expect(context.store.suppress(suppression(context.jobA, context.chatA))).resolves.toBe(
        'suppressed',
      );
      await context.redis.zadd(globalKeys.expiry, (await redisNowMs(context.redis)) - 1_000, context.jobA);

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

function createContext(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const chatA = `chat-a-${suffix}`;
  const chatB = `chat-b-${suffix}`;
  const jobA = jobId(`${suffix}-a`);
  const jobB = jobId(`${suffix}-b`);
  const jobC = jobId(`${suffix}-c`);
  const store = new CommercialOcrAdmissionStore({
    getOrThrow: () => redisIntegrationUrl,
  } as never);
  const redis = new Redis(redisIntegrationUrl);
  const owned = [
    { jobId: jobA, chatId: chatA },
    { jobId: jobB, chatId: chatB },
    { jobId: jobC, chatId: chatA },
  ];
  return {
    chatA,
    chatB,
    jobA,
    jobB,
    jobC,
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

function reservation(jobIdValue: string, chatId: string, imageCount: number) {
  return {
    jobId: jobIdValue,
    chatId,
    sourceCreatedAt: new Date().toISOString(),
    imageCount,
    actionEligible: true,
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
