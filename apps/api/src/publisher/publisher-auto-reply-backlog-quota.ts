import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';

const BACKLOG_COMMAND_TIMEOUT_MS = 250;
// BullMQ's non-blocking producer connection allows 20 retries. Its 10s connect
// timeout plus the capped reconnect backoff stays below 10 minutes; the lease
// must outlive that window so a queued add cannot commit after its slot expires.
const BACKLOG_INFLIGHT_LEASE_TTL_MS = 10 * 60_000;

function buildBacklogRedisOptions(commandTimeoutMs: number) {
  return {
    commandTimeout: commandTimeoutMs,
    connectTimeout: Math.max(250, commandTimeoutMs),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  } as const;
}

const PREFLIGHT_SCRIPT = `
-- MAXIM_PUBLISHER_AUTO_REPLY_BACKLOG_PREFLIGHT_V2
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[1]) then
  return {-2, 0, 0}
end
local limit = tonumber(ARGV[2])
if not limit or limit < 1 then
  return {-1, 0, 0}
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

-- BullMQ can keep a deprecated marker in wait/paused. Counting every list entry
-- is deliberately conservative: a marker can reduce capacity by one, never
-- allow the live queue to cross the configured ceiling.
local live_backlog = redis.call('LLEN', KEYS[2])
  + redis.call('LLEN', KEYS[3])
  + redis.call('LLEN', KEYS[4])
  + redis.call('ZCARD', KEYS[5])
  + redis.call('ZCARD', KEYS[6])
  + redis.call('ZCARD', KEYS[7])
local lease_count = redis.call('ZCARD', KEYS[1])
if live_backlog + lease_count >= limit then
  return {0, live_backlog, lease_count}
end
return {1, live_backlog, lease_count}
`;

const CLAIM_INFLIGHT_SCRIPT = `
-- MAXIM_PUBLISHER_AUTO_REPLY_BACKLOG_CLAIM_V2
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[1]) then
  return {-2, '', 0, 0}
end
local lease_ttl_ms = tonumber(ARGV[4])
local limit = tonumber(ARGV[5])
if not lease_ttl_ms or lease_ttl_ms < 1 or not limit or limit < 1 then
  return {-1, '', 0, 0}
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now_ms)

local live_backlog = redis.call('LLEN', KEYS[3])
  + redis.call('LLEN', KEYS[4])
  + redis.call('LLEN', KEYS[5])
  + redis.call('ZCARD', KEYS[6])
  + redis.call('ZCARD', KEYS[7])
  + redis.call('ZCARD', KEYS[8])
local lease_count = redis.call('ZCARD', KEYS[1])
local existing_score = redis.call('ZSCORE', KEYS[1], ARGV[2])
if existing_score then
  redis.call('SADD', KEYS[2], ARGV[3])
  redis.call('PEXPIRE', KEYS[2], lease_ttl_ms)
  redis.call('ZADD', KEYS[1], now_ms + lease_ttl_ms, ARGV[2])
  redis.call('PEXPIRE', KEYS[1], lease_ttl_ms * 2)
  return {2, ARGV[3], live_backlog, lease_count}
end

-- The per-operation attempt set expires independently. If its ZSET lease is
-- gone, any remaining set belongs to an expired generation and is fenced out.
redis.call('DEL', KEYS[2])
if live_backlog + lease_count >= limit then
  return {0, '', live_backlog, lease_count}
end

redis.call('SADD', KEYS[2], ARGV[3])
redis.call('PEXPIRE', KEYS[2], lease_ttl_ms)
redis.call('ZADD', KEYS[1], now_ms + lease_ttl_ms, ARGV[2])
redis.call('PEXPIRE', KEYS[1], lease_ttl_ms * 2)
return {1, ARGV[3], live_backlog, lease_count + 1}
`;

const RELEASE_INFLIGHT_SCRIPT = `
-- MAXIM_PUBLISHER_AUTO_REPLY_BACKLOG_RELEASE_V2
local removed = redis.call('SREM', KEYS[2], ARGV[2])
if removed == 1 and redis.call('SCARD', KEYS[2]) == 0 then
  redis.call('DEL', KEYS[2])
  redis.call('ZREM', KEYS[1], ARGV[1])
end
return removed
`;

type RedisEvalClient = {
  status?: string;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
};

export type PublisherAutoReplyBacklogQuotaFailureReason = 'limit' | 'unavailable';

export type PublisherAutoReplyBacklogClaim = {
  operationId: string;
  attemptToken: string;
};

export type PublisherAutoReplyBacklogQuotaOptions = {
  commandTimeoutMs?: number;
  inflightLeaseTtlMs?: number;
  redisUrl?: string;
};

export class PublisherAutoReplyBacklogQuotaError extends Error {
  constructor(readonly reason: PublisherAutoReplyBacklogQuotaFailureReason) {
    super(`Publisher auto-reply backlog quota failed: ${reason}`);
    this.name = 'PublisherAutoReplyBacklogQuotaError';
  }
}

export class PublisherAutoReplyBacklogQuota {
  private readonly inflightKey: string;
  private readonly liveQueueKeys: readonly string[];
  private readonly commandTimeoutMs: number;
  private readonly inflightLeaseTtlMs: number;
  private readonly ownedRedis: Redis | null;

  constructor(
    private readonly queue: Queue,
    private readonly limit: number,
    options: PublisherAutoReplyBacklogQuotaOptions = {},
  ) {
    this.inflightKey = queue.toKey('auto-reply-backlog-inflight');
    this.liveQueueKeys = [
      queue.keys.wait,
      queue.keys.paused,
      queue.keys.active,
      queue.keys.delayed,
      queue.keys.prioritized,
      queue.keys['waiting-children'],
    ];
    if (
      !this.inflightKey ||
      this.liveQueueKeys.some((key) => typeof key !== 'string' || key.length === 0)
    ) {
      throw new Error('Publisher auto-reply backlog quota requires every BullMQ queue key');
    }
    this.commandTimeoutMs = this.readPositiveInt(
      options.commandTimeoutMs,
      BACKLOG_COMMAND_TIMEOUT_MS,
      'commandTimeoutMs',
    );
    this.inflightLeaseTtlMs = this.readPositiveInt(
      options.inflightLeaseTtlMs,
      BACKLOG_INFLIGHT_LEASE_TTL_MS,
      'inflightLeaseTtlMs',
    );
    const redisUrl = options.redisUrl?.trim() ?? '';
    this.ownedRedis = redisUrl
      ? new Redis(redisUrl, buildBacklogRedisOptions(this.commandTimeoutMs))
      : null;
    this.ownedRedis?.on('error', () => undefined);
  }

  async close(): Promise<void> {
    if (!this.ownedRedis) {
      return;
    }
    if (this.ownedRedis.status === 'ready') {
      try {
        await this.ownedRedis.quit();
        this.ownedRedis.disconnect(false);
        return;
      } catch {
        // Fall through to a local disconnect when Redis cannot acknowledge QUIT.
      }
    }
    this.ownedRedis.disconnect(false);
  }

  async assertAvailable(): Promise<void> {
    const raw = await this.evaluate(
      PREFLIGHT_SCRIPT,
      [this.inflightKey, ...this.liveQueueKeys],
      [Date.now() + this.commandTimeoutMs, this.limit],
    );
    const status = this.readStatus(raw);
    if (status === 0) {
      throw new PublisherAutoReplyBacklogQuotaError('limit');
    }
    if (status !== 1) {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
  }

  async claimInflight(operationIdentity: string): Promise<PublisherAutoReplyBacklogClaim> {
    const operationId = this.digestOperationIdentity(operationIdentity);
    const attemptToken = randomUUID();
    const attemptKey = this.queue.toKey(`auto-reply-backlog-attempts:${operationId}`);
    let raw: unknown[];
    try {
      raw = await this.evaluate(
        CLAIM_INFLIGHT_SCRIPT,
        [this.inflightKey, attemptKey, ...this.liveQueueKeys],
        [
          Date.now() + this.commandTimeoutMs,
          operationId,
          attemptToken,
          this.inflightLeaseTtlMs,
          this.limit,
        ],
      );
    } catch (error: unknown) {
      // EVAL may have committed before its response timed out. The exact
      // attempt fence makes this cleanup harmless when the claim never landed.
      await this.releaseAttempt({ operationId, attemptToken }).catch(() => undefined);
      throw error;
    }
    const status = this.readStatus(raw);
    if (status === 0) {
      throw new PublisherAutoReplyBacklogQuotaError('limit');
    }
    if (status !== 1 && status !== 2) {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
    if (String(raw[1] ?? '') !== attemptToken) {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
    return { operationId, attemptToken };
  }

  async release(claim: PublisherAutoReplyBacklogClaim): Promise<void> {
    const operationId = this.requireIdentity(claim.operationId, 'operationId');
    const attemptToken = this.requireIdentity(claim.attemptToken, 'attemptToken');
    await this.releaseAttempt({ operationId, attemptToken });
  }

  private async releaseAttempt(claim: PublisherAutoReplyBacklogClaim): Promise<void> {
    const { operationId, attemptToken } = claim;
    const attemptKey = this.queue.toKey(`auto-reply-backlog-attempts:${operationId}`);
    const client = await this.redisClient();
    await this.withTimeout(
      client.eval(
        RELEASE_INFLIGHT_SCRIPT,
        2,
        this.inflightKey,
        attemptKey,
        operationId,
        attemptToken,
      ),
    );
  }

  private async evaluate(
    script: string,
    keys: readonly string[],
    args: ReadonlyArray<string | number>,
  ): Promise<unknown[]> {
    try {
      const client = await this.redisClient();
      const raw = await this.withTimeout(client.eval(script, keys.length, ...keys, ...args));
      if (!Array.isArray(raw) || raw.length < 1) {
        throw new Error('Redis returned an invalid Publisher auto-reply backlog quota result');
      }
      return raw;
    } catch (error: unknown) {
      if (error instanceof PublisherAutoReplyBacklogQuotaError) {
        throw error;
      }
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
  }

  private readStatus(raw: unknown[]): number {
    const status = Number(raw[0]);
    if (!Number.isSafeInteger(status)) {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
    return status;
  }

  private digestOperationIdentity(value: string): string {
    const identity = this.requireIdentity(value, 'operationIdentity');
    return createHash('sha256').update(identity).digest('hex').slice(0, 32);
  }

  private requireIdentity(value: string, label: string): string {
    const normalized = value.trim();
    if (!normalized) {
      throw new Error(`Publisher auto-reply backlog quota ${label} is required`);
    }
    return normalized;
  }

  private async redisClient(): Promise<RedisEvalClient> {
    const client = this.ownedRedis
      ? (this.ownedRedis as RedisEvalClient)
      : ((await this.withTimeout(this.queue.client)) as unknown as RedisEvalClient);
    if (client.status && client.status !== 'ready') {
      await this.waitForReady(client);
    }
    if (client.status && client.status !== 'ready') {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
    return client;
  }

  private async waitForReady(client: RedisEvalClient): Promise<void> {
    const eventClient = client as RedisEvalClient & {
      once?: (event: string, listener: () => void) => unknown;
      off?: (event: string, listener: () => void) => unknown;
    };
    if (typeof eventClient.once !== 'function' || typeof eventClient.off !== 'function') {
      throw new PublisherAutoReplyBacklogQuotaError('unavailable');
    }
    await this.withTimeout(
      new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          eventClient.off?.('ready', onReady);
          eventClient.off?.('end', onEnd);
        };
        const onReady = () => {
          cleanup();
          resolve();
        };
        const onEnd = () => {
          cleanup();
          reject(new Error('Publisher auto-reply backlog Redis closed before ready'));
        };
        eventClient.once?.('ready', onReady);
        eventClient.once?.('end', onEnd);
        if (eventClient.status === 'ready') {
          onReady();
        } else if (eventClient.status === 'end') {
          onEnd();
        }
      }),
    );
  }

  private readPositiveInt(value: number | undefined, fallback: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < 1) {
      throw new Error(`Publisher auto-reply backlog quota ${label} must be a positive integer`);
    }
    return resolved;
  }

  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Publisher auto-reply backlog quota command timed out')),
            this.commandTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

export const PUBLISHER_AUTO_REPLY_BACKLOG_QUOTA_TESTING = Object.freeze({
  inflightLeaseTtlMs: BACKLOG_INFLIGHT_LEASE_TTL_MS,
  preflightScript: PREFLIGHT_SCRIPT,
  claimScript: CLAIM_INFLIGHT_SCRIPT,
  releaseScript: RELEASE_INFLIGHT_SCRIPT,
  redisOptions: buildBacklogRedisOptions(BACKLOG_COMMAND_TIMEOUT_MS),
});
