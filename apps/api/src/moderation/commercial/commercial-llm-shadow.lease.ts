import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

export const COMMERCIAL_LLM_LEASE_KEY = 'commercial-llm-shadow:v1:lease';
export const COMMERCIAL_LLM_COOLDOWN_KEY = 'commercial-llm-shadow:v1:cooldown';
export const COMMERCIAL_LLM_STATUS_KEY = 'commercial-llm-shadow:v1:status';
export const COMMERCIAL_LLM_LEASE_MS = 120_000;
export const COMMERCIAL_LLM_INTERVAL_MS = 10_000;
const RELEASE =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const RETAIN = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('PERSIST', KEYS[1])
return 1`;
const ADMIT = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return 1`;

export function createCommercialLlmRedis(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    commandTimeout: 750,
    connectTimeout: 750,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectionName: 'commercial-llm-shadow',
  });
  redis.on('error', () => undefined);
  return redis;
}

export class CommercialLlmShadowLease {
  constructor(private readonly redis: Redis) {}
  async acquire(): Promise<string | null> {
    const token = randomUUID();
    const accepted = await this.redis.eval(
      ADMIT,
      2,
      COMMERCIAL_LLM_LEASE_KEY,
      COMMERCIAL_LLM_COOLDOWN_KEY,
      token,
      COMMERCIAL_LLM_LEASE_MS,
      COMMERCIAL_LLM_INTERVAL_MS,
    );
    return accepted === 1 ? token : null;
  }
  async owns(token: string): Promise<boolean> {
    return (await this.redis.get(COMMERCIAL_LLM_LEASE_KEY)) === token;
  }
  // FLAG: Pin the exact CPU lease before HTTP handoff; uncertain work requires managed recovery.
  // The shared key keeps legacy admission fenced without extending an unknown owner's lease.
  async retainUntilReleased(token: string): Promise<boolean> {
    return (await this.redis.eval(RETAIN, 1, COMMERCIAL_LLM_LEASE_KEY, token)) === 1;
  }
  async release(token: string): Promise<void> {
    await this.redis.eval(RELEASE, 1, COMMERCIAL_LLM_LEASE_KEY, token);
  }
}
