import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { normalizePhotoDuplicateActionEligibility } from './photo-duplicate.queue';

const ORDERING_NAMESPACE = 'photo-duplicate:ordering:v2';
export const DUPLICATE_JOB_MAX_LIFETIME_MS = 10 * 60_000;
const PENDING_RECOVERY_GRACE_MS = 60_000;
const COMPLETED_TTL_MS = 7 * 24 * 60 * 60_000;
const AUTHORITY_TTL_MS = COMPLETED_TTL_MS;
const ORDERING_RECOVERY_WAKEUP_MS = 30_000;
const LOCK_TTL_MS = 120_000;
const LOCK_HEARTBEAT_MS = 20_000;
const REDIS_OPERATION_TIMEOUT_MS = 3_000;
const CLEANUP_BATCH_SIZE = 100;

// FLAG: Membership cleanup must never delete authority. Only trusted initial admission may mint
// true; retries with a missing permit stay false, and every replay preserves the first deadline.
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
  redis.call('HDEL', KEYS[7], job_id, job_id .. ':explicit')
end
local completed_expired = redis.call('ZRANGEBYSCORE', KEYS[5], '-inf', now_ms, 'LIMIT', 0, ARGV[4])
for _, job_id in ipairs(completed_expired) do
  redis.call('ZREM', KEYS[5], job_id)
end

local incoming_action_eligible = ARGV[5] == '1' and '1' or '0'
local existing = redis.call('HGET', KEYS[3], ARGV[1])
local stored_action_eligible = redis.call('HGET', KEYS[6], 'eligible')
local admitted_at_ms = tonumber(redis.call('HGET', KEYS[6], 'admittedAtMs')) or now_ms
local deadline_at_ms = math.min(tonumber(redis.call('HGET', KEYS[6], 'deadlineAtMs')) or (now_ms + tonumber(ARGV[8])), tonumber(ARGV[3]))
local effective_action_eligible = '0'
if not stored_action_eligible and ARGV[6] == 'initial' then
  effective_action_eligible = incoming_action_eligible
elseif stored_action_eligible == '1' and incoming_action_eligible == '1' then
  effective_action_eligible = '1'
end
if deadline_at_ms <= now_ms then effective_action_eligible = '0' end
redis.call('HSET', KEYS[6], 'eligible', effective_action_eligible, 'admittedAtMs', admitted_at_ms, 'deadlineAtMs', deadline_at_ms)
if redis.call('PTTL', KEYS[6]) < 0 then redis.call('PEXPIRE', KEYS[6], ARGV[7]) end

if redis.call('ZSCORE', KEYS[5], ARGV[1]) then
  return {2, '', effective_action_eligible, tostring(admitted_at_ms), tostring(deadline_at_ms)}
end
if deadline_at_ms <= now_ms then
  return {3, '', '0', tostring(admitted_at_ms), tostring(deadline_at_ms)}
end
if existing then
  return {1, existing, effective_action_eligible, tostring(admitted_at_ms), tostring(deadline_at_ms)}
end

local sequence = redis.call('INCR', KEYS[4])
local member = string.format('%020d', sequence) .. ':' .. ARGV[1]
redis.call('HSET', KEYS[3], ARGV[1], member)
redis.call('ZADD', KEYS[1], ARGV[2], member)
redis.call('ZADD', KEYS[2], deadline_at_ms + tonumber(ARGV[9]), ARGV[1])
for _, key in ipairs({KEYS[1], KEYS[2], KEYS[3], KEYS[4], KEYS[7]}) do
  redis.call('PEXPIRE', key, tonumber(ARGV[8]) + tonumber(ARGV[9]) * 2)
end
return {1, member, effective_action_eligible, tostring(admitted_at_ms), tostring(deadline_at_ms)}
`;

// FLAG: Redis TIME is checked before SET so a command arriving after the caller deadline cannot
// create an orphan lease. Pending-head verification, latch read, and lease acquisition must remain
// atomic.
const CLAIM_TURN_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[4]) then
  return {4, '0'}
end

local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms, 'LIMIT', 0, ARGV[5])
for _, job_id in ipairs(expired) do
  local member = redis.call('HGET', KEYS[3], job_id)
  if member then
    redis.call('ZREM', KEYS[1], member)
    redis.call('HDEL', KEYS[3], job_id)
  end
  redis.call('ZREM', KEYS[2], job_id)
  redis.call('HDEL', KEYS[6], job_id, job_id .. ':explicit')
end

local member = redis.call('HGET', KEYS[3], ARGV[1])
if not member then
  return {3, '0'}
end
local head = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if head ~= member then
  local head_id = head and string.sub(head, 22) or ''
  local head_next = tonumber(redis.call('HGET', KEYS[6], head_id)) or (now_ms + tonumber(ARGV[6]))
  if head_next <= now_ms then head_next = now_ms + tonumber(ARGV[6]) end
  local head_expiry = tonumber(redis.call('ZSCORE', KEYS[2], head_id))
  if head_expiry then head_next = math.min(head_next, head_expiry) end
  return {0, '0', tostring(math.max(now_ms + 1000, head_next))}
end
local next_eligible = tonumber(redis.call('HGET', KEYS[6], ARGV[1])) or 0
if next_eligible > now_ms then return {5, '0', tostring(next_eligible)} end
local action_eligible = redis.call('HGET', KEYS[5], 'eligible') == '1' and '1' or '0'
local job_deadline = tonumber(redis.call('HGET', KEYS[5], 'deadlineAtMs')) or 0
if job_deadline <= now_ms then return {6, '0'} end
local acquired = redis.call('SET', KEYS[4], ARGV[2], 'PX', ARGV[3], 'NX')
if acquired then
  redis.call('HSET', KEYS[6], ARGV[1], now_ms + tonumber(ARGV[6]))
  redis.call('HDEL', KEYS[6], ARGV[1] .. ':explicit')
  redis.call('PEXPIRE', KEYS[6], ARGV[7])
  return {1, action_eligible}
end
return {2, '0', tostring(now_ms + tonumber(ARGV[6]))}
`;

// FLAG: The token fence and absorbing latch must be read in one Redis script. A lost token is a
// retryable lease error; a valid token with a false latch blocks counters and moderation actions.
const RESOLVE_ACTION_ELIGIBILITY_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return {0, '0'}
end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local deadline_at_ms = tonumber(redis.call('HGET', KEYS[2], 'deadlineAtMs')) or 0
local action_eligible = redis.call('HGET', KEYS[2], 'eligible') == '1' and deadline_at_ms > now_ms and '1' or '0'
return {1, action_eligible}
`;

const READ_ACTION_ELIGIBILITY_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local deadline_at_ms = tonumber(redis.call('HGET', KEYS[1], 'deadlineAtMs')) or 0
return redis.call('HGET', KEYS[1], 'eligible') == '1' and deadline_at_ms > now_ms and 1 or 0
`;

// FLAG: An eligibility revocation must never register work or become a phantom chat head.
const REVOKE_ACTION_ELIGIBILITY_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local admitted_at_ms = tonumber(redis.call('HGET', KEYS[1], 'admittedAtMs')) or now_ms
local deadline_at_ms = tonumber(redis.call('HGET', KEYS[1], 'deadlineAtMs')) or math.min(now_ms + tonumber(ARGV[2]), tonumber(ARGV[1]))
redis.call('HSET', KEYS[1], 'eligible', '0', 'admittedAtMs', admitted_at_ms, 'deadlineAtMs', deadline_at_ms)
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 1
`;

// FLAG: A follower may become head while its Bull job is still active and cannot be promoted.
// Clear only inherited waits for an unlocked current head; explicit deferrals retain authority.
const POSTPONE_SCRIPT = `
local member = redis.call('HGET', KEYS[1], ARGV[1])
if not member then return ARGV[2] end
local deadline_at_ms = tonumber(redis.call('HGET', KEYS[3], 'deadlineAtMs')) or 0
local existing_explicit = redis.call('HGET', KEYS[2], ARGV[1] .. ':explicit') == '1'
local next_eligible = math.min(tonumber(ARGV[2]), deadline_at_ms)
if ARGV[4] == 'ordering' and not existing_explicit and
    redis.call('ZRANGE', KEYS[4], 0, 0)[1] == member and redis.call('EXISTS', KEYS[5]) == 0 then
  local redis_time = redis.call('TIME')
  local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
  next_eligible = math.min(next_eligible, now_ms)
end
if ARGV[4] == 'head' or not existing_explicit then
  redis.call('HSET', KEYS[2], ARGV[1], next_eligible, ARGV[1] .. ':explicit', ARGV[4] == 'head' and '1' or '0')
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
else
  next_eligible = math.min(tonumber(redis.call('HGET', KEYS[2], ARGV[1])) or next_eligible, deadline_at_ms)
end
return tostring(next_eligible)
`;

const RENEW_TURN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

// FLAG: Only inherited follower wakeups may be advanced. A head's explicit media/governor
// deferral remains authoritative even when another preceding job completes or is abandoned.
const NEXT_TURN_SCRIPT = `
local function next_turn(pending_key, wakeup_key)
  local head = redis.call('ZRANGE', pending_key, 0, 0)[1]
  if not head then return {1, '', '0'} end
  local job_id = string.sub(head, 22)
  local redis_time = redis.call('TIME')
  local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
  local next_eligible = tonumber(redis.call('HGET', wakeup_key, job_id)) or now_ms
  if redis.call('HGET', wakeup_key, job_id .. ':explicit') ~= '1' or next_eligible <= now_ms then
    redis.call('HDEL', wakeup_key, job_id, job_id .. ':explicit')
    next_eligible = now_ms
  end
  return {1, job_id, tostring(next_eligible)}
end
`;

const COMPLETE_TURN_SCRIPT = `${NEXT_TURN_SCRIPT}
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
redis.call('HDEL', KEYS[7], ARGV[1], ARGV[1] .. ':explicit')
redis.call('DEL', KEYS[6])
return next_turn(KEYS[1], KEYS[7])
`;

const RELEASE_TURN_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('HDEL', KEYS[2], ARGV[2], ARGV[2] .. ':explicit')
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const ABANDON_SCRIPT = `${NEXT_TURN_SCRIPT}
local member = redis.call('HGET', KEYS[3], ARGV[1])
if member then
  redis.call('ZREM', KEYS[1], member)
  redis.call('HDEL', KEYS[3], ARGV[1])
end
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[4], 'eligible', '0')
if redis.call('PTTL', KEYS[4]) < 0 then redis.call('PEXPIRE', KEYS[4], ARGV[2]) end
redis.call('HDEL', KEYS[5], ARGV[1], ARGV[1] .. ':explicit')
return next_turn(KEYS[1], KEYS[5])
`;

export type PhotoDuplicateOrderingIdentity = {
  jobId: string;
  chatId: string;
  sourceCreatedAt: string;
  deadlineAtMs?: number;
};

export type PhotoDuplicateOrderingLease = Readonly<{
  assertOwned: () => void;
  resolveActionEligibility: () => Promise<boolean>;
}>;

export type PhotoDuplicateOrderingNextTurn = Readonly<{ jobId: string; nextEligibleAtMs: number }>;

export type PhotoDuplicateOrderingRunResult<T> =
  | { kind: 'completed'; value: T; next?: PhotoDuplicateOrderingNextTurn }
  | {
      kind: 'defer';
      reason: 'not_head' | 'busy' | 'deadline' | 'expired' | 'scheduled';
      nextEligibleAtMs: number;
    };

export type PhotoDuplicateOrderingAnnouncement =
  | { kind: 'registered'; actionEligible: boolean; admittedAtMs: number; deadlineAtMs: number }
  | { kind: 'completed' }
  | { kind: 'expired' }
  | { kind: 'unavailable' };

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
  protected readonly namespace: string = ORDERING_NAMESPACE;
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
    actionEligible: unknown,
    registration: 'initial' | 'retry' = 'initial',
  ): Promise<PhotoDuplicateOrderingAnnouncement> {
    const normalized = validateIdentity(input);
    const normalizedActionEligible = normalizePhotoDuplicateActionEligibility(actionEligible);
    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    try {
      const response = (await this.runRedisOperation(
        this.redis.eval(
          ANNOUNCE_SCRIPT,
          7,
          keys.pending,
          keys.expiry,
          keys.members,
          keys.sequence,
          keys.completed,
          keys.permit,
          keys.nextEligible,
          normalized.jobId,
          String(normalized.sourceCreatedAtMs),
          String(normalized.deadlineAtMs ?? Date.now() + DUPLICATE_JOB_MAX_LIFETIME_MS),
          String(CLEANUP_BATCH_SIZE),
          normalizedActionEligible ? '1' : '0',
          registration,
          String(AUTHORITY_TTL_MS),
          String(DUPLICATE_JOB_MAX_LIFETIME_MS),
          String(PENDING_RECOVERY_GRACE_MS),
        ),
      )) as Array<number | string | Buffer>;
      const status = Number(readRedisValue(response[0]));
      if (status === 2) return { kind: 'completed' };
      if (status === 3) return { kind: 'expired' };
      if (status === 1) {
        const admittedAtMs = Number(readRedisValue(response[3]));
        const deadlineAtMs = Number(readRedisValue(response[4]));
        if (!Number.isSafeInteger(admittedAtMs) || !Number.isSafeInteger(deadlineAtMs)) {
          return { kind: 'unavailable' };
        }
        return {
          kind: 'registered',
          actionEligible: readRedisValue(response[2]) === '1',
          admittedAtMs,
          deadlineAtMs,
        };
      }
      return { kind: 'unavailable' };
    } catch {
      this.logger.warn('Photo duplicate pending registration unavailable');
      return { kind: 'unavailable' };
    }
  }

  async runInOrder<T>(
    input: PhotoDuplicateOrderingIdentity,
    actionEligible: unknown,
    operation: (lease: PhotoDuplicateOrderingLease, actionEligible: boolean) => Promise<T>,
  ): Promise<PhotoDuplicateOrderingRunResult<T>> {
    const normalized = validateIdentity(input);
    const normalizedActionEligible = normalizePhotoDuplicateActionEligibility(actionEligible);
    const announced = await this.announce(input, normalizedActionEligible, 'retry');
    if (announced.kind === 'completed') {
      return { kind: 'completed', value: undefined as T };
    }
    if (announced.kind === 'unavailable') {
      throw new PhotoDuplicateOrderingUnavailableError();
    }
    if (announced.kind === 'expired') {
      return { kind: 'defer', reason: 'expired', nextEligibleAtMs: Date.now() };
    }

    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    const token = randomUUID();
    const deadlineAtMs = Date.now() + REDIS_OPERATION_TIMEOUT_MS;
    const claim = await this.claimTurn(keys, normalized.jobId, token, deadlineAtMs);
    if (claim.kind !== 'acquired') {
      if (claim.kind === 'missing') {
        const replay = await this.announce(input, normalizedActionEligible, 'retry');
        if (replay.kind === 'completed') {
          return { kind: 'completed', value: undefined as T };
        }
        throw new PhotoDuplicateOrderingUnavailableError(
          'Photo duplicate pending registration disappeared before execution',
        );
      }
      return {
        kind: 'defer',
        reason:
          claim.kind === 'not_head'
            ? 'not_head'
            : claim.kind === 'busy'
              ? 'busy'
              : claim.kind === 'scheduled'
                ? 'scheduled'
                : claim.kind === 'expired'
                  ? 'expired'
                  : 'deadline',
        nextEligibleAtMs: claim.nextEligibleAtMs,
      };
    }

    const heartbeat = this.startHeartbeat(keys.lock, token);
    const lease = Object.freeze({
      assertOwned: heartbeat.assertOwned,
      resolveActionEligibility: async () => {
        heartbeat.assertOwned();
        const actionEligible = await this.resolveActionEligibility(
          keys.lock,
          keys.permit,
          normalized.jobId,
          token,
        );
        heartbeat.assertOwned();
        return actionEligible;
      },
    }) satisfies PhotoDuplicateOrderingLease;
    let completed = false;
    try {
      const value = await operation(lease, claim.actionEligible);
      heartbeat.assertOwned();
      const completion = await this.completeTurn(keys, normalized.jobId, token);
      if (!completion.committed) {
        throw new PhotoDuplicateOrderingLeaseLostError();
      }
      completed = true;
      return { kind: 'completed', value, ...(completion.next ? { next: completion.next } : {}) };
    } finally {
      heartbeat.stop();
      if (!completed) {
        await this.releaseTurn(keys.lock, keys.nextEligible, normalized.jobId, token);
      }
    }
  }

  async abandon(
    input: PhotoDuplicateOrderingIdentity,
  ): Promise<PhotoDuplicateOrderingNextTurn | undefined> {
    const normalized = validateIdentity(input);
    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    try {
      const response = await this.runRedisOperation(
        this.redis.eval(
          ABANDON_SCRIPT,
          5,
          keys.pending,
          keys.expiry,
          keys.members,
          keys.permit,
          keys.nextEligible,
          normalized.jobId,
          String(AUTHORITY_TTL_MS),
        ),
      );
      return parseTurnCompletion(response).next;
    } catch {
      this.logger.warn('Photo duplicate pending job could not be abandoned');
    }
  }

  async readActionEligibility(input: PhotoDuplicateOrderingIdentity): Promise<boolean> {
    const normalized = validateIdentity(input);
    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    try {
      return (
        Number(
          await this.runRedisOperation(
            this.redis.eval(READ_ACTION_ELIGIBILITY_SCRIPT, 1, keys.permit),
          ),
        ) === 1
      );
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate action eligibility confirmation is unavailable',
        { cause: error },
      );
    }
  }

  async revokeActionEligibility(input: PhotoDuplicateOrderingIdentity): Promise<void> {
    const normalized = validateIdentity(input);
    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    try {
      await this.runRedisOperation(
        this.redis.eval(
          REVOKE_ACTION_ELIGIBILITY_SCRIPT,
          1,
          keys.permit,
          String(
            Math.min(
              normalized.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
              normalized.sourceCreatedAtMs + DUPLICATE_JOB_MAX_LIFETIME_MS,
            ),
          ),
          String(DUPLICATE_JOB_MAX_LIFETIME_MS),
          String(AUTHORITY_TTL_MS),
        ),
      );
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate action eligibility revocation is unavailable',
        { cause: error },
      );
    }
  }

  async postpone(
    input: PhotoDuplicateOrderingIdentity,
    nextEligibleAtMs: number,
    kind: 'head' | 'ordering' = 'head',
  ): Promise<number> {
    const normalized = validateIdentity(input);
    if (!Number.isSafeInteger(nextEligibleAtMs) || nextEligibleAtMs <= 0)
      throw new Error('nextEligibleAtMs is invalid');
    const keys = buildOrderingKeys(normalized.chatId, normalized.jobId, this.namespace);
    try {
      const response = await this.runRedisOperation(
        this.redis.eval(
          POSTPONE_SCRIPT,
          5,
          keys.members,
          keys.nextEligible,
          keys.permit,
          keys.pending,
          keys.lock,
          normalized.jobId,
          String(nextEligibleAtMs),
          String(DUPLICATE_JOB_MAX_LIFETIME_MS + PENDING_RECOVERY_GRACE_MS * 2),
          kind,
        ),
      );
      if (
        typeof response !== 'number' &&
        typeof response !== 'string' &&
        !Buffer.isBuffer(response)
      )
        throw new Error('Invalid photo duplicate ordering wakeup');
      const effectiveNextEligibleAtMs = Number(readRedisValue(response));
      if (!Number.isSafeInteger(effectiveNextEligibleAtMs) || effectiveNextEligibleAtMs <= 0)
        throw new Error('Invalid photo duplicate ordering wakeup');
      return effectiveNextEligibleAtMs;
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate ordering wakeup is unavailable',
        { cause: error },
      );
    }
  }

  private async claimTurn(
    keys: OrderingKeys,
    jobId: string,
    token: string,
    deadlineAtMs: number,
  ): Promise<
    | { kind: 'acquired'; actionEligible: boolean }
    | {
        kind: 'not_head' | 'busy' | 'missing' | 'deadline' | 'expired' | 'scheduled';
        nextEligibleAtMs: number;
      }
  > {
    try {
      const response = (await this.runRedisOperation(
        this.redis.eval(
          CLAIM_TURN_SCRIPT,
          6,
          keys.pending,
          keys.expiry,
          keys.members,
          keys.lock,
          keys.permit,
          keys.nextEligible,
          jobId,
          token,
          String(LOCK_TTL_MS),
          String(deadlineAtMs),
          String(CLEANUP_BATCH_SIZE),
          String(ORDERING_RECOVERY_WAKEUP_MS),
          String(DUPLICATE_JOB_MAX_LIFETIME_MS + PENDING_RECOVERY_GRACE_MS * 2),
        ),
      )) as Array<number | string | Buffer>;
      const status = Number(readRedisValue(response[0]));
      if (status === 1) {
        return { kind: 'acquired', actionEligible: readRedisValue(response[1]) === '1' };
      }
      const nextEligibleAtMs =
        Number(readRedisValue(response[2])) || Date.now() + ORDERING_RECOVERY_WAKEUP_MS;
      if (status === 0) return { kind: 'not_head', nextEligibleAtMs };
      if (status === 2) return { kind: 'busy', nextEligibleAtMs };
      if (status === 3) return { kind: 'missing', nextEligibleAtMs };
      if (status === 5) return { kind: 'scheduled', nextEligibleAtMs };
      if (status === 6) return { kind: 'expired', nextEligibleAtMs: Date.now() };
      return { kind: 'deadline', nextEligibleAtMs };
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(undefined, { cause: error });
    }
  }

  private async completeTurn(
    keys: OrderingKeys,
    jobId: string,
    token: string,
  ): Promise<{ committed: boolean; next?: PhotoDuplicateOrderingNextTurn }> {
    try {
      return parseTurnCompletion(
        await this.runRedisOperation(
          this.redis.eval(
            COMPLETE_TURN_SCRIPT,
            7,
            keys.pending,
            keys.expiry,
            keys.members,
            keys.sequence,
            keys.completed,
            keys.lock,
            keys.nextEligible,
            jobId,
            token,
            String(COMPLETED_TTL_MS),
          ),
        ),
      );
    } catch (error: unknown) {
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate ordering completion is unavailable',
        { cause: error },
      );
    }
  }

  private async resolveActionEligibility(
    lockKey: string,
    actionEligibilityKey: string,
    jobId: string,
    token: string,
  ): Promise<boolean> {
    try {
      const response = (await this.runRedisOperation(
        this.redis.eval(
          RESOLVE_ACTION_ELIGIBILITY_SCRIPT,
          2,
          lockKey,
          actionEligibilityKey,
          token,
          jobId,
        ),
      )) as Array<number | string | Buffer>;
      const status = readRedisValue(response[0]);
      const actionEligible = readRedisValue(response[1]);
      if (status === '0') {
        throw new PhotoDuplicateOrderingLeaseLostError();
      }
      if (status !== '1' || (actionEligible !== '0' && actionEligible !== '1')) {
        throw new Error('Photo duplicate action eligibility response is invalid');
      }
      return actionEligible === '1';
    } catch (error: unknown) {
      if (error instanceof PhotoDuplicateOrderingLeaseLostError) {
        throw error;
      }
      throw new PhotoDuplicateOrderingUnavailableError(
        'Photo duplicate action eligibility confirmation is unavailable',
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

  private async releaseTurn(
    lockKey: string,
    nextEligibleKey: string,
    jobId: string,
    token: string,
  ): Promise<void> {
    try {
      await this.runRedisOperation(
        this.redis.eval(RELEASE_TURN_SCRIPT, 2, lockKey, nextEligibleKey, token, jobId),
      );
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
  deadlineAtMs?: number;
} {
  const jobId = validateIdentifier(input.jobId, 'jobId');
  const chatId = validateIdentifier(input.chatId, 'chatId');
  const sourceCreatedAtMs = Date.parse(input.sourceCreatedAt);
  if (!Number.isSafeInteger(sourceCreatedAtMs) || sourceCreatedAtMs <= 0) {
    throw new Error('sourceCreatedAt is invalid');
  }
  if (
    input.deadlineAtMs !== undefined &&
    (!Number.isSafeInteger(input.deadlineAtMs) || input.deadlineAtMs <= 0)
  ) {
    throw new Error('deadlineAtMs is invalid');
  }
  return { jobId, chatId, sourceCreatedAtMs, deadlineAtMs: input.deadlineAtMs };
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function buildOrderingKeys(chatId: string, jobId: string, namespace = ORDERING_NAMESPACE) {
  const chatHash = createHash('sha256').update(chatId).digest('hex').slice(0, 32);
  const prefix = `${namespace}:${chatHash}`;
  return {
    pending: `${prefix}:pending`,
    expiry: `${prefix}:expiry`,
    members: `${prefix}:members`,
    sequence: `${prefix}:sequence`,
    completed: `${prefix}:completed`,
    lock: `${prefix}:lock`,
    permit: `${prefix}:permit:${createHash('sha256').update(jobId).digest('hex')}`,
    nextEligible: `${prefix}:next-eligible`,
  };
}

function readRedisValue(value: number | string | Buffer | undefined): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}

function parseTurnCompletion(response: unknown): {
  committed: boolean;
  next?: PhotoDuplicateOrderingNextTurn;
} {
  const values = Array.isArray(response) ? response : [response];
  const committed = Number(readRedisValue(values[0])) === 1;
  const jobId = readRedisValue(values[1]);
  const nextEligibleAtMs = Number(readRedisValue(values[2]));
  return {
    committed,
    ...(committed && jobId && Number.isSafeInteger(nextEligibleAtMs) && nextEligibleAtMs > 0
      ? { next: { jobId, nextEligibleAtMs } }
      : {}),
  };
}
