import { Injectable } from '@nestjs/common';
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

@Injectable()
export class RedisCounterService {
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
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
}
