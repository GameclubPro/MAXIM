import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { getAppRole, roleRunsIngress } from '../runtime/app-role';

const DEFAULT_WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS = 100;

const WEBHOOK_RATE_LIMIT_SCRIPT = `
-- MAXIM_WEBHOOK_RATE_LIMIT_V1
local secondCount = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
if secondCount > tonumber(ARGV[3]) then
  return {0, secondCount, 0}
end

local windowCount = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], tonumber(ARGV[2]))
if windowCount > tonumber(ARGV[4]) then
  return {0, secondCount, windowCount}
end

return {1, secondCount, windowCount}
`;

@Injectable()
export class WebhookRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookRateLimitService.name);
  private readonly redis: Redis | null;
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
    this.globalLimit = this.configService.get<number>('WEBHOOK_GLOBAL_RPS_LIMIT', 300);
    this.burstLimit = this.configService.get<number>('WEBHOOK_BURST_LIMIT', 450);
    if (!roleRunsIngress(getAppRole())) {
      this.redis = null;
      return;
    }

    const commandTimeout = this.readPositiveInt(
      this.configService.get('WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS'),
      DEFAULT_WEBHOOK_RATE_LIMIT_REDIS_TIMEOUT_MS,
    );
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'), {
      commandTimeout,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (error) => this.logRedisFallback(error));
  }

  async onModuleDestroy() {
    await this.redis?.quit();
  }

  async isAllowed(_sourceIp: string): Promise<boolean> {
    const nowSec = Math.floor(Date.now() / 1000);
    const secKey = `webhook:rps:global:${nowSec}`;
    const avgWindowKey = `webhook:rps:avg:${Math.floor(nowSec / 20)}`;

    try {
      if (!this.redis) {
        return this.reserveFallbackCapacity(secKey, avgWindowKey);
      }
      const result = await this.redis.eval(
        WEBHOOK_RATE_LIMIT_SCRIPT,
        2,
        secKey,
        avgWindowKey,
        2,
        21,
        this.burstLimit,
        this.globalLimit * 20,
      );
      const allowed = Array.isArray(result) ? Number(result[0]) : Number.NaN;
      if (allowed !== 0 && allowed !== 1) {
        throw new Error('Failed to reserve webhook ingress capacity');
      }
      return allowed === 1;
    } catch (error: unknown) {
      this.logRedisFallback(error);
      return this.reserveFallbackCapacity(secKey, avgWindowKey);
    }
  }

  private reserveFallbackCapacity(secKey: string, avgWindowKey: string): boolean {
    const secCount = this.incrementFallbackCounterWithTtl(secKey, 2);
    if (secCount > this.burstLimit) {
      return false;
    }
    const avgWindowCount = this.incrementFallbackCounterWithTtl(avgWindowKey, 21);
    return avgWindowCount <= this.globalLimit * 20;
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

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
  }
}
