import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

const VK_API_RATE_LIMIT_SLOT_TTL_MS = 2_000;
const VK_API_METRICS_TTL_SEC = 6 * 60 * 60;
const VK_API_RATE_LIMIT_RESERVATION_SCRIPT = `
local ttlMs = tonumber(ARGV[#ARGV])
local keyCount = #KEYS

for index = 1, keyCount do
  local limit = tonumber(ARGV[index])
  local count = tonumber(redis.call('GET', KEYS[index]) or '0')
  if count >= limit then
    local ttl = redis.call('PTTL', KEYS[index])
    if ttl == nil or ttl < 1 then
      ttl = ttlMs
    end
    return {0, index, ttl}
  end
end

for index = 1, keyCount do
  local nextCount = redis.call('INCR', KEYS[index])
  if nextCount == 1 then
    redis.call('PEXPIRE', KEYS[index], ttlMs)
  else
    local ttl = redis.call('PTTL', KEYS[index])
    if ttl == nil or ttl < 1 then
      redis.call('PEXPIRE', KEYS[index], ttlMs)
    end
  end
end

return {1, 0, 0}
`;

@Injectable()
export class VkParsingRateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(VkParsingRateLimitService.name);
  private readonly redis: Redis;
  private readonly rpsLimit: number;
  private readonly maxWaitMs: number;
  private lastMetricFailureLogAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.rpsLimit = this.readPositiveInt(configService.get<number>('VK_API_RPS'), 5);
    this.maxWaitMs = this.readNonNegativeInt(
      configService.get<number>('VK_API_RATE_LIMIT_WAIT_MS'),
      2_000,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async reserveVkApiSlot(method: string): Promise<void> {
    const startedAtMs = Date.now();
    while (true) {
      const reservation = await this.tryReserveVkApiSlot(method);
      if (reservation.ok) {
        return;
      }

      const remainingWaitMs = this.maxWaitMs - (Date.now() - startedAtMs);
      if (remainingWaitMs <= 0) {
        throw new Error(`VK API rate limit exceeded for ${method}`);
      }

      await this.sleep(Math.min(reservation.retryAfterMs, Math.max(25, remainingWaitMs)));
    }
  }

  async recordVkApiOutcome(params: {
    method: string;
    outcome: 'success' | 'error';
    code?: string | number | null;
  }): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const method = this.normalizeMetricPart(params.method) || 'unknown';
    const code = this.normalizeMetricPart(String(params.code ?? params.outcome));
    const key = `vkapi:metrics:v1:${params.outcome}:${method}:${code}:${nowSec}`;
    try {
      await this.redis.multi().incr(key).expire(key, VK_API_METRICS_TTL_SEC).exec();
    } catch (error) {
      this.logMetricFailure(error);
    }
  }

  private async tryReserveVkApiSlot(method: string): Promise<
    | { ok: true }
    | {
        ok: false;
        retryAfterMs: number;
      }
  > {
    const nowSec = Math.floor(Date.now() / 1_000);
    const methodKey = this.normalizeMetricPart(method) || 'unknown';
    const keys = [`vkapi:rps:global:${nowSec}`, `vkapi:rps:method:${methodKey}:${nowSec}`];
    const raw = await this.redis.eval(
      VK_API_RATE_LIMIT_RESERVATION_SCRIPT,
      keys.length,
      ...keys,
      String(this.rpsLimit),
      String(this.rpsLimit),
      String(VK_API_RATE_LIMIT_SLOT_TTL_MS),
    );
    const result = Array.isArray(raw) ? raw : null;
    const ok = typeof result?.[0] === 'number' ? result[0] : Number.NaN;
    const retryAfterMs = typeof result?.[2] === 'number' ? result[2] : Number.NaN;

    if (ok === 1) {
      return { ok: true };
    }
    if (ok !== 0) {
      throw new Error('Failed to execute VK API rate limit reservation script');
    }

    return {
      ok: false,
      retryAfterMs: Number.isFinite(retryAfterMs)
        ? Math.max(1, Math.trunc(retryAfterMs))
        : VK_API_RATE_LIMIT_SLOT_TTL_MS,
    };
  }

  private normalizeMetricPart(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/giu, '_')
      .slice(0, 80);
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(numericValue) && numericValue > 0
      ? Math.trunc(numericValue)
      : fallback;
  }

  private readNonNegativeInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(numericValue) && numericValue >= 0
      ? Math.trunc(numericValue)
      : fallback;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private logMetricFailure(error: unknown): void {
    const nowMs = Date.now();
    if (nowMs - this.lastMetricFailureLogAtMs < 10_000) {
      return;
    }

    this.lastMetricFailureLogAtMs = nowMs;
    this.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      'Failed to record VK API metric',
    );
  }
}
