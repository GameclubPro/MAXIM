import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';

const REQUESTS_PER_ATTEMPT = 12;
const MAX_ATTEMPT_DURATION_MS = 60_000;
const UNAVAILABLE_RETRY_MS = 5_000;

export type MaxMuteApiBudgetScope = {
  chatId: string;
  subjectUserId: string;
  intentId: string;
  attemptCount: number;
  deadlineAtMs: number;
};

export class MaxModerationApiBudgetError extends MaxApiInternalRateLimitError {
  constructor(
    readonly reason:
      | 'actor_cooldown'
      | 'chat_budget'
      | 'attempt_budget'
      | 'unavailable'
      | 'expired',
    retryAfterMs: number,
  ) {
    super(`Muted-user MAX API budget: ${reason}`, retryAfterMs, 'moderation_protection');
    this.name = 'MaxModerationApiBudgetError';
  }
}

type AttemptPermit = {
  scope: MaxMuteApiBudgetScope;
  expiresAtMs: number;
  remaining: number;
  closed: boolean;
};

// FLAG: One causal attempt shares its allowance across clients, bots and nested guards.
// This is resource admission only; source, lease and final feature authority stay mandatory.
const activeAttempt = new AsyncLocalStorage<AttemptPermit>();

export function maxMuteApiBudgetKeys(chatId: string, subjectUserId: string) {
  const chat = createHash('sha256').update(chatId).digest('hex');
  const actor = createHash('sha256').update(subjectUserId).digest('hex');
  return {
    chat: `maxapi:mute-budget:v1:{${chat}}:chat`,
    actor: `maxapi:mute-budget:v1:{${chat}}:actor:${actor}`,
  };
}

// FLAG: Redis time and both buckets are read before any write. A rejected observation never
// prolongs an actor's cooldown. Chat pressure never escalates an individual actor.
const RESERVE_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local function read(key, capacity, refill, actor)
  if redis.call('EXISTS', key) == 0 then return {capacity, now, 0, 0} end
  local row = redis.call('HMGET', key, 'tokens', 'lastRefillAtMs', 'level', 'cooldownUntilMs')
  local tokens = tonumber(row[1])
  local at = tonumber(row[2])
  local level = actor and tonumber(row[3]) or 0
  local untilAt = actor and tonumber(row[4]) or 0
  if not tokens or not at or not level or not untilAt or
     tokens ~= tokens or at ~= at or tokens < 0 or tokens > capacity or
     at < 0 or at > now + 1000 or level < 0 or level > 3 or level ~= math.floor(level) or
     untilAt ~= untilAt or untilAt < 0 or untilAt > now + 3600000 then return nil end
  return {math.min(capacity, tokens + math.max(0, now - at) * refill / 60000), now, level, untilAt}
end
local actor = read(KEYS[1], 72, 120, true)
local chat = read(KEYS[2], 144, 480, false)
if not actor or not chat then return {0, 5000, 3} end
if actor[4] > now then return {0, actor[4] - now, 1} end
if chat[1] < 12 then return {0, math.ceil((12 - chat[1]) * 60000 / 480), 2} end
if actor[1] < 12 then
  local level = math.min(3, actor[3] + 1)
  local delays = {300000, 900000, 3600000}
  redis.call('HSET', KEYS[1], 'tokens', actor[1], 'lastRefillAtMs', now,
    'level', level, 'cooldownUntilMs', now + delays[level])
  redis.call('PEXPIRE', KEYS[1], 86400000)
  return {0, delays[level], 1}
end
redis.call('HSET', KEYS[1], 'tokens', actor[1] - 12, 'lastRefillAtMs', now,
  'level', actor[3], 'cooldownUntilMs', 0)
redis.call('PEXPIRE', KEYS[1], 86400000)
redis.call('HSET', KEYS[2], 'tokens', chat[1] - 12, 'lastRefillAtMs', now)
redis.call('PEXPIRE', KEYS[2], 60000)
return {1, 0, 0}
`;

export class MaxModerationApiBudget {
  private redis?: Redis;
  private connecting?: Promise<void>;
  private unavailableUntilMs = 0;
  private closed = false;

  constructor(private readonly redisUrl: string) {}

  async run<T>(scope: MaxMuteApiBudgetScope, callback: () => Promise<T>): Promise<T> {
    const nested = activeAttempt.getStore();
    if (nested) {
      if (
        nested.scope.chatId !== scope.chatId ||
        nested.scope.subjectUserId !== scope.subjectUserId ||
        nested.scope.intentId !== scope.intentId ||
        nested.scope.attemptCount !== scope.attemptCount
      )
        throw new MaxModerationApiBudgetError('attempt_budget', 1_000);
      this.assertLive(nested);
      return callback();
    }
    if (!Number.isFinite(scope.deadlineAtMs) || scope.deadlineAtMs <= Date.now()) {
      throw new MaxModerationApiBudgetError('expired', 1_000);
    }
    const keys = maxMuteApiBudgetKeys(scope.chatId, scope.subjectUserId);
    let result: unknown;
    try {
      const redis = await this.connection();
      // FLAG: Unknown EVAL results consume at most one reservation. Never replay a timed-out
      // reservation or grant a local fallback permit when Redis is unavailable.
      result = await redis.eval(RESERVE_SCRIPT, 2, keys.actor, keys.chat);
    } catch {
      this.unavailableUntilMs = Date.now() + UNAVAILABLE_RETRY_MS;
      throw new MaxModerationApiBudgetError('unavailable', UNAVAILABLE_RETRY_MS);
    }
    if (
      !Array.isArray(result) ||
      result.length !== 3 ||
      !result.every((part) => typeof part === 'number' && Number.isFinite(part))
    ) {
      throw new MaxModerationApiBudgetError('unavailable', UNAVAILABLE_RETRY_MS);
    }
    if (result[0] !== 1) {
      throw new MaxModerationApiBudgetError(
        result[2] === 1 ? 'actor_cooldown' : result[2] === 2 ? 'chat_budget' : 'unavailable',
        Math.max(1_000, Math.min(3_600_000, result[1])),
      );
    }
    const permit: AttemptPermit = {
      scope: { ...scope },
      expiresAtMs: Math.min(scope.deadlineAtMs, Date.now() + MAX_ATTEMPT_DURATION_MS),
      remaining: REQUESTS_PER_ATTEMPT,
      closed: false,
    };
    try {
      return await activeAttempt.run(permit, callback);
    } finally {
      permit.closed = true;
    }
  }

  consumeRequest(): void {
    const permit = activeAttempt.getStore();
    if (!permit) return;
    this.assertLive(permit);
    if (permit.remaining <= 0) throw new MaxModerationApiBudgetError('attempt_budget', 1_000);
    permit.remaining -= 1;
  }

  assertRequestAllowed(): void {
    const permit = activeAttempt.getStore();
    if (permit) this.assertLive(permit);
  }

  close(): void {
    this.closed = true;
    this.redis?.disconnect();
  }

  private assertLive(permit: AttemptPermit): void {
    if (this.closed || permit.closed || permit.expiresAtMs <= Date.now()) {
      throw new MaxModerationApiBudgetError('expired', 1_000);
    }
  }

  private async connection(): Promise<Redis> {
    if (this.closed || this.unavailableUntilMs > Date.now()) {
      throw new MaxModerationApiBudgetError('unavailable', UNAVAILABLE_RETRY_MS);
    }
    if (!this.redis || this.redis.status === 'end') {
      this.redis = new Redis(this.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        connectTimeout: 200,
        commandTimeout: 150,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      this.redis.on('error', () => undefined);
      this.connecting = this.redis.connect().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
    if (this.closed || this.redis.status !== 'ready') {
      throw new MaxModerationApiBudgetError('unavailable', UNAVAILABLE_RETRY_MS);
    }
    return this.redis;
  }
}
