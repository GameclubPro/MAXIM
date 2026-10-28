import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { POOL_DISPATCH_PENDING_KEY } from './commercial-llm-pool.protocol';
import {
  CommercialLlmEnforcementMailbox,
  COMMERCIAL_LLM_ENFORCEMENT_KEYS,
  type CommercialLlmAdmissionResult,
} from './commercial-llm-enforcement.mailbox';
import {
  commercialLlmRequestSchema,
  commercialLlmSourceCurrent,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

const prefix = 'commercial-llm-enforcement:pool-v2';
export const COMMERCIAL_LLM_POOL_ADMISSION_KEYS = Object.fromEntries(
  Object.keys(COMMERCIAL_LLM_ENFORCEMENT_KEYS).map((key) => [
    key,
    `${prefix}:${key === 'slotNext' ? 'slot-next' : key}`,
  ]),
) as { [Key in keyof typeof COMMERCIAL_LLM_ENFORCEMENT_KEYS]: string };
export const COMMERCIAL_LLM_POOL_ACTIVE_LIMIT = 3;
const rawKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
const chatKey = (source: CommercialLlmSource) =>
  createHash('sha256').update(source.chatId).digest('hex');
const decode = `local function decode(raw)
  if not raw then return nil end
  local ok, item = pcall(cjson.decode, raw)
  if ok and type(item) == 'table' and type(item.source) == 'table' then return item end
  return nil
end
local function promote(head, tail)
  if redis.call('EXISTS', head) == 0 and redis.call('EXISTS', tail) == 1 then redis.call('RENAME', tail, head) end
end
`;
// FLAG: Every iteration is bounded by three active sources and two queued inputs.
// Model slots are independent; source ownership remains held through consultation.
const prune = `${decode}
local function prune(active, primary, secondary, worker, now)
  if redis.call('HLEN', active) > 3 or redis.call('HLEN', primary) > 3 or redis.call('HLEN', secondary) > 3 then return false end
  local live = {}
  local rows = redis.call('HGETALL', active)
  for i = 1, #rows, 2 do
    local item = decode(rows[i + 1])
    if not item or item.worker ~= worker or type(item.source.deadlineAtMs) ~= 'number' or item.source.deadlineAtMs <= now then
      redis.call('HDEL', active, rows[i])
    else live[rows[i + 1]] = true end
  end
  for _, key in ipairs({primary, secondary}) do
    local claims = redis.call('HGETALL', key)
    for i = 1, #claims, 2 do
      if not live[claims[i + 1]] then redis.call('HDEL', key, claims[i]) end
    end
  end
  return true
end
local function chatBusy(active, primary, chatHash, chatId, messageId)
  if redis.call('HEXISTS', primary, chatHash) > 0 then return true end
  local count = 0
  for _, raw in ipairs(redis.call('HVALS', active)) do
    local item = decode(raw)
    if item and item.source.chatId == chatId then
      count = count + 1
      if item.source.messageId == messageId then return true end
    end
  end
  return count >= 2
end
`;

export class CommercialLlmPoolAdmissionMailbox extends CommercialLlmEnforcementMailbox {
  constructor(redis: Redis) {
    super(redis, COMMERCIAL_LLM_POOL_ADMISSION_KEYS);
  }

  override async advertise(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `${prune}
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local clock = redis.call('TIME'); local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      if not prune(KEYS[3], KEYS[4], KEYS[5], ARGV[1], now) then return 0 end
      redis.call('SET', KEYS[2], ARGV[1], 'PX', 2500); return 1`,
        5,
        this.keys.worker,
        this.keys.ready,
        this.keys.active,
        this.keys.primary,
        this.keys.secondary,
        worker,
      )) === 1
    );
  }

  override async offerDetailed(offer: {
    source: CommercialLlmSource;
    excerpt: string;
  }): Promise<CommercialLlmAdmissionResult> {
    if (offer.source.version !== 2 || !commercialLlmSourceCurrent(offer.source))
      return 'source_expired';
    const worker = await this.redis.get(this.keys.ready);
    if (!worker) return 'not_ready';
    const request = commercialLlmRequestSchema.parse({
      ...offer,
      worker,
      submittedAtMs: Date.now(),
    });
    const raw = JSON.stringify(request);
    return (await this.redis.eval(
      `${prune}
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 'worker_changed' end
      if redis.call('GET', KEYS[2]) ~= ARGV[1] then return 'not_ready' end
      local clock = redis.call('TIME'); local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      if tonumber(ARGV[4]) <= now then return 'source_expired' end
      if tonumber(ARGV[5]) < now - 10000 or tonumber(ARGV[5]) > now + 5000 then return 'source_stale' end
      if not prune(KEYS[5], KEYS[6], KEYS[7], ARGV[1], now) then return 'active_limit' end
      if chatBusy(KEYS[5], KEYS[6], ARGV[6], ARGV[7], ARGV[8]) then return 'chat_busy' end
      promote(KEYS[3], KEYS[4])
      for _, key in ipairs({KEYS[3], KEYS[4]}) do
        local queued = decode(redis.call('GET', key))
        if queued and queued.source.chatId == ARGV[7] then return 'chat_busy' end
      end
      local target = nil
      if redis.call('EXISTS', KEYS[3]) == 0 then target = KEYS[3]
      elseif redis.call('EXISTS', KEYS[4]) == 0 then target = KEYS[4] end
      if not target then return 'buffer_full' end
      local expiry = math.min(tonumber(ARGV[4]), tonumber(ARGV[3]) + 3000)
      if expiry <= now then return 'source_expired' end
      redis.call('SET', target, ARGV[2], 'PX', expiry - now)
      return 'accepted'`,
      7,
      this.keys.worker,
      this.keys.ready,
      this.keys.slot,
      this.keys.slotNext,
      this.keys.active,
      this.keys.primary,
      this.keys.secondary,
      worker,
      raw,
      request.submittedAtMs,
      offer.source.deadlineAtMs,
      offer.source.eventAtMs,
      chatKey(offer.source),
      offer.source.chatId,
      offer.source.messageId,
    )) as CommercialLlmAdmissionResult;
  }

  override async take(
    worker: string,
  ): Promise<{ request: CommercialLlmRequest; raw: string } | null> {
    const raw = await this.redis.eval(
      `${decode}if redis.call('GET', KEYS[3]) ~= ARGV[1] then return nil end
      promote(KEYS[1], KEYS[2]); return redis.call('GET', KEYS[1])`,
      3,
      this.keys.slot,
      this.keys.slotNext,
      this.keys.worker,
      worker,
    );
    if (typeof raw !== 'string') return null;
    let request: CommercialLlmRequest | undefined;
    try {
      request = commercialLlmRequestSchema.parse(JSON.parse(raw));
    } catch {
      /* Invalid input is discarded only by exact head CAS below. */
    }
    const reason =
      !request || request.source.version !== 2
        ? 'invalid_pending'
        : request.worker !== worker
          ? 'foreign_worker'
          : !commercialLlmSourceCurrent(request.source) ||
              Date.now() - request.submittedAtMs > COMMERCIAL_LLM_PENDING_MAX_AGE_MS ||
              request.submittedAtMs > Date.now() + 1000
            ? 'pending_expired'
            : null;
    if (reason || !request) {
      await this.redis.eval(
        `${decode}if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
        redis.call('DEL', KEYS[1]); promote(KEYS[1], KEYS[2]); redis.call('HINCRBY', KEYS[4], ARGV[3], 1)
        redis.call('EXPIRE', KEYS[4], 86400); return 1`,
        4,
        this.keys.slot,
        this.keys.slotNext,
        this.keys.worker,
        this.keys.metrics,
        raw,
        worker,
        reason ?? 'invalid_pending',
      );
      return null;
    }
    const accepted = await this.redis.eval(
      `${prune}
      if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
      local clock = redis.call('TIME'); local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      if tonumber(ARGV[5]) <= now or now - tonumber(ARGV[4]) > 3000 or tonumber(ARGV[4]) > now + 1000 then
        redis.call('DEL', KEYS[1]); promote(KEYS[1], KEYS[2]); redis.call('HINCRBY', KEYS[7], 'pending_expired', 1)
        redis.call('EXPIRE', KEYS[7], 86400); return 0
      end
      if not prune(KEYS[4], KEYS[5], KEYS[6], ARGV[2], now) or redis.call('HLEN', KEYS[4]) >= 3 then return 0 end
      if chatBusy(KEYS[4], KEYS[5], ARGV[6], ARGV[7], ARGV[8]) then return 0 end
      if redis.call('HLEN', KEYS[8]) > 3 then return 0 end
      local pending = redis.call('HGETALL', KEYS[8])
      for i = 1, #pending, 2 do
        local item = decode(pending[i + 1])
        if not item or item.worker ~= ARGV[2] or type(item.source.deadlineAtMs) ~= 'number' or item.source.deadlineAtMs <= now then
          redis.call('HDEL', KEYS[8], pending[i])
        end
      end
      if redis.call('HLEN', KEYS[8]) >= 3 then return 0 end
      redis.call('HSET', KEYS[4], ARGV[3], ARGV[1]); redis.call('HSET', KEYS[5], ARGV[6], ARGV[1])
      redis.call('HSET', KEYS[8], ARGV[9], ARGV[1])
      if redis.call('PEXPIRETIME', KEYS[8]) < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[8], ARGV[5]) end
      for _, key in ipairs({KEYS[4], KEYS[5]}) do
        if redis.call('PEXPIRETIME', key) < tonumber(ARGV[5]) then redis.call('PEXPIREAT', key, ARGV[5]) end
      end
      redis.call('DEL', KEYS[1]); promote(KEYS[1], KEYS[2]); return 1`,
      8,
      this.keys.slot,
      this.keys.slotNext,
      this.keys.worker,
      this.keys.active,
      this.keys.primary,
      this.keys.secondary,
      this.keys.metrics,
      POOL_DISPATCH_PENDING_KEY,
      raw,
      worker,
      rawKey(raw),
      request.submittedAtMs,
      request.source.deadlineAtMs,
      chatKey(request.source),
      request.source.chatId,
      request.source.messageId,
      request.source.nonce,
    );
    return accepted === 1 ? { request, raw } : null;
  }

  override async releasePrimary(raw: string, worker: string): Promise<boolean> {
    const parsed = this.parseOwned(raw, worker);
    if (!parsed) return false;
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] then return 0 end
      if redis.call('HGET', KEYS[4], ARGV[5]) == ARGV[3] then redis.call('HDEL', KEYS[4], ARGV[5]) end
      if redis.call('HGET', KEYS[3], ARGV[4]) == ARGV[3] then return redis.call('HDEL', KEYS[3], ARGV[4]) end; return 0`,
        4,
        this.keys.worker,
        this.keys.active,
        this.keys.primary,
        POOL_DISPATCH_PENDING_KEY,
        worker,
        rawKey(raw),
        raw,
        chatKey(parsed.source),
        parsed.source.nonce,
      )) === 1
    );
  }

  override async claimSecondary(raw: string, worker: string): Promise<boolean> {
    const parsed = this.parseOwned(raw, worker);
    if (!parsed) return false;
    return (
      (await this.redis.eval(
        `${prune}
      if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local clock = redis.call('TIME'); local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
      if tonumber(ARGV[5]) <= now or not prune(KEYS[2], KEYS[3], KEYS[4], ARGV[1], now) then return 0 end
      if redis.call('HGET', KEYS[2], ARGV[2]) ~= ARGV[3] or redis.call('HGET', KEYS[3], ARGV[4]) == ARGV[3]
        or redis.call('HEXISTS', KEYS[4], ARGV[4]) > 0 then return 0 end
      redis.call('HSET', KEYS[4], ARGV[4], ARGV[3])
      if redis.call('PEXPIRETIME', KEYS[4]) < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[4], ARGV[5]) end
      return 1`,
        4,
        this.keys.worker,
        this.keys.active,
        this.keys.primary,
        this.keys.secondary,
        worker,
        rawKey(raw),
        raw,
        chatKey(parsed.source),
        parsed.source.deadlineAtMs,
      )) === 1
    );
  }

  override async finish(raw: string, worker?: string): Promise<void> {
    const parsed = this.parseOwned(raw, worker);
    if (!parsed) return;
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      if redis.call('HGET', KEYS[5], ARGV[5]) == ARGV[3] then redis.call('HDEL', KEYS[5], ARGV[5]) end
      if redis.call('HGET', KEYS[2], ARGV[2]) == ARGV[3] then redis.call('HDEL', KEYS[2], ARGV[2]) end
      for _, key in ipairs({KEYS[3], KEYS[4]}) do
        if redis.call('HGET', key, ARGV[4]) == ARGV[3] then redis.call('HDEL', key, ARGV[4]) end
      end; return 1`,
      5,
      this.keys.worker,
      this.keys.active,
      this.keys.primary,
      this.keys.secondary,
      POOL_DISPATCH_PENDING_KEY,
      parsed.worker,
      rawKey(raw),
      raw,
      chatKey(parsed.source),
      parsed.source.nonce,
    );
  }

  private parseOwned(raw: string, worker?: string): CommercialLlmRequest | null {
    try {
      const request = commercialLlmRequestSchema.parse(JSON.parse(raw));
      return request.source.version === 2 && (!worker || worker === request.worker)
        ? request
        : null;
    } catch {
      return null;
    }
  }
}
