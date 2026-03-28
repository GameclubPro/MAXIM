import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class WebhookRateLimitService {
  private readonly redis: Redis;
  private readonly globalLimit: number;
  private readonly burstLimit: number;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
    this.globalLimit = this.configService.get<number>('WEBHOOK_GLOBAL_RPS_LIMIT', 300);
    this.burstLimit = this.configService.get<number>('WEBHOOK_BURST_LIMIT', 450);
  }

  async isAllowed(_sourceIp: string): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000);
    const secKey = `webhook:rps:global:${nowSec}`;
    const avgWindowKey = `webhook:rps:avg:${Math.floor(nowSec / 20)}`;

    const secCount = await this.incrementCounterWithTtl(secKey, 2);
    if (secCount > this.burstLimit) {
      return false;
    }

    const avgWindowCount = await this.incrementCounterWithTtl(avgWindowKey, 21);

    return avgWindowCount <= this.globalLimit * 20;
  }

  private async incrementCounterWithTtl(key: string, ttlSec: number): Promise<number> {
    const pipeline = this.redis.multi();
    pipeline.incr(key);
    pipeline.expire(key, ttlSec);
    const result = await pipeline.exec();
    const count = result?.[0]?.[1];

    if (typeof count !== 'number') {
      throw new Error(`Failed to increment webhook rate limit counter for ${key}`);
    }

    return count;
  }
}
