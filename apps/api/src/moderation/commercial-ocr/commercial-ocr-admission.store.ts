import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import {
  normalizeCommercialOcrActionEligibility,
  validateCommercialOcrImageCount,
} from './commercial-ocr.queue';
import { COMMERCIAL_OCR_REDIS_OPTIONS } from './commercial-ocr-redis.options';

const ADMISSION_NAMESPACE = 'commercial-ocr:admission:v2';
const REDIS_OPERATION_TIMEOUT_MS = 1_000;
const MIN_RESERVATION_TTL_MS = 5_000;
const MAX_RESERVATION_TTL_MS = 11 * 60_000;
const MAX_JOB_AGE_MS = 10 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_GLOBAL_IMAGE_UNITS = 10_000;
const MAX_CHAT_IMAGE_UNITS = 1_000;
const ADMISSION_CLEANUP_BATCH_SIZE = 100;

// Metadata is chatHash|imageUnits|state|capacityHeld. P=pending, A=actionable, O=observation.
// FLAG: Redis TIME, expiry cleanup, duplicate collapse, capacity checks and the absorbing
// observation state must stay atomic. Only activate() may perform P -> A, and no operation may
// restore actionability after O has been stored.
const RESERVE_SCRIPT = `
local function extend_ttl(key, ttl_ms)
  local current_ttl = redis.call('PTTL', key)
  if current_ttl >= 0 and current_ttl < ttl_ms then
    redis.call('PEXPIRE', key, ttl_ms)
  elseif current_ttl == -1 then
    redis.call('PEXPIRE', key, ttl_ms)
  end
end

local function decrement_or_delete(key, units)
  local remaining = redis.call('DECRBY', key, units)
  if remaining <= 0 then
    redis.call('DEL', key)
  end
end

local function release_capacity(job_id, chat_hash, units, chat_prefix)
  decrement_or_delete(KEYS[3], units)
  local origin_prefix = chat_prefix .. chat_hash
  local origin_expiry = origin_prefix .. ':expiry'
  local origin_weights = origin_prefix .. ':weights'
  local origin_units_key = origin_prefix .. ':units'
  local origin_units = tonumber(redis.call('HGET', origin_weights, job_id) or '0')
  if origin_units > 0 then
    decrement_or_delete(origin_units_key, origin_units)
  end
  redis.call('HDEL', origin_weights, job_id)
  redis.call('ZREM', origin_expiry, job_id)
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local source_at_ms = tonumber(ARGV[4])
if source_at_ms < now_ms - tonumber(ARGV[5]) or source_at_ms > now_ms + tonumber(ARGV[9]) then
  return {5, 'O'}
end

local expired_global = redis.call(
  'ZRANGEBYSCORE', KEYS[1], '-inf', now_ms, 'LIMIT', 0, tonumber(ARGV[11])
)
for _, expired_job_id in ipairs(expired_global) do
  local metadata = redis.call('HGET', KEYS[2], expired_job_id)
  if metadata then
    local expired_chat_hash, expired_units, expired_state, capacity_held = string.match(
      metadata,
      '^([^|]+)|(%d+)|([PAO])|([01])$'
    )
    if capacity_held == '1' and tonumber(expired_units) > 0 then
      release_capacity(expired_job_id, expired_chat_hash, tonumber(expired_units), ARGV[12])
    end
  end
  redis.call('HDEL', KEYS[2], expired_job_id)
  redis.call('ZREM', KEYS[1], expired_job_id)
end

local expired_chat = redis.call(
  'ZRANGEBYSCORE', KEYS[4], '-inf', now_ms, 'LIMIT', 0, tonumber(ARGV[11])
)
for _, expired_job_id in ipairs(expired_chat) do
  local expired_units = tonumber(redis.call('HGET', KEYS[5], expired_job_id) or '0')
  if expired_units > 0 then
    decrement_or_delete(KEYS[6], expired_units)
  end
  redis.call('HDEL', KEYS[5], expired_job_id)
  redis.call('ZREM', KEYS[4], expired_job_id)
end

local key_ttl_ms = tonumber(ARGV[10]) * 2
for _, key in ipairs(KEYS) do
  extend_ttl(key, key_ttl_ms)
end

local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then
  local stored_chat_hash, stored_units, stored_state, capacity_held = string.match(
    existing,
    '^([^|]+)|(%d+)|([PAO])|([01])$'
  )
  if not stored_chat_hash or stored_chat_hash ~= ARGV[2] or tonumber(stored_units) ~= tonumber(ARGV[3]) then
    return {6, 'O'}
  end
  if ARGV[8] == 'O' and (stored_state ~= 'O' or capacity_held == '1') then
    if capacity_held == '1' then
      release_capacity(ARGV[1], stored_chat_hash, tonumber(stored_units), ARGV[12])
      capacity_held = '0'
    end
    stored_state = 'O'
    redis.call(
      'HSET',
      KEYS[2],
      ARGV[1],
      stored_chat_hash .. '|' .. stored_units .. '|O|' .. capacity_held
    )
  end
  return {2, stored_state}
end

local global_units = tonumber(redis.call('GET', KEYS[3]) or '0')
if global_units + tonumber(ARGV[3]) > tonumber(ARGV[6]) then
  return {3, 'O'}
end
-- Observation work may use only the unreserved portion of global capacity. Pending/actionable
-- work still uses the full ceiling, so new observations cannot consume an enabled reserve.
if ARGV[8] == 'O' and
  global_units + tonumber(ARGV[3]) > tonumber(ARGV[6]) - tonumber(ARGV[13]) then
  return {7, 'O'}
end
local chat_units = tonumber(redis.call('GET', KEYS[6]) or '0')
if chat_units + tonumber(ARGV[3]) > tonumber(ARGV[7]) then
  return {4, 'O'}
end

local expires_at_ms = now_ms + tonumber(ARGV[10])
redis.call('ZADD', KEYS[1], expires_at_ms, ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2] .. '|' .. ARGV[3] .. '|' .. ARGV[8] .. '|1')
redis.call('SET', KEYS[3], tostring(global_units + tonumber(ARGV[3])), 'PX', key_ttl_ms)
redis.call('ZADD', KEYS[4], expires_at_ms, ARGV[1])
redis.call('HSET', KEYS[5], ARGV[1], ARGV[3])
redis.call('SET', KEYS[6], tostring(chat_units + tonumber(ARGV[3])), 'PX', key_ttl_ms)
for _, key in ipairs({KEYS[1], KEYS[2], KEYS[4], KEYS[5]}) do
  extend_ttl(key, key_ttl_ms)
end
return {1, ARGV[8]}
`;

// FLAG: Activation is a compare-and-set from a live pending reservation. Missing, released and
// observation identities can never be made actionable.
const ACTIVATE_SCRIPT = `
local function extend_ttl(key, ttl_ms)
  local current_ttl = redis.call('PTTL', key)
  if current_ttl >= 0 and current_ttl < ttl_ms then
    redis.call('PEXPIRE', key, ttl_ms)
  elseif current_ttl == -1 then
    redis.call('PEXPIRE', key, ttl_ms)
  end
end

local function decrement_or_delete(key, units)
  local remaining = redis.call('DECRBY', key, units)
  if remaining <= 0 then
    redis.call('DEL', key)
  end
end

local metadata = redis.call('HGET', KEYS[2], ARGV[1])
if not metadata then
  return -1
end
local chat_hash, units, state, capacity_held = string.match(
  metadata,
  '^([^|]+)|(%d+)|([PAO])|([01])$'
)
if not chat_hash or not units or not state or not capacity_held then
  return -2
end
if state ~= 'P' and state ~= 'A' and state ~= 'O' then
  return -2
end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at_ms = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or '0')
if expires_at_ms <= now_ms then
  if capacity_held == '1' then
    decrement_or_delete(KEYS[3], tonumber(units))
  end
  local chat_prefix = ARGV[2] .. chat_hash
  local chat_expiry = chat_prefix .. ':expiry'
  local chat_weights = chat_prefix .. ':weights'
  local chat_units_key = chat_prefix .. ':units'
  local chat_units = tonumber(redis.call('HGET', chat_weights, ARGV[1]) or '0')
  if capacity_held == '1' and chat_units > 0 then
    decrement_or_delete(chat_units_key, chat_units)
  end
  redis.call('HDEL', chat_weights, ARGV[1])
  redis.call('ZREM', chat_expiry, ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], chat_hash .. '|' .. units .. '|O|0')
  redis.call('ZADD', KEYS[1], now_ms + tonumber(ARGV[3]), ARGV[1])
  local key_ttl_ms = tonumber(ARGV[3]) * 2
  extend_ttl(KEYS[1], key_ttl_ms)
  extend_ttl(KEYS[2], key_ttl_ms)
  return -3
end
if state == 'O' then
  return 0
end
if capacity_held ~= '1' then
  return -2
end
if state == 'A' then
  return 2
end
redis.call('HSET', KEYS[2], ARGV[1], chat_hash .. '|' .. units .. '|A|1')
return 1
`;

// FLAG: Suppression creates an absorbing observation tombstone even when no reservation exists.
// This is what makes false-before-true and ambiguous Queue.add outcomes fail open.
const SUPPRESS_SCRIPT = `
local function extend_ttl(key, ttl_ms)
  local current_ttl = redis.call('PTTL', key)
  if current_ttl >= 0 and current_ttl < ttl_ms then
    redis.call('PEXPIRE', key, ttl_ms)
  elseif current_ttl == -1 then
    redis.call('PEXPIRE', key, ttl_ms)
  end
end

local function decrement_or_delete(key, units)
  local remaining = redis.call('DECRBY', key, units)
  if remaining <= 0 then
    redis.call('DEL', key)
  end
end

local function release_capacity(job_id, chat_hash, units, chat_prefix)
  decrement_or_delete(KEYS[3], units)
  local origin_prefix = chat_prefix .. chat_hash
  local origin_expiry = origin_prefix .. ':expiry'
  local origin_weights = origin_prefix .. ':weights'
  local origin_units_key = origin_prefix .. ':units'
  local origin_units = tonumber(redis.call('HGET', origin_weights, job_id) or '0')
  if origin_units > 0 then
    decrement_or_delete(origin_units_key, origin_units)
  end
  redis.call('HDEL', origin_weights, job_id)
  redis.call('ZREM', origin_expiry, job_id)
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at_ms = now_ms + tonumber(ARGV[4])
local expired_global = redis.call(
  'ZRANGEBYSCORE', KEYS[1], '-inf', now_ms, 'LIMIT', 0, tonumber(ARGV[5])
)
for _, expired_job_id in ipairs(expired_global) do
  if expired_job_id ~= ARGV[1] then
    local expired_metadata = redis.call('HGET', KEYS[2], expired_job_id)
    if expired_metadata then
      local expired_chat_hash, expired_units, expired_state, capacity_held = string.match(
        expired_metadata,
        '^([^|]+)|(%d+)|([PAO])|([01])$'
      )
      if capacity_held == '1' and tonumber(expired_units) > 0 then
        release_capacity(expired_job_id, expired_chat_hash, tonumber(expired_units), ARGV[6])
      end
    end
    redis.call('HDEL', KEYS[2], expired_job_id)
    redis.call('ZREM', KEYS[1], expired_job_id)
  end
end
local existing = redis.call('HGET', KEYS[2], ARGV[1])
if existing then
  local stored_chat_hash, stored_units, stored_state, capacity_held = string.match(
    existing,
    '^([^|]+)|(%d+)|([PAO])|([01])$'
  )
  if not stored_chat_hash or stored_chat_hash ~= ARGV[2] or tonumber(stored_units) < 1 then
    return -2
  end
  if capacity_held == '1' then
    decrement_or_delete(KEYS[3], tonumber(stored_units))
    local chat_units = tonumber(redis.call('HGET', KEYS[5], ARGV[1]) or '0')
    if chat_units > 0 then
      decrement_or_delete(KEYS[6], chat_units)
    end
    redis.call('HDEL', KEYS[5], ARGV[1])
    redis.call('ZREM', KEYS[4], ARGV[1])
  end
  redis.call('HSET', KEYS[2], ARGV[1], stored_chat_hash .. '|' .. stored_units .. '|O|0')
else
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[2] .. '|' .. ARGV[3] .. '|O|0')
end
local current_expiry = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or '0')
redis.call('ZADD', KEYS[1], math.max(current_expiry, expires_at_ms), ARGV[1])
local key_ttl_ms = tonumber(ARGV[4]) * 2
extend_ttl(KEYS[1], key_ttl_ms)
extend_ttl(KEYS[2], key_ttl_ms)
return existing and 2 or 1
`;

const RESOLVE_STATE_SCRIPT = `
local metadata = redis.call('HGET', KEYS[2], ARGV[1])
if not metadata then
  return -1
end
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
local expires_at_ms = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[1]) or '0')
if expires_at_ms <= now_ms then
  return -1
end
local state = string.match(metadata, '^.*|([PAO])|[01]$')
if state == 'P' then return 0 end
if state == 'A' then return 1 end
if state == 'O' then return 2 end
return -2
`;

// Completed work remains an observation tombstone while its original admission expiry is live.
// Capacity is released exactly once, while a late activate or replay remains unable to act.
const RELEASE_SCRIPT = `
local metadata = redis.call('HGET', KEYS[2], ARGV[1])
if not metadata then
  return 1
end
local stored_chat_hash, stored_units, _, capacity_held = string.match(
  metadata,
  '^([^|]+)|(%d+)|([PAO])|([01])$'
)
if not stored_chat_hash or stored_chat_hash ~= ARGV[2] or not stored_units or not capacity_held then
  return 0
end
if capacity_held == '1' then
  local remaining_global = redis.call('DECRBY', KEYS[3], tonumber(stored_units))
  if remaining_global <= 0 then
    redis.call('DEL', KEYS[3])
  end
  local chat_units = tonumber(redis.call('HGET', KEYS[5], ARGV[1]) or '0')
  if chat_units > 0 then
    local remaining_chat = redis.call('DECRBY', KEYS[6], chat_units)
    if remaining_chat <= 0 then
      redis.call('DEL', KEYS[6])
    end
  end
  redis.call('HDEL', KEYS[5], ARGV[1])
  redis.call('ZREM', KEYS[4], ARGV[1])
end
redis.call('HSET', KEYS[2], ARGV[1], stored_chat_hash .. '|' .. stored_units .. '|O|0')
return 1
`;

export type CommercialOcrAdmissionState = 'pending' | 'actionable' | 'observation';

export type CommercialOcrAdmissionLimits = Readonly<{
  maxGlobalImageUnits: number;
  maxChatImageUnits: number;
  reservedActionableImageUnits: number;
  maxJobAgeMs: number;
  reservationTtlMs: number;
}>;

export type CommercialOcrAdmissionResult =
  | { kind: 'admitted' | 'duplicate'; state: CommercialOcrAdmissionState }
  | {
      kind: 'rejected_global' | 'rejected_chat' | 'rejected_age' | 'rejected_actionable_reserve';
    }
  | { kind: 'unavailable' };

export type CommercialOcrAdmissionStateResult =
  | { kind: 'available'; state: CommercialOcrAdmissionState }
  | { kind: 'missing' }
  | { kind: 'unavailable' };

export type CommercialOcrAdmissionActivationResult =
  | 'activated'
  | 'already_actionable'
  | 'suppressed'
  | 'expired'
  | 'missing'
  | 'unavailable';

export type CommercialOcrAdmissionSuppressionResult = 'suppressed' | 'unavailable';

@Injectable()
export class CommercialOcrAdmissionStore implements OnModuleDestroy {
  private readonly logger = new Logger(CommercialOcrAdmissionStore.name);
  private readonly redis: Redis;

  constructor(configService: ConfigService) {
    this.redis = new Redis(
      configService.getOrThrow<string>('REDIS_URL'),
      COMMERCIAL_OCR_REDIS_OPTIONS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }

  async reserve(params: {
    jobId: string;
    chatId: string;
    sourceCreatedAt: string;
    imageCount: number;
    actionEligible: unknown;
    limits: CommercialOcrAdmissionLimits;
  }): Promise<CommercialOcrAdmissionResult> {
    const input = validateReservation(params);
    const keys = buildAdmissionKeys(input.chatId);
    const desiredState = input.actionEligible ? 'P' : 'O';
    try {
      const response = (await this.runRedisOperation(
        this.redis.eval(
          RESERVE_SCRIPT,
          6,
          keys.globalExpiry,
          keys.globalMetadata,
          keys.globalUnits,
          keys.chatExpiry,
          keys.chatWeights,
          keys.chatUnits,
          input.jobId,
          keys.chatHash,
          String(input.imageCount),
          String(input.sourceCreatedAtMs),
          String(input.limits.maxJobAgeMs),
          String(input.limits.maxGlobalImageUnits),
          String(input.limits.maxChatImageUnits),
          desiredState,
          String(MAX_FUTURE_SKEW_MS),
          String(input.limits.reservationTtlMs),
          String(ADMISSION_CLEANUP_BATCH_SIZE),
          `${ADMISSION_NAMESPACE}:chat:`,
          String(input.limits.reservedActionableImageUnits),
        ),
      )) as Array<string | number | Buffer>;
      const status = Number(readRedisValue(response[0]));
      const state = decodeAdmissionState(readRedisValue(response[1]));
      if (status === 1 && state) return { kind: 'admitted', state };
      if (status === 2 && state) return { kind: 'duplicate', state };
      if (status === 3) return { kind: 'rejected_global' };
      if (status === 4) return { kind: 'rejected_chat' };
      if (status === 5) return { kind: 'rejected_age' };
      if (status === 7) return { kind: 'rejected_actionable_reserve' };
      return { kind: 'unavailable' };
    } catch {
      this.logger.warn('Commercial OCR admission unavailable');
      return { kind: 'unavailable' };
    }
  }

  async activate(params: {
    jobId: string;
    tombstoneTtlMs: number;
  }): Promise<CommercialOcrAdmissionActivationResult> {
    const normalizedJobId = validateJobId(params.jobId);
    const tombstoneTtlMs = validateBoundedInteger(
      params.tombstoneTtlMs,
      MIN_RESERVATION_TTL_MS,
      MAX_RESERVATION_TTL_MS,
      'tombstoneTtlMs',
    );
    try {
      const response = Number(
        await this.runRedisOperation(
          this.redis.eval(
            ACTIVATE_SCRIPT,
            3,
            `${ADMISSION_NAMESPACE}:global:expiry`,
            `${ADMISSION_NAMESPACE}:global:metadata`,
            `${ADMISSION_NAMESPACE}:global:units`,
            normalizedJobId,
            `${ADMISSION_NAMESPACE}:chat:`,
            String(tombstoneTtlMs),
          ),
        ),
      );
      if (response === 1) return 'activated';
      if (response === 2) return 'already_actionable';
      if (response === 0) return 'suppressed';
      if (response === -3) return 'expired';
      if (response === -1) return 'missing';
      return 'unavailable';
    } catch {
      this.logger.warn('Commercial OCR admission activation unavailable');
      return 'unavailable';
    }
  }

  async suppress(params: {
    jobId: string;
    chatId: string;
    imageCount: number;
    tombstoneTtlMs: number;
  }): Promise<CommercialOcrAdmissionSuppressionResult> {
    const input = validateSuppression(params);
    const keys = buildAdmissionKeys(input.chatId);
    try {
      const response = Number(
        await this.runRedisOperation(
          this.redis.eval(
            SUPPRESS_SCRIPT,
            6,
            keys.globalExpiry,
            keys.globalMetadata,
            keys.globalUnits,
            keys.chatExpiry,
            keys.chatWeights,
            keys.chatUnits,
            input.jobId,
            keys.chatHash,
            String(input.imageCount),
            String(input.tombstoneTtlMs),
            String(ADMISSION_CLEANUP_BATCH_SIZE),
            `${ADMISSION_NAMESPACE}:chat:`,
          ),
        ),
      );
      return response === 1 || response === 2 ? 'suppressed' : 'unavailable';
    } catch {
      this.logger.warn('Commercial OCR admission suppression unavailable');
      return 'unavailable';
    }
  }

  async resolveState(jobId: string): Promise<CommercialOcrAdmissionStateResult> {
    const normalizedJobId = validateJobId(jobId);
    try {
      const response = Number(
        await this.runRedisOperation(
          this.redis.eval(
            RESOLVE_STATE_SCRIPT,
            2,
            `${ADMISSION_NAMESPACE}:global:expiry`,
            `${ADMISSION_NAMESPACE}:global:metadata`,
            normalizedJobId,
          ),
        ),
      );
      if (response === -1) return { kind: 'missing' };
      if (response === 0) return { kind: 'available', state: 'pending' };
      if (response === 1) return { kind: 'available', state: 'actionable' };
      if (response === 2) return { kind: 'available', state: 'observation' };
      return { kind: 'unavailable' };
    } catch {
      this.logger.warn('Commercial OCR admission state unavailable');
      return { kind: 'unavailable' };
    }
  }

  async release(params: { jobId: string; chatId: string }): Promise<boolean> {
    const jobId = validateJobId(params.jobId);
    const chatId = validateIdentifier(params.chatId, 'chatId');
    const keys = buildAdmissionKeys(chatId);
    try {
      const response = Number(
        await this.runRedisOperation(
          this.redis.eval(
            RELEASE_SCRIPT,
            6,
            keys.globalExpiry,
            keys.globalMetadata,
            keys.globalUnits,
            keys.chatExpiry,
            keys.chatWeights,
            keys.chatUnits,
            jobId,
            keys.chatHash,
          ),
        ),
      );
      return response === 1;
    } catch {
      this.logger.warn('Commercial OCR admission release unavailable');
      return false;
    }
  }

  private runRedisOperation<T>(operation: Promise<T>): Promise<T> {
    return raceWithTimeout({
      operation,
      timeoutMs: REDIS_OPERATION_TIMEOUT_MS,
      onTimeout: () => {
        throw new Error('Commercial OCR admission Redis operation timed out');
      },
    });
  }
}

function validateReservation(params: {
  jobId: string;
  chatId: string;
  sourceCreatedAt: string;
  imageCount: number;
  actionEligible: unknown;
  limits: CommercialOcrAdmissionLimits;
}) {
  const sourceCreatedAtMs = Date.parse(params.sourceCreatedAt);
  if (!Number.isSafeInteger(sourceCreatedAtMs) || sourceCreatedAtMs <= 0) {
    throw new Error('sourceCreatedAt is invalid');
  }
  return {
    jobId: validateJobId(params.jobId),
    chatId: validateIdentifier(params.chatId, 'chatId'),
    sourceCreatedAtMs,
    imageCount: validateCommercialOcrImageCount(params.imageCount),
    actionEligible: normalizeCommercialOcrActionEligibility(params.actionEligible),
    limits: validateLimits(params.limits),
  };
}

function validateSuppression(params: {
  jobId: string;
  chatId: string;
  imageCount: number;
  tombstoneTtlMs: number;
}) {
  return {
    jobId: validateJobId(params.jobId),
    chatId: validateIdentifier(params.chatId, 'chatId'),
    imageCount: validateCommercialOcrImageCount(params.imageCount),
    tombstoneTtlMs: validateBoundedInteger(
      params.tombstoneTtlMs,
      MIN_RESERVATION_TTL_MS,
      MAX_RESERVATION_TTL_MS,
      'tombstoneTtlMs',
    ),
  };
}

function validateLimits(limits: CommercialOcrAdmissionLimits): CommercialOcrAdmissionLimits {
  const maxGlobalImageUnits = validateBoundedInteger(
    limits.maxGlobalImageUnits,
    1,
    MAX_GLOBAL_IMAGE_UNITS,
    'maxGlobalImageUnits',
  );
  const maxChatImageUnits = validateBoundedInteger(
    limits.maxChatImageUnits,
    1,
    Math.min(maxGlobalImageUnits, MAX_CHAT_IMAGE_UNITS),
    'maxChatImageUnits',
  );
  const reservedActionableImageUnits = validateBoundedInteger(
    limits.reservedActionableImageUnits,
    0,
    maxGlobalImageUnits,
    'reservedActionableImageUnits',
  );
  const maxJobAgeMs = validateBoundedInteger(
    limits.maxJobAgeMs,
    1_000,
    MAX_JOB_AGE_MS,
    'maxJobAgeMs',
  );
  const reservationTtlMs = validateBoundedInteger(
    limits.reservationTtlMs,
    MIN_RESERVATION_TTL_MS,
    MAX_RESERVATION_TTL_MS,
    'reservationTtlMs',
  );
  if (reservationTtlMs < maxJobAgeMs + MAX_FUTURE_SKEW_MS) {
    throw new Error('reservationTtlMs is invalid');
  }
  return {
    maxGlobalImageUnits,
    maxChatImageUnits,
    reservedActionableImageUnits,
    maxJobAgeMs,
    reservationTtlMs,
  };
}

function buildAdmissionKeys(chatId: string) {
  const chatHash = createHash('sha256').update(chatId).digest('hex').slice(0, 32);
  const chatPrefix = `${ADMISSION_NAMESPACE}:chat:${chatHash}`;
  return {
    chatHash,
    globalExpiry: `${ADMISSION_NAMESPACE}:global:expiry`,
    globalMetadata: `${ADMISSION_NAMESPACE}:global:metadata`,
    globalUnits: `${ADMISSION_NAMESPACE}:global:units`,
    chatExpiry: `${chatPrefix}:expiry`,
    chatWeights: `${chatPrefix}:weights`,
    chatUnits: `${chatPrefix}:units`,
  };
}

function decodeAdmissionState(value: string): CommercialOcrAdmissionState | null {
  if (value === 'P') return 'pending';
  if (value === 'A') return 'actionable';
  if (value === 'O') return 'observation';
  return null;
}

function validateJobId(value: string): string {
  const normalized = value.trim();
  if (!/^commercial-image-ocr__[a-f0-9]{64}$/u.test(normalized)) {
    throw new Error('jobId is invalid');
  }
  return normalized;
}

function validateIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) {
    throw new Error(`${field} is invalid`);
  }
  return normalized;
}

function validateBoundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function readRedisValue(value: string | number | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value ?? '');
}
