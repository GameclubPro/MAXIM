import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class WebhookRateLimitService {
  private readonly redis: Redis;
  private readonly limit: number;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
    this.limit = this.configService.get<number>('WEBHOOK_RPS_LIMIT', 30);
  }

  async isAllowed(sourceIp: string): Promise<boolean> {
    const key = `webhook:rps:${sourceIp}:${Math.floor(Date.now() / 1000)}`;
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, 2);
    }
    return count <= this.limit;
  }
}
