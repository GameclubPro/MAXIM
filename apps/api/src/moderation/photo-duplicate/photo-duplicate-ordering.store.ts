import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { raceWithTimeout } from '../../common/promise-timeout.util';

const ORDERING_NAMESPACE = 'photo-duplicate:ordering:v1';
const PENDING_TTL_MS = 5 * 60_000;
const COMPLETED_TTL_MS = 7 * 24 * 60 * 60_000;
const LOCK_TTL_MS = 120_000;
const LOCK_HEARTBEAT_MS = 20_000;
const REDIS_OPERATION_TIMEOUT_MS = 3_000;
const CLEANUP_BATCH_SIZE = 100;

const ANNOUNCE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms, 'LIMIT', 0, ARGV[4])
for _, job_id in ipairs(expired) do
  local member = redis.call('HGET', KEYS[3], job_id)
  if member then
    redis.call('ZREM', KEYS[1], member)
    redis.call('HDEL', KEYS[3], job_id)
  end
  redis.call('ZREM', KEYS[2], job_id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', now_ms)

if redis.call('ZSCORE', KEYS[5], ARGV[1]) then
  return {2, ''}
end

local existing = redis.call('HGET', KEYS[3], ARGV[1])
if existing then
  redis.call('ZADD', KEYS[2], now_ms + tonumber(ARGV[3]), ARGV[1])
  return {1, existing}
end

local sequence = redis.call('INCR', KEYS[4])
local member = string.format('%020d', sequence) .. ':' .. ARGV[1]
redis.call('HSET', KEYS[3], ARGV[1], member)
redis.call('ZADD', KEYS[1], ARGV[2], member)
redis.call('ZADD', KEYS[2], now_ms + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]) * 2)
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[3]) * 2)
redis.call('PEXPIRE', KEYS[4], tonumber(ARGV[3]) * 2)
return {1, member}
`;

// FLAG: Redis TIME is checked before SET so a command arriving after the caller deadline cannot
// create an orphan lease. Pending-head verification and lease acquisition must remain atomic.
const CLAIM_TURN_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[4]) then
  return 4
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms, 'LIMIT', 0, ARGV[5])
for _, job_id in ipairs(expired) do
  local member = redis.call('HGET', KEYS[3], job_id)
  if member then
    redis.call('ZREM', KEYS[1], member)
    redis.call('HDEL', KEYS[3], job_id)
  end
  redis.call('ZREM', KEYS[2], job_id)
end

local member = redis.call('HGET', KEYS[3], ARGV[1])
if not member then
  return 3
end
local head = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if head ~= member then
  return 0
end
local acquired = redis.call('SET', KEYS[4], ARGV[2], 'PX', ARGV[3], 'NX')
if acquired then
  return 1
end
return 2
`;

const RENEW_TURN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

const COMPLETE_TURN_SCRIPT = `
if redis.call('GET', KEYS[6]) ~= ARGV[2] then
  return 0
end
local member = redis.call('HGET', KEYS[3], ARGV[1])
if member then
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[3], ARGV[1])
end
redis.call('ZREM', KEYS[2], ARGV[1])
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
redis.call('ZADD', KEYS[5], now_ms + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[5], tonumber(ARGV[3]) + 60000)
redis.call('DEL', KEYS[6])
return 1
`;

const RELEASE_TURN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const ABANDON_SCRIPT = `
local member = redis.call('HGET', KEYS[3], ARGV[1])
if member then
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[3], ARGV[1])
end
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
`;

export type PhotoDuplicateOrderingIdentity = {
  jobId: string;
  chatId: string;
  sourceCreatedAt: string;
};

export type PhotoDuplicateOrderingLease = Readonly<{
  assertOwned: () => void;
}>;

export type PhotoDuplicateOrderingRunResult<T> =
  | { kind: 'completed'; value: T }
  | { kind: 'defer'; reason: 'not_head' | 'busy' | 'deadline' };

export class PhotoDuplicateOrderingUnavailableError extends Error {
  constructor(message = 'Photo duplicate ordering storage is unavailable', options?: ErrorOptions) {
    super(message, options);
    this.name = 'PhotoDuplicateOrderingUnavailableError';
  }
}

export class PhotoDuplicateOrderingLeaseLostError extends Error {
  constructor(options?: ErrorOptions) {
    super('Photo duplicate ordering lease was lost', options);
    this.name = 'PhotoDuplicateOrderingLeaseLostError';
  }
}

type OrderingKeys = ReturnType<typeof buildOrderingKeys>;

@Injectable()
export class PhotoDuplicateOrderingStore implements OnModuleDestroy {
  private readonly logger = new Logger(PhotoDuplicateOrderingStore.name);
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async announce(
    input: PhotoDuplicateOrderingIdentity,
  ): Promise<'registered' | 'completed' | 'unavailable'> {
    const normalized = validateIdentity(input);
    const keys = buildOrderingKeys(normalized.chatId);
    try {
      const response = (await this.runRedisOperation(
        this.redis.eval(
          ANNOUNCE_SCRIPT,
          5,
          keys.pending,
          keys.expiry,
          keys.members,
          keys.sequence,
          keys.completed,
          normalized.jobId,
          String(normalized.sourceCreatedAtMs),
          String(PENDING_TTL_MS),
          String(CLEANUP_BATCH_SIZE),
        ),
      )) as Array<number | string | Buffer>;
      const status = Number(readRedisValue(response[0]));
      return status === 2 ? 'completed' : status === 1 ? 'registered' : 'unavailable';
    } catch {
      this.logger.warn('Photo duplicate pending registration unavailable');
      return 'unavailable';
    }
  }

  async runInOrder<T>(
    input: PhotoDuplicateOrderingIdentity,
    operation: (lease: PhotoDuplicateOrderingLease) => Promise<T>,
  ): Promise<PhotoDuplicateOrderingRunResult<T>> {
    const normalized = validateIdentity(input);
    const announced = await this.announce(input);
    if (announced === 'completed') {
      return { kind: 'completed', value: undefined as T };
    }
    if (announced === 'unavailable') {
      throw new PhotoDuplicateOrderingUnavailableError();
    }

    const keys = buildOrderingKeys(normalized.chatId);
    const token = randomUUID();
    const deadlineAtMs = Date.now() + REDIS_OPERATION_TIMEOUT_MS;
    const claim = await this.claimTurn(keys, normalized.jobId, token, deadlineAtMs);
    if (claim !== 'acquired') {
      if (claim === 'missing') {
        const replay = await this.announce(input);
        if (replay === 'completed') {
          return { kind: 'completed', value: undefined as T };
        }
        throw new PhotoDuplicateOrderingUnavailableError(
          'Photo duplicate pending registration disappeared before execution',
        );
      }
      return {
        kind: 'defer',
        reason: claim === 'not_head' ? 'not_head' : claim === 'busy' ? 'busy' : 'deadline',
      };
    }

    const heartbeat = this.startHeartbeat(keys.lock, token);
    let completed = false;
    try {
      const value = await operation({ assertOwned: heartbeat.assertOwned });
      heartbeat.assertOwned();
      const committed = await this.completeTurn(keys, normalized.jobId, token);
      if (!committed) {
        throw new PhotoDuplicateOrderingLeaseLostError();
      }
      completed = true;
      return { kind: 'completed', value };
    } finally {
      heartbeat.stop();
      if (!completed) {
        await this.releaseTurn(keys.lock, token);
      }
    }
  }

  async abandon(input: PhotoDuplicateOrderingIdentity): Promise<void> {
    const normalized = validateIdentity(input);
    const keys = buildOrderingKeys(normalized.chatId);
    try {
      await this.runRedisOperation(
        this.redis.eval(
          ABANDON_SCRIPT,
          3,
          keys.pending,
          keys.expiry,
          keys.members,
          normalized.jobId,
        ),
      );
    } catch {
      this.logger.warn('Photo duplicate pending job could not be abandoned');
    }
  }

  private async claimTurn(
    keys: OrderingKeys,
    jobId: string,
    token: string,
    deadlineAtMs: number,
  ): Promise<'acquired' | 'not_head' | 'busy' | 'missing' | 'deadline'> {
    try {
      const status = Number(
        await this.runRedisOperation(
          this.redis.eval(
            CLAIM_TURN_SCRIPT,
            4,
            keys.pending,
            keys.expiry,
            keys.members,
            keys.lock,
            jobId,
            token,
            String(LOCK_TTL_MS),
            String(deadlineAtMs),
            String(CLEANUP_BATCH_SIZE),
          ),
        ),
      );
      if (status === 1) return 'acquired';
      if (status === 0) return 'not_head';
      if (status === 2) return 'busy';
      if (status === 3) return 'missing';
      return 'deadline';
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(undefined, { cause: error });
    }
  }

  private async completeTurn(keys: OrderingKeys, jobId: string, token: string): Promise<boolean> {
    try {
      return (
        Number(
          await this.runRedisOperation(
            this.redis.eval(
              COMPLETE_TURN_SCRIPT,
              6,
              keys.pending,
              keys.expiry,
              keys.members,
              keys.sequence,
              keys.completed,
              keys.lock,
              jobId,
              token,
              String(COMPLETED_TTL_MS),
            ),
          ),
        ) === 1
      );
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate ordering completion is unavailable',
        { cause: error },
      );
    }
  }

  private startHeartbeat(
    lockKey: string,
    token: string,
  ): {
    assertOwned: () => void;
    stop: () => void;
  } {
    let stopped = false;
    let leaseLost: unknown = null;
    let conservativeExpiresAtMs = Date.now() + LOCK_TTL_MS;
    let renewalInFlight = false;
    const timer = setInterval(() => {
      if (stopped || renewalInFlight) return;
      renewalInFlight = true;
      const startedAtMs = Date.now();
      void this.runRedisOperation(
        this.redis.eval(RENEW_TURN_SCRIPT, 1, lockKey, token, String(LOCK_TTL_MS)),
      )
        .then((result) => {
          if (Number(result) === 1) {
            conservativeExpiresAtMs = startedAtMs + LOCK_TTL_MS;
          } else {
            leaseLost = new PhotoDuplicateOrderingLeaseLostError();
          }
        })
        .catch((error: unknown) => {
          if (Date.now() >= conservativeExpiresAtMs) {
            leaseLost = error;
          }
        })
        .finally(() => {
          renewalInFlight = false;
        });
    }, LOCK_HEARTBEAT_MS);
    timer.unref();

    return {
      assertOwned: () => {
        if (leaseLost || Date.now() >= conservativeExpiresAtMs) {
          throw new PhotoDuplicateOrderingLeaseLostError(
            leaseLost ? { cause: leaseLost } : undefined,
          );
        }
      },
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async releaseTurn(lockKey: string, token: string): Promise<void> {
    try {
      await this.runRedisOperation(this.redis.eval(RELEASE_TURN_SCRIPT, 1, lockKey, token));
    } catch {
      this.logger.warn('Photo duplicate ordering lease release failed');
    }
  }

  private runRedisOperation<T>(operation: Promise<T>): Promise<T> {
    return raceWithTimeout({
      operation,
      timeoutMs: REDIS_OPERATION_TIMEOUT_MS,
      onTimeout: () => {
        throw new Error('Photo duplicate ordering Redis operation timed out');
      },
    });
  }
}

function validateIdentity(input: PhotoDuplicateOrderingIdentity): {
  jobId: string;
  chatId: string;
  sourceCreatedAtMs: number;
} {
  const jobId = validateIdentifier(input.jobId, 'jobId');
  const chatId = validateIdentifier(input.chatId, 'chatId');
  const sourceCreatedAtMs = Date.parse(input.sourceCreatedAt);
  if (!Number.isSafeInteger(sourceCreatedAtMs) || sourceCreatedAtMs <= 0) {
    throw new Error('sourceCreatedAt is invalid');
  }
  return { jobId, chatId, sourceCreatedAtMs };
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function buildOrderingKeys(chatId: string) {
  const chatHash = createHash('sha256').update(chatId).digest('hex').slice(0, 32);
  const prefix = `${ORDERING_NAMESPACE}:${chatHash}`;
  return {
    pending: `${prefix}:pending`,
    expiry: `${prefix}:expiry`,
    members: `${prefix}:members`,
    sequence: `${prefix}:sequence`,
    completed: `${prefix}:completed`,
    lock: `${prefix}:lock`,
  };
}

function readRedisValue(value: number | string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}
