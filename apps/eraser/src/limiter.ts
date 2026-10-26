import type { Redis } from 'ioredis';
import { setTimeout as delay } from 'node:timers/promises';

// FLAG: All HTTP attempts, including reads, share this Redis-clock admission gate.
export const ADMIT_HTTP_LUA = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local cooldown=tonumber(redis.call('GET',KEYS[1]) or '0')
local gap=tonumber(ARGV[1]); local next=tonumber(redis.call('GET',KEYS[2]) or '0')
local chat=KEYS[3] ~= '' and tonumber(redis.call('GET',KEYS[3]) or '0') or 0
local at=math.max(cooldown,next,chat)
if at>now then return at-now end
redis.call('SET',KEYS[2],now+gap,'PX',60000)
if KEYS[3] ~= '' then redis.call('SET',KEYS[3],now+1000,'PX',60000) end
return 0`;
export const COOLDOWN_LUA = `
local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
local deadline=now+tonumber(ARGV[1]); local old=tonumber(redis.call('GET',KEYS[1]) or '0')
if deadline>old then redis.call('SET',KEYS[1],deadline,'PX',tonumber(ARGV[1])+60000) end
return math.max(deadline,old)`;
export class HttpLimiter {
  private reducedUntil = 0;
  constructor(
    private readonly redis: Redis,
    private readonly rps: number,
    private readonly prefix = 'eraser:http',
  ) {}
  async acquire(chatId?: string, signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const effectiveRps =
        Date.now() < this.reducedUntil ? Math.max(1, Math.floor(this.rps / 2)) : this.rps;
      const wait = Number(
        await this.redis.eval(
          ADMIT_HTTP_LUA,
          3,
          `${this.prefix}:cooldown`,
          `${this.prefix}:next`,
          chatId ? `${this.prefix}:chat:${chatId}` : '',
          Math.ceil(1000 / effectiveRps),
        ),
      );
      if (wait === 0) return;
      await delay(Math.min(wait, 1000), undefined, { signal });
    }
  }
  async cooldown(ms: number): Promise<void> {
    this.reducedUntil = Date.now() + 60_000;
    await this.redis.eval(
      COOLDOWN_LUA,
      1,
      `${this.prefix}:cooldown`,
      Math.min(Math.max(ms, 1000), 86_400_000),
    );
  }
}
