import { randomUUID } from 'node:crypto';
import type { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosHeaders } from 'axios';
import Redis from 'ioredis';
import { of } from 'rxjs';
import type { ActionHealthService } from '../system/action-health.service';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from './max-client.service';
import {
  MaxModerationApiBudget,
  MaxModerationApiBudgetError,
  maxMuteApiBudgetKeys,
} from './max-moderation-api-budget';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const localRedis = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(redisUrl).hostname);
  } catch {
    return false;
  }
})();
const describeRedis = localRedis ? describe : describe.skip;
type Scope = Parameters<MaxModerationApiBudget['run']>[0];

describeRedis('Muted-user MAX API budget with native Redis', () => {
  let redis: Redis;
  let first: MaxModerationApiBudget;
  let peer: MaxModerationApiBudget;
  let suffix: string;
  let keys: Set<string>;

  beforeAll(async () => {
    redis = new Redis(redisUrl);
    await redis.ping();
  });

  beforeEach(() => {
    suffix = randomUUID();
    keys = new Set();
    first = new MaxModerationApiBudget(redisUrl);
    peer = new MaxModerationApiBudget(redisUrl);
  });

  afterEach(async () => {
    await Promise.all([first.close(), peer.close()]);
    if (keys.size) await redis.del(...keys);
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await redis?.quit();
  });

  function scope(user = 'actor', chat = 'chat'): Scope {
    const value: Scope = {
      chatId: `test-mute-chat-${chat}-${suffix}`,
      subjectUserId: `test-mute-user-${user}-${suffix}`,
      intentId: `test-mute-intent-${randomUUID()}`,
      attemptCount: 1,
      deadlineAtMs: Date.now() + 60_000,
    };
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    keys.add(owned.actor);
    keys.add(owned.chat);
    return value;
  }

  function consume(service: MaxModerationApiBudget): Promise<unknown> {
    return Promise.resolve().then(() => service.consumeRequest());
  }

  function nativeTransportFixture(value: Scope, overrides: Record<string, string | number> = {}) {
    const botId = `test-mute-transport-${suffix}`;
    const serviceName = `test-mute-transport-${suffix}`;
    const config = new ConfigService({
      MAX_API_BASE_URL: 'https://platform-api2.max.ru',
      REDIS_URL: redisUrl,
      MAX_BOT_ID: botId,
      MAX_BOT_TOKEN: 'native-mute-test-token',
      MAX_WEBHOOK_SECRET_PATH: 'native-mute-test-path',
      MAX_WEBHOOK_HEADER_SECRET: 'native-mute-test-header',
      MAX_API_GLOBAL_RPS: 30,
      MAX_API_GLOBAL_RPS_CRITICAL: 30,
      MAX_API_GLOBAL_RPS_INTERACTIVE: 30,
      MAX_API_GLOBAL_RPS_BACKGROUND: 30,
      MAX_API_CHAT_RPS: 30,
      MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: 0,
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: 0,
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: 0,
      MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE: 0,
      MAX_MUTED_USER_API_PROTECTION_ENABLED: true,
      APP_SERVICE_NAME: serviceName,
      ...overrides,
    });
    const request = jest
      .fn<ReturnType<HttpService['request']>, Parameters<HttpService['request']>>()
      .mockReturnValue(
        of({
          status: 200,
          statusText: 'OK',
          headers: {},
          config: { headers: new AxiosHeaders() },
          data: { user_id: '123', success: true },
        }),
      );
    const health: Pick<ActionHealthService, 'recordSuccessForLane' | 'recordFailureForLane'> = {
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
    };
    const service = new MaxClientService(
      { request } as unknown as HttpService,
      config,
      health as ActionHealthService,
      new MaxBotRegistryService(config),
      new MaxBotContextService(),
    );
    const internals = service as unknown as {
      registerCriticalFailure(
        botId: string,
        permit: { halfOpenProbeToken: string | null },
      ): Promise<void>;
    };
    const criticalFailure = jest.spyOn(internals, 'registerCriticalFailure');
    for (const key of [
      `maxapi:gcra:v1:bot:${botId}:all`,
      `maxapi:gcra:v1:bot:${botId}:all:window:v1`,
      `maxapi:gcra:v1:bot:${botId}:all:cooldown`,
      `maxapi:gcra:v1:service:${serviceName}:bot:${botId}:class:critical`,
      `maxapi:gcra:v1:chat:${botId}:${value.chatId}`,
      `maxapi:gcra:v1:message-mutation:operation:delete:scope:target:${encodeURIComponent(value.chatId)}`,
    ]) {
      keys.add(key);
    }
    return { botId, service, request, health, criticalFailure };
  }

  async function exhaustActor(value: Scope): Promise<MaxModerationApiBudgetError> {
    for (let index = 0; index < 6; index++) {
      await first.run({ ...value, intentId: `${value.intentId}-${index}` }, async () => undefined);
    }
    const result = await peer
      .run({ ...value, attemptCount: 2 }, async () => {
        throw new Error('An exhausted actor entered the MAX attempt');
      })
      .catch((error: unknown) => error);
    expect(result).toBeInstanceOf(MaxModerationApiBudgetError);
    expect(result).toBeInstanceOf(MaxApiInternalRateLimitError);
    expect(result).toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
      limitScope: 'moderation_protection',
      reason: 'actor_cooldown',
    });
    return result as MaxModerationApiBudgetError;
  }

  it('shares one atomic actor allowance across concurrent helper instances', async () => {
    const value = scope();
    const admitted = jest.fn();
    const startedAt = Date.now();
    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? peer : first).run(
          { ...value, intentId: `${value.intentId}-${index}` },
          async () => {
            admitted();
          },
        ),
      ),
    );

    // A replenished 12-request reservation takes six seconds. An unexpectedly
    // slow run must not silently masquerade as an atomic burst measurement.
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(6);
    expect(admitted).toHaveBeenCalledTimes(6);
    for (const result of results) {
      if (result.status === 'rejected') {
        expect(result.reason).toBeInstanceOf(MaxModerationApiBudgetError);
        expect(result.reason).toMatchObject({ reason: 'actor_cooldown', preDispatch: true });
      }
    }
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    expect(await redis.pttl(owned.actor)).toBeGreaterThan(0);
    expect(await redis.pttl(owned.chat)).toBeGreaterThan(0);
  });

  it('caps rotating actors by the shared chat budget across helper instances', async () => {
    const values = Array.from({ length: 24 }, (_, index) => scope(`rotating-${index}`));
    const admitted = jest.fn();
    const startedAt = Date.now();
    const results = await Promise.allSettled(
      values.map((value, index) =>
        (index % 2 ? peer : first).run(value, async () => {
          admitted();
        }),
      ),
    );

    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(12);
    expect(admitted).toHaveBeenCalledTimes(12);
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ reason: 'chat_budget', preDispatch: true });
        const denied = maxMuteApiBudgetKeys(values[index]!.chatId, values[index]!.subjectUserId);
        expect(await redis.exists(denied.actor)).toBe(0);
      }
    }
    await expect(first.run(scope('independent', 'quiet'), async () => 'quiet')).resolves.toBe(
      'quiet',
    );
  });

  it('isolates an exhausted actor and keeps rejected requests from spending chat capacity', async () => {
    const value = scope();
    const refusal = await exhaustActor(value);
    expect(refusal.retryAfterMs).toBeGreaterThan(290_000);
    expect(refusal.retryAfterMs).toBeLessThanOrEqual(300_000);
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    const before = await redis.hgetall(owned.chat);

    for (let index = 0; index < 4; index++) {
      await expect(peer.run(value, async () => undefined)).rejects.toMatchObject({
        reason: 'actor_cooldown',
      });
    }

    expect(await redis.hgetall(owned.chat)).toEqual(before);
    await expect(first.run(scope('other'), async () => 'other')).resolves.toBe('other');
    await expect(first.run(scope('actor', 'quiet'), async () => 'quiet')).resolves.toBe('quiet');
  });

  it('keeps cooldown deadlines fixed and escalates only a new exhausted episode', async () => {
    const value = scope();
    await exhaustActor(value);
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    const firstEpisode = await redis.hgetall(owned.actor);
    expect(firstEpisode.level).toBe('1');

    for (let index = 0; index < 8; index++) {
      await expect(peer.run(value, async () => undefined)).rejects.toMatchObject({
        reason: 'actor_cooldown',
      });
    }
    expect(await redis.hgetall(owned.actor)).toEqual(firstEpisode);

    for (const [level, delay] of [
      [2, 900_000],
      [3, 3_600_000],
      [3, 3_600_000],
    ]) {
      const time = await redis.time();
      const now = Number(time[0]) * 1_000 + Math.floor(Number(time[1]) / 1_000);
      // Advance only this test actor's completed episode, then exhaust its next
      // allowance. Redis TIME still controls the production admission script.
      await redis.hset(owned.actor, {
        tokens: 0,
        lastRefillAtMs: now,
        cooldownUntilMs: now - 1,
      });
      await redis.hset(owned.chat, { tokens: 144, lastRefillAtMs: now });
      await expect(first.run(value, async () => undefined)).rejects.toMatchObject({
        reason: 'actor_cooldown',
        retryAfterMs: delay,
      });
      const episode = await redis.hgetall(owned.actor);
      expect(episode.level).toBe(String(level));
      expect(Number(episode.cooldownUntilMs) - Number(episode.lastRefillAtMs)).toBe(delay);
      await expect(peer.run(value, async () => undefined)).rejects.toMatchObject({
        reason: 'actor_cooldown',
      });
      expect(await redis.hgetall(owned.actor)).toEqual(episode);
    }
  });

  it('admits at most twelve HTTP requests within one attempt even with concurrent consumers', async () => {
    await first.run(scope(), async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, index) => consume(index % 2 ? peer : first)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(12);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(MaxModerationApiBudgetError);
          expect(result.reason).toMatchObject({ reason: 'attempt_budget', preDispatch: true });
        }
      }
    });
  });

  it.each<{ label: string; config: Record<string, string | number> }>([
    { label: 'legacy token burst', config: {} },
    {
      label: 'production zero token burst',
      config: {
        MAX_API_GLOBAL_BURST: 0,
        MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: 500,
        MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE: 500,
      },
    },
  ])(
    'blocks the thirteenth global GET with $label without degrading bot health',
    async ({ config }) => {
      const value = scope();
      const { botId, service, request, health, criticalFailure } = nativeTransportFixture(
        value,
        config,
      );
      const options = {
        botId,
        trafficClass: 'critical' as const,
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      };
      try {
        await service.runWithMuteApiBudget(value, async () => {
          for (let index = 0; index < 12; index++) {
            await expect(service.getOwnProfile(options)).resolves.toMatchObject({ userId: '123' });
          }
          await expect(service.getOwnProfile(options)).rejects.toMatchObject({
            code: 'MAX_API_INTERNAL_RATE_LIMIT',
            limitScope: 'moderation_protection',
            preDispatch: true,
            reason: 'attempt_budget',
          });
        });

        expect(request).toHaveBeenCalledTimes(12);
        expect(health.recordSuccessForLane).toHaveBeenCalledTimes(12);
        expect(health.recordFailureForLane).not.toHaveBeenCalled();
        expect(criticalFailure).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('rechecks expiry after the final mutation guard before the real DELETE transport', async () => {
    const value = scope();
    const { botId, service, request, health, criticalFailure } = nativeTransportFixture(value);
    let restoreClock: () => void = () => undefined;
    const beforeImmediateDeleteMutation = jest.fn(async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(value.deadlineAtMs);
      restoreClock = () => clock.mockRestore();
    });
    try {
      await expect(
        service.runWithMuteApiBudget(value, () =>
          service.deleteMessage(value.chatId, `test-mute-message-${suffix}`, {
            immediate: true,
            botId,
            trafficClass: 'critical',
            sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
            beforeImmediateDeleteMutation,
          }),
        ),
      ).rejects.toMatchObject({ reason: 'expired', preDispatch: true });

      expect(beforeImmediateDeleteMutation).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(health.recordFailureForLane).not.toHaveBeenCalled();
      expect(criticalFailure).not.toHaveBeenCalled();
    } finally {
      restoreClock();
      await service.onModuleDestroy();
    }
  });

  it('reuses the exact nested attempt allowance and refuses a different nested intent', async () => {
    const value = scope();
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    await first.run(value, async () => {
      const before = await redis.hgetall(owned.actor);
      await peer.run(value, async () => {
        for (let index = 0; index < 12; index++) peer.consumeRequest();
      });
      expect(await redis.hgetall(owned.actor)).toEqual(before);
      await expect(consume(first)).rejects.toMatchObject({ reason: 'attempt_budget' });
      const callback = jest.fn();
      await expect(
        peer.run({ ...value, intentId: `${value.intentId}-different` }, callback),
      ).rejects.toMatchObject({ reason: 'attempt_budget' });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('rejects expired admission before creating Redis state or entering the callback', async () => {
    const value = { ...scope(), deadlineAtMs: Date.now() - 1 };
    const callback = jest.fn();
    await expect(first.run(value, callback)).rejects.toMatchObject({ reason: 'expired' });
    expect(callback).not.toHaveBeenCalled();
    expect(await redis.exists(...keys)).toBe(0);
  });

  it('enforces the original deadline at request consumption without renewing it', async () => {
    const value = scope();
    await first.run(value, async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(value.deadlineAtMs);
      try {
        await expect(consume(first)).rejects.toMatchObject({ reason: 'expired' });
      } finally {
        clock.mockRestore();
      }
    });
  });

  it('rejects an inherited async context after its owning attempt has returned', async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<unknown>;
    await first.run(scope(), async () => {
      detached = released.then(() => consume(first));
    });
    const observed = expect(detached).rejects.toMatchObject({ reason: 'expired' });
    release();
    await observed;
  });

  it('fails closed on a native Redis command error without admitting the attempt', async () => {
    const value = scope();
    const owned = maxMuteApiBudgetKeys(value.chatId, value.subjectUserId);
    await redis.set(owned.actor, 'unexpected-key-type');
    const callback = jest.fn();
    await expect(first.run(value, callback)).rejects.toMatchObject({
      reason: 'unavailable',
      preDispatch: true,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(await redis.exists(owned.chat)).toBe(0);
  });

  it('rejects new work after close without creating state', async () => {
    const callback = jest.fn();
    const value = scope();
    await first.close();
    await expect(first.run(value, callback)).rejects.toMatchObject({ reason: 'unavailable' });
    expect(callback).not.toHaveBeenCalled();
    expect(await redis.exists(...keys)).toBe(0);
  });
});
