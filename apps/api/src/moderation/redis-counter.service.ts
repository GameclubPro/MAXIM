import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisCounterService {
  private readonly redis: Redis;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }

  async incrementByWithTtl(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const normalizedAmount = Number.isFinite(amount) ? Math.trunc(amount) : 0;
    if (normalizedAmount <= 0) {
      return 0;
    }

    const count = await this.redis.incrby(key, normalizedAmount);
    const ttl = await this.redis.ttl(key);
    if (ttl < 0) {
      await this.redis.expire(key, ttlSeconds);
    }
    return count;
  }

  async addToSetWithTtl(
    key: string,
    member: string,
    ttlSeconds: number,
  ): Promise<{ added: boolean; size: number }> {
    const addedCount = await this.redis.sadd(key, member);
    const ttl = await this.redis.ttl(key);
    if (ttl < 0) {
      await this.redis.expire(key, ttlSeconds);
    }

    const size = await this.redis.scard(key);
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
}
