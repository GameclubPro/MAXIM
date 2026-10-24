import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { z } from 'zod';
import { centralEnabled } from '../../statistics/stats-common';

const requestSchema = z
  .object({
    grantId: z.string().uuid(),
    revision: z.number().int().positive().safe(),
    entityId: z.string().regex(/^-?[1-9]\d{0,19}$/u),
    kind: z.enum(['CHAT', 'CHANNEL']),
  })
  .strict();
export type StatisticsAccessDemand = z.infer<typeof requestSchema>;
export type StatisticsAccessClaim = {
  request: StatisticsAccessDemand;
  member: string;
  lease: string;
};
export const STATISTICS_ACCESS_DEMAND_KEYS = [
  'statistics:access-demand:v1:due',
  'statistics:access-demand:v1:expires',
] as const;

// FLAG: One bounded mailbox across every API role. Duplicate reads cannot renew
// the absolute deadline; capacity includes leased work and retries, never payloads.
export const STATISTICS_ACCESS_DEMAND_SCRIPT = `
local t=redis.call('TIME')
local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local old=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf',now,'LIMIT',0,128)
for _,m in ipairs(old) do redis.call('ZREM',KEYS[1],m); redis.call('ZREM',KEYS[2],m) end
if ARGV[1]=='offer' then
  local accepted=0
  for i=2,math.min(#ARGV,101) do
    local m=ARGV[i]
    if not redis.call('ZSCORE',KEYS[2],m) and redis.call('ZCARD',KEYS[2])<128 then
      redis.call('ZADD',KEYS[1],now,m); redis.call('ZADD',KEYS[2],now+300000,m)
      accepted=accepted+1
    end
  end
  redis.call('PEXPIRE',KEYS[1],360000); redis.call('PEXPIRE',KEYS[2],360000)
  return accepted
elseif ARGV[1]=='claim' then
  local next=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,1)
  if #next==0 then return {} end
  local lease=tostring(now+60000)
  redis.call('ZADD',KEYS[1],lease,next[1])
  return {next[1],lease}
elseif ARGV[1]=='finish' then
  if redis.call('ZSCORE',KEYS[1],ARGV[2])==ARGV[3] then
    redis.call('ZREM',KEYS[1],ARGV[2]); redis.call('ZREM',KEYS[2],ARGV[2])
  end
  return 0
end
return redis.error_reply('INVALID_ACCESS_DEMAND_OPERATION')
`;

@Injectable()
export class StatisticsAccessDemandService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly logger = new Logger(StatisticsAccessDemandService.name);
  private active: Promise<unknown> | null = null;
  private stopping = false;
  private nextWarningAt = 0;
  constructor(private readonly config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      connectTimeout: 500,
      commandTimeout: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    this.redis.on('error', () => undefined);
  }
  async onModuleInit(): Promise<void> {
    if (centralEnabled(this.config)) await this.redis.connect().catch(() => undefined);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.redis.disconnect();
    await this.active;
  }
  private async execute(args: string[]): Promise<unknown> {
    // FLAG: Statistics demand is best effort and has no local wait queue. Redis
    // failure/full capacity cannot wait on MAX or consume moderation admission.
    if (this.stopping || this.active || this.redis.status !== 'ready') return null;
    const operation = this.redis
      .eval(STATISTICS_ACCESS_DEMAND_SCRIPT, 2, ...STATISTICS_ACCESS_DEMAND_KEYS, ...args)
      .catch(() => {
        if (Date.now() >= this.nextWarningAt) {
          this.nextWarningAt = Date.now() + 60_000;
          this.logger.warn('STATISTICS_ACCESS_DEMAND_UNAVAILABLE');
        }
        return null;
      });
    this.active = operation;
    try {
      return await operation;
    } finally {
      this.active = null;
    }
  }
  async offer(requests: StatisticsAccessDemand[]): Promise<void> {
    if (!requests.length) return;
    await this.execute([
      'offer',
      ...requests.slice(0, 100).map((request) => JSON.stringify(requestSchema.parse(request))),
    ]);
  }
  async claim(): Promise<StatisticsAccessClaim | null> {
    const result = await this.execute(['claim']);
    if (!Array.isArray(result) || result.length !== 2) return null;
    const [member, lease] = z
      .tuple([z.string().max(350), z.string().regex(/^\d+$/u)])
      .parse(result);
    return { request: requestSchema.parse(JSON.parse(member)), member, lease };
  }
  async finish(claim: StatisticsAccessClaim): Promise<void> {
    await this.execute(['finish', claim.member, claim.lease]);
  }
}
