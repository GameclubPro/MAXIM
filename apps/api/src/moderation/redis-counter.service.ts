import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';

const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const INCREMENT_ONCE_PER_MEMBER_WITH_TTL_SCRIPT = `
local added = redis.call('SET', KEYS[2], '1', 'EX', ARGV[1], 'NX')
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if not added then
  return {0, count}
end
count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {1, count}
`;

// FLAG: The deadline check must remain before INCR/SET. Callers may stop awaiting at the same
// deadline, so a late script must be read-only and a completed write must remain replayable.
const REPLAYABLE_INCREMENT_BEFORE_DEADLINE_SCRIPT = `
local replayed_count = redis.call('GET', KEYS[2])
if replayed_count then
  return {2, tonumber(replayed_count) or -1}
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[2]) then
  return {0, 0}
end

local count = redis.call('INCR', KEYS[1])
local full_ttl_ms = tonumber(ARGV[1]) * 1000
local counter_pttl = redis.call('PTTL', KEYS[1])
if counter_pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], full_ttl_ms)
end
redis.call('SET', KEYS[2], tostring(count), 'PX', full_ttl_ms)
return {1, count}
`;

const REVISIONED_MEMBERSHIP_STATE_MISSING = '__maxim_revisioned_membership_missing__';
const REVISIONED_MEMBERSHIP_MAX_CAS_ATTEMPTS = 4;

// FLAG: Keep compare/deadline checks before mutations. Physical pruning uses Redis time and the
// extended retention TTL. Logical counts include only the current event and its chronological
// predecessors, so a later event can never make an out-of-order original actionable.
const REPLACE_REVISIONED_SET_MEMBERSHIPS_BEFORE_DEADLINE_SCRIPT = `
local current_state = redis.call('GET', KEYS[1])
if ARGV[1] == '${REVISIONED_MEMBERSHIP_STATE_MISSING}' then
  if current_state then
    return {2}
  end
elseif current_state ~= ARGV[1] then
  return {2}
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[5]) then
  return {0}
end

local window_ms = tonumber(ARGV[3]) * 1000
local full_ttl_ms = tonumber(ARGV[4]) * 1000
local count_limit = tonumber(ARGV[#ARGV])
local member_timestamp_ms = tonumber(ARGV[2])
local cutoff_ms = member_timestamp_ms - window_ms
local retention_cutoff_ms = now_ms - full_ttl_ms
local logical_lower_bound = '(' .. tostring(cutoff_ms)
local response = {1}
local stored_memberships = {}
for key_index = 2, #KEYS do
  local desired = ARGV[5 + key_index]
  redis.call('ZREMRANGEBYSCORE', KEYS[key_index], '-inf', retention_cutoff_ms)
  if desired == '1' then
    redis.call('ZADD', KEYS[key_index], member_timestamp_ms, ARGV[6])
    redis.call('PEXPIRE', KEYS[key_index], full_ttl_ms)
    local membership_count = redis.call(
      'ZCOUNT',
      KEYS[key_index],
      logical_lower_bound,
      member_timestamp_ms
    )
    membership_count = math.min(membership_count, count_limit)
    table.insert(stored_memberships, {key = KEYS[key_index], count = membership_count})
    table.insert(response, membership_count)
  else
    redis.call('ZREM', KEYS[key_index], ARGV[6])
  end
end

local next_state = cjson.encode({
  v = 1,
  revision = tonumber(ARGV[2]),
  memberships = stored_memberships
})
redis.call('SET', KEYS[1], next_state, 'PX', full_ttl_ms)
return response
`;

const VERIFY_REVISIONED_MEMBERSHIP_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return 1
end
return 2
`;

const INCREMENT_BY_WITH_TTL_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return count
`;

const ADD_TO_SET_WITH_TTL_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local size = redis.call('SCARD', KEYS[1])
return {added, size}
`;

const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

// FLAG: Keep the Redis TIME deadline check before SET. A caller may stop awaiting this command at
// the same deadline, so a command that reaches Redis late must never create an orphaned lock.
const ACQUIRE_LOCK_BEFORE_DEADLINE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[3]) then
  return 0
end

local acquired = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if acquired then
  return 1
end
return 2
`;

export type ReplayableDeadlineIncrementResult =
  | { kind: 'deadline_exceeded' }
  | { kind: 'inserted' | 'replayed'; count: number };

export type RevisionedSetMembershipResult =
  | { kind: 'deadline_exceeded' }
  | { kind: 'stale' }
  | { kind: 'applied' | 'replayed'; counts: number[] };

type StoredRevisionedSetMembershipState = {
  revision: number;
  memberships: Map<string, number>;
};

export type DeadlineLockAcquireResult =
  | { kind: 'acquired' }
  | { kind: 'busy' }
  | { kind: 'deadline_exceeded' };

@Injectable()
export class RedisCounterService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    return Number(
      await this.redis.eval(INCREMENT_WITH_TTL_SCRIPT, 1, key, String(Math.trunc(ttlSeconds))),
    );
  }

  async incrementOncePerMemberWithTtl(
    counterKey: string,
    memberKey: string,
    ttlSeconds: number,
  ): Promise<{ inserted: boolean; count: number }> {
    const result = (await this.redis.eval(
      INCREMENT_ONCE_PER_MEMBER_WITH_TTL_SCRIPT,
      2,
      counterKey,
      memberKey,
      String(Math.trunc(ttlSeconds)),
    )) as [number | string, number | string];
    return {
      inserted: Number(result?.[0] ?? 0) > 0,
      count: Number(result?.[1] ?? 0),
    };
  }

  async incrementOncePerMemberWithTtlBeforeDeadline(
    counterKey: string,
    memberKey: string,
    ttlSeconds: number,
    deadlineAtMs: number,
  ): Promise<ReplayableDeadlineIncrementResult> {
    const normalizedTtlSeconds = Math.trunc(ttlSeconds);
    const normalizedDeadlineAtMs = Math.trunc(deadlineAtMs);
    if (
      !Number.isFinite(normalizedTtlSeconds) ||
      normalizedTtlSeconds <= 0 ||
      !Number.isFinite(normalizedDeadlineAtMs) ||
      normalizedDeadlineAtMs <= 0
    ) {
      throw new Error('Replayable counter TTL and deadline must be valid positive values');
    }

    const result = (await this.redis.eval(
      REPLAYABLE_INCREMENT_BEFORE_DEADLINE_SCRIPT,
      2,
      counterKey,
      memberKey,
      String(normalizedTtlSeconds),
      String(normalizedDeadlineAtMs),
    )) as [number | string, number | string];
    const status = Number(result?.[0]);
    const count = Number(result?.[1]);
    if (status === 0) {
      return { kind: 'deadline_exceeded' };
    }
    if ((status === 1 || status === 2) && Number.isSafeInteger(count) && count > 0) {
      return { kind: status === 1 ? 'inserted' : 'replayed', count };
    }
    throw new Error('Redis returned an invalid replayable counter result');
  }

  async replaceRevisionedSetMembershipsBeforeDeadline(params: {
    stateKey: string;
    member: string;
    revision: number;
    membershipKeys: readonly string[];
    windowSeconds: number;
    ttlSeconds: number;
    countLimit?: number;
    deadlineAtMs: number;
  }): Promise<RevisionedSetMembershipResult> {
    const stateKey = params.stateKey.trim();
    const member = params.member.trim();
    const revision = Math.trunc(params.revision);
    const windowSeconds = Math.trunc(params.windowSeconds);
    const ttlSeconds = Math.trunc(params.ttlSeconds);
    const countLimit = Math.trunc(params.countLimit ?? 21);
    const deadlineAtMs = Math.trunc(params.deadlineAtMs);
    const membershipKeys = params.membershipKeys.map((key) => key.trim());
    if (
      !stateKey ||
      !member ||
      membershipKeys.some((key) => !key) ||
      new Set(membershipKeys).size !== membershipKeys.length ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds <= 0 ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < windowSeconds ||
      !Number.isSafeInteger(countLimit) ||
      countLimit <= 0 ||
      countLimit > 100 ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs <= 0
    ) {
      throw new Error('Revisioned membership state input must contain valid unique keys and times');
    }

    for (let attempt = 0; attempt < REVISIONED_MEMBERSHIP_MAX_CAS_ATTEMPTS; attempt += 1) {
      if (Date.now() >= deadlineAtMs) {
        return { kind: 'deadline_exceeded' };
      }

      const currentRaw = await this.redis.get(stateKey);
      if (Date.now() >= deadlineAtMs) {
        return { kind: 'deadline_exceeded' };
      }
      const current = currentRaw ? this.parseRevisionedSetMembershipState(currentRaw) : null;
      if (current && revision < current.revision) {
        return { kind: 'stale' };
      }
      if (current && revision === current.revision) {
        const currentMembershipKeys = Array.from(current.memberships.keys());
        if (!this.stringSetsEqual(currentMembershipKeys, membershipKeys)) {
          return { kind: 'stale' };
        }
        const replayStatus = Number(
          await this.redis.eval(
            VERIFY_REVISIONED_MEMBERSHIP_STATE_SCRIPT,
            1,
            stateKey,
            currentRaw as string,
          ),
        );
        if (replayStatus === 2) {
          continue;
        }
        if (replayStatus === 1) {
          return {
            kind: 'replayed',
            counts: membershipKeys.map((key) => current.memberships.get(key) ?? 0),
          };
        }
        throw new Error('Redis returned an invalid revisioned membership replay result');
      }

      const desiredKeySet = new Set(membershipKeys);
      const allMembershipKeys = Array.from(
        new Set([...(current?.memberships.keys() ?? []), ...membershipKeys]),
      ).sort();
      const appliedResult = (await this.redis.eval(
        REPLACE_REVISIONED_SET_MEMBERSHIPS_BEFORE_DEADLINE_SCRIPT,
        1 + allMembershipKeys.length,
        stateKey,
        ...allMembershipKeys,
        currentRaw ?? REVISIONED_MEMBERSHIP_STATE_MISSING,
        String(revision),
        String(windowSeconds),
        String(ttlSeconds),
        String(deadlineAtMs),
        member,
        ...allMembershipKeys.map((key) => (desiredKeySet.has(key) ? '1' : '0')),
        String(countLimit),
      )) as Array<number | string>;
      const appliedStatus = Number(appliedResult?.[0]);
      if (appliedStatus === 0) {
        return { kind: 'deadline_exceeded' };
      }
      if (appliedStatus === 2) {
        continue;
      }
      if (appliedStatus === 1) {
        const sortedDesiredKeys = allMembershipKeys.filter((key) => desiredKeySet.has(key));
        const sortedCounts = this.parseRevisionedMembershipCounts(
          appliedResult.slice(1),
          sortedDesiredKeys.length,
        );
        const countByKey = new Map(
          sortedDesiredKeys.map((key, index) => [key, sortedCounts[index] ?? 0]),
        );
        return {
          kind: 'applied',
          counts: membershipKeys.map((key) => countByKey.get(key) ?? 0),
        };
      }
      throw new Error('Redis returned an invalid revisioned membership mutation result');
    }

    throw new Error('Redis revisioned membership state changed too frequently');
  }

  async incrementByWithTtl(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const normalizedAmount = Number.isFinite(amount) ? Math.trunc(amount) : 0;
    if (normalizedAmount <= 0) {
      return 0;
    }

    return Number(
      await this.redis.eval(
        INCREMENT_BY_WITH_TTL_SCRIPT,
        1,
        key,
        String(normalizedAmount),
        String(Math.trunc(ttlSeconds)),
      ),
    );
  }

  async addToSetWithTtl(
    key: string,
    member: string,
    ttlSeconds: number,
  ): Promise<{ added: boolean; size: number }> {
    const result = (await this.redis.eval(
      ADD_TO_SET_WITH_TTL_SCRIPT,
      1,
      key,
      member,
      String(Math.trunc(ttlSeconds)),
    )) as [number | string, number | string];
    const addedCount = Number(result?.[0] ?? 0);
    const size = Number(result?.[1] ?? 0);
    return {
      added: addedCount > 0,
      size,
    };
  }

  async getString(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async setStringWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return;
    }

    await this.redis.set(key, value, 'EX', Math.trunc(ttlSeconds));
  }

  async deleteKey(key: string): Promise<number> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return 0;
    }

    return this.redis.del(normalizedKey);
  }

  async deleteKeysByPattern(pattern: string, scanCount = 200): Promise<number> {
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
      return 0;
    }

    let deleted = 0;
    let cursor = '0';
    const normalizedScanCount =
      Number.isFinite(scanCount) && scanCount > 0 ? Math.trunc(scanCount) : 200;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        normalizedPattern,
        'COUNT',
        String(normalizedScanCount),
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        deleted += await this.redis.del(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (!key.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return null;
    }

    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', Math.trunc(ttlMs), 'NX');
    return acquired === 'OK' ? token : null;
  }

  async acquireLockBeforeDeadline(
    key: string,
    token: string,
    ttlMs: number,
    deadlineAtMs: number,
  ): Promise<DeadlineLockAcquireResult> {
    const normalizedKey = key.trim();
    const normalizedToken = token.trim();
    const normalizedTtlMs = Math.trunc(ttlMs);
    const normalizedDeadlineAtMs = Math.trunc(deadlineAtMs);
    if (
      !normalizedKey ||
      !normalizedToken ||
      !Number.isFinite(normalizedTtlMs) ||
      normalizedTtlMs <= 0 ||
      !Number.isFinite(normalizedDeadlineAtMs) ||
      normalizedDeadlineAtMs <= 0
    ) {
      throw new Error('Deadline lock key, token, TTL, and deadline must be valid');
    }

    const status = Number(
      await this.redis.eval(
        ACQUIRE_LOCK_BEFORE_DEADLINE_SCRIPT,
        1,
        normalizedKey,
        normalizedToken,
        String(normalizedTtlMs),
        String(normalizedDeadlineAtMs),
      ),
    );
    if (status === 0) {
      return { kind: 'deadline_exceeded' };
    }
    if (status === 1) {
      return { kind: 'acquired' };
    }
    if (status === 2) {
      return { kind: 'busy' };
    }
    throw new Error('Redis returned an invalid deadline lock acquisition result');
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (!key.trim() || !token.trim()) {
      return;
    }

    await this.redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    );
  }

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!key.trim() || !token.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return false;
    }

    const renewed = await this.redis.eval(
      RENEW_LOCK_SCRIPT,
      1,
      key,
      token,
      String(Math.trunc(ttlMs)),
    );
    return Number(renewed) > 0;
  }

  private parseRevisionedSetMembershipState(raw: string): StoredRevisionedSetMembershipState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Redis returned malformed revisioned membership state');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    const record = parsed as Record<string, unknown>;
    const revision = record.revision;
    const memberships = record.memberships;
    if (
      record.v !== 1 ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      !memberships ||
      typeof memberships !== 'object'
    ) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    const membershipEntries = Array.isArray(memberships)
      ? memberships.map((membership) => {
          if (!membership || typeof membership !== 'object' || Array.isArray(membership)) {
            return ['', Number.NaN] as [string, number];
          }
          const entry = membership as Record<string, unknown>;
          return [entry.key, entry.count] as [unknown, unknown];
        })
      : Object.entries(memberships as Record<string, unknown>);
    if (
      membershipEntries.some(
        ([key, count]) =>
          typeof key !== 'string' ||
          !key.trim() ||
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0,
      ) ||
      new Set(membershipEntries.map(([key]) => key)).size !== membershipEntries.length
    ) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    return {
      revision,
      memberships: new Map(membershipEntries as Array<[string, number]>),
    };
  }

  private parseRevisionedMembershipCounts(values: unknown[], expectedLength: number): number[] {
    const counts = values.map(Number);
    if (
      counts.length !== expectedLength ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Error('Redis returned invalid revisioned membership counts');
    }
    return counts;
  }

  private stringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value) => right.includes(value));
  }
}
