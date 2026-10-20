import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import {
  AUXILIARY_QUEUE_NAMES,
  RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
} from '../runtime/runtime-queue-inventory';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { MAX_ACTION_ALL_QUEUE_NAMES } from './max-action.queue';

export const RETENTION_PRIORITY_VERSION = '1';
export const RETENTION_PRIORITY_PERMIT_KEY = 'maxapi:retention-priority:permit:v1';
export const RETENTION_PRIORITY_STATUS_KEY = 'maxapi:retention-priority:status:v1';
export const RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX = 'maxapi:retention-priority:traffic:v1';
export const RETENTION_PRIORITY_TRAFFIC_TTL_SEC = 5 * 60;
export const HIGHER_PRIORITY_ACTIVITY_KEY = 'maxapi:retention-priority:activity:v1';
export const HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY =
  'maxapi:retention-priority:activity-unavailable:v1';
export const HIGHER_PRIORITY_ACTIVITY_LEASE_MS = 30_000;
export const HIGHER_PRIORITY_ACTIVITY_RENEW_MS = 5_000;
export const HIGHER_PRIORITY_ACTIVITY_LIMIT = 4_096;
export const RETENTION_PRIORITY_RESERVATION_MARKER = 'retention-priority:v1:';

export const RETENTION_PRIORITY_QUEUE_NAMES = Object.freeze([
  ...new Set<string>([
    ...ALL_WEBHOOK_QUEUE_NAMES,
    ...MAX_ACTION_ALL_QUEUE_NAMES,
    GLOBAL_SPAMMER_DENORM_QUEUE,
    ...AUXILIARY_QUEUE_NAMES.filter((name) => name !== 'message-retention'),
    ...RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
  ]),
]);

export type RetentionPriorityQueueDescriptor = {
  name: string;
  wait: string;
  active: string;
  paused: string;
  prioritized: string;
  delayed: string;
};

// FLAG: RuntimeCoreModule uses the inherited BullMQ default prefix. Both the sampler
// and atomic MAX admission use this fixed inventory; test prefixes isolate real Redis.
export function buildRetentionPriorityQueueDescriptors(
  prefix = 'bull',
): RetentionPriorityQueueDescriptor[] {
  if (!prefix || prefix.includes('\0')) throw new Error('Invalid BullMQ priority prefix');
  return RETENTION_PRIORITY_QUEUE_NAMES.map((name) => ({
    name,
    wait: `${prefix}:${name}:wait`,
    active: `${prefix}:${name}:active`,
    paused: `${prefix}:${name}:paused`,
    prioritized: `${prefix}:${name}:prioritized`,
    delayed: `${prefix}:${name}:delayed`,
  }));
}

export function retentionPriorityQueueKeys(
  descriptors = buildRetentionPriorityQueueDescriptors(),
): string[] {
  return descriptors.flatMap(({ wait, active, paused, prioritized, delayed }) => [
    wait,
    active,
    paused,
    prioritized,
    delayed,
  ]);
}

/** Minute epoch is seconds (divisible by 60), matching Redis TIME. */
export function retentionPriorityTrafficKey(atMs: number): string {
  return `${RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX}:${Math.floor(atMs / 60_000) * 60}`;
}

export type RetentionPriorityPermit = {
  version: typeof RETENTION_PRIORITY_VERSION;
  sampleStartedAtMs: number;
  validUntilMs: number;
};

export type RetentionPriorityReservationOptions = {
  version: typeof RETENTION_PRIORITY_VERSION;
  dimensions: number;
  retention: boolean;
  operationId?: string;
};

// FLAG: These observations never authorize another module's effect. A failed writer
// leaves cleanup denied; existing higher-priority HTTP keeps its own transport guards.
export const RETENTION_PRIORITY_RECORD_TRAFFIC_SCRIPT = `
-- MAX_RETENTION_PRIORITY_TRAFFIC_V1
local field = ARGV[1]
if field ~= 'arrivals' and field ~= 'http' then return redis.error_reply('Invalid traffic field') end
local time = redis.call('TIME')
local minute = math.floor(tonumber(time[1]) / 60) * 60
local key = KEYS[1] .. ':' .. tostring(minute)
redis.call('HINCRBY', key, field, 1)
redis.call('EXPIRE', key, tonumber(ARGV[2]))
return minute
`;

export const HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_ACQUIRE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local count = redis.pcall('ZCARD', KEYS[1])
if type(count) == 'table' or count >= ${HIGHER_PRIORITY_ACTIVITY_LIMIT} then
  redis.call('SET', KEYS[2], 'activity_coverage_unavailable')
  return 0
end
redis.call('ZADD', KEYS[1], nowMs + tonumber(ARGV[2]), ARGV[1])
return 1
`;

export const HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_RENEW_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local score = redis.pcall('ZSCORE', KEYS[1], ARGV[1])
if type(score) == 'table' or not score or tonumber(score) <= nowMs then
  redis.call('SET', KEYS[2], 'activity_coverage_lost')
  return 0
end
redis.call('ZADD', KEYS[1], 'XX', nowMs + tonumber(ARGV[2]), ARGV[1])
return 1
`;

export const HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_RELEASE_V1
local result = redis.pcall('ZREM', KEYS[1], ARGV[1])
if type(result) == 'table' or result ~= 1 then
  redis.call('SET', KEYS[2], 'activity_release_unknown')
  return 0
end
return 1
`;

// FLAG: Run before every limiter write. Stale leases remain evidence of an unknown
// observation, never an empty fleet. Missing queue data is valid only under a fresh
// complete sampler permit; malformed structures deny cleanup without consuming slots.
export const RETENTION_PRIORITY_ADMISSION_LUA = `
local function retentionPriorityAdmission(keys, base, nowMs)
  local permitKey = keys[base + 1]
  local activityKey = keys[base + 2]
  local unavailableKey = keys[base + 3]
  if redis.call('EXISTS', unavailableKey) ~= 0 then return 'metrics_unavailable' end
  local activityType = redis.call('TYPE', activityKey).ok
  if activityType ~= 'none' and activityType ~= 'zset' then return 'metrics_unavailable' end
  if activityType == 'zset' and redis.call('ZCARD', activityKey) > 0 then
    local oldest = redis.call('ZRANGE', activityKey, 0, 0, 'WITHSCORES')
    if tonumber(oldest[2]) <= nowMs then return 'metrics_unavailable' end
    return 'higher_priority_active'
  end
  if redis.call('TYPE', permitKey).ok ~= 'hash' then return 'permit_missing' end
  local permit = redis.call('HMGET', permitKey, 'version', 'sampleStartedAtMs', 'validUntilMs')
  local sampled = tonumber(permit[2])
  local validUntil = tonumber(permit[3])
  local ttl = redis.call('PTTL', permitKey)
  if permit[1] ~= '${RETENTION_PRIORITY_VERSION}' or not sampled or not validUntil or
      sampled ~= math.floor(sampled) or validUntil ~= math.floor(validUntil) or
      sampled > nowMs or nowMs - sampled > 2000 or validUntil <= nowMs or
      validUntil - nowMs > 1000 or ttl <= 0 or ttl > 1000 then return 'permit_expired' end
  for index = base + 4, #keys, 5 do
    for offset = 0, 2 do
      local key = keys[index + offset]
      local kind = redis.call('TYPE', key).ok
      if kind ~= 'none' and kind ~= 'list' then return 'metrics_unavailable' end
      if kind == 'list' and redis.call('LLEN', key) > 0 then
        if offset == 1 then return 'higher_priority_active' end
        return 'higher_priority_ready'
      end
    end
    for offset = 3, 4 do
      local key = keys[index + offset]
      local kind = redis.call('TYPE', key).ok
      if kind ~= 'none' and kind ~= 'zset' then return 'metrics_unavailable' end
      if kind == 'zset' then
        if offset == 3 and redis.call('ZCARD', key) > 0 then return 'higher_priority_ready' end
        if offset == 4 and #redis.call('ZRANGEBYSCORE', key, '-inf',
            (nowMs + 1) * 4096 - 1, 'LIMIT', 0, 1) > 0 then return 'higher_priority_ready' end
      end
    end
  end
  return nil
end
`;
