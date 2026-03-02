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
}
