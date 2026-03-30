import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class WebhookRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookRateLimitService.name);
  private readonly redis: Redis;
  private readonly globalLimit: number;
  private readonly burstLimit: number;
  private readonly fallbackCounters = new Map<
    string,
    {
      count: number;
      expiresAtMs: number;
    }
  >();
  private lastFallbackLogAtMs = 0;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
    this.globalLimit = this.configService.get<number>('WEBHOOK_GLOBAL_RPS_LIMIT', 300);
    this.burstLimit = this.configService.get<number>('WEBHOOK_BURST_LIMIT', 450);
  }

  async onModuleDestroy() {
    await this.redis.quit();
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
    try {
      const pipeline = this.redis.multi();
      pipeline.incr(key);
      pipeline.expire(key, ttlSec);
      const result = await pipeline.exec();
      const count = result?.[0]?.[1];

      if (typeof count !== 'number') {
        throw new Error(`Failed to increment webhook rate limit counter for ${key}`);
      }

      return count;
    } catch (error: unknown) {
      this.logRedisFallback(error);
      return this.incrementFallbackCounterWithTtl(key, ttlSec);
    }
  }

  private incrementFallbackCounterWithTtl(key: string, ttlSec: number): number {
    const nowMs = Date.now();
    const existing = this.fallbackCounters.get(key);
    if (!existing || existing.expiresAtMs <= nowMs) {
      this.fallbackCounters.set(key, {
        count: 1,
        expiresAtMs: nowMs + ttlSec * 1_000,
      });
      this.cleanupExpiredFallbackCounters(nowMs);
      return 1;
    }

    existing.count += 1;
    return existing.count;
  }

  private cleanupExpiredFallbackCounters(nowMs: number) {
    for (const [key, entry] of this.fallbackCounters.entries()) {
      if (entry.expiresAtMs <= nowMs) {
        this.fallbackCounters.delete(key);
      }
    }
  }

  private logRedisFallback(error: unknown) {
    const nowMs = Date.now();
    if (nowMs - this.lastFallbackLogAtMs < 10_000) {
      return;
    }

    this.lastFallbackLogAtMs = nowMs;
    this.logger.warn(
      {
        err: error instanceof Error ? error.message : String(error),
      },
      'Falling back to in-memory webhook rate limit counters after Redis failure',
    );
  }
}
