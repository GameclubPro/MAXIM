import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  commercialLlmRequestSchema,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
const prefix = 'commercial-llm-enforcement:v2';
const proofPrefix = 'commercial-llm-enforcement:v1';
export const COMMERCIAL_LLM_PRIMARY_INTERVAL_MS = 2_000;
export const COMMERCIAL_LLM_ACTIVE_LIMIT = 3;
export const COMMERCIAL_LLM_ENFORCEMENT_KEYS = {
  worker: `${prefix}:worker`,
  ready: `${prefix}:ready`,
  slot: `${prefix}:slot`,
  active: `${prefix}:active`,
  primary: `${prefix}:primary`,
  metrics: `${prefix}:metrics`,
  // FLAG: Readback and issued DELETE proofs remain compatible across the ephemeral handoff upgrade.
  status: `${proofPrefix}:status`,
  cooldown: `${prefix}:primary-cooldown`,
} as const;
export type CommercialLlmAdmissionResult =
  | 'accepted'
  | 'no_worker'
  | 'not_ready'
  | 'buffer_full'
  | 'chat_busy'
  | 'active_limit'
  | 'source_stale'
  | 'source_expired'
  | 'worker_changed';
const pendingDiscardReasons = ['pending_expired', 'foreign_worker', 'invalid_pending'] as const;
export type CommercialLlmPendingDiscardReason = (typeof pendingDiscardReasons)[number];
export const commercialLlmProofKey = (source: CommercialLlmSource) =>
  `${proofPrefix}:proof:${commercialLlmSourceKey(source)}`;
const rawKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
function parseRequest(raw: string): CommercialLlmRequest | null {
  try {
    const parsed = commercialLlmRequestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const release =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const decodeLua = `local function decode(value)
  if not value then return nil end
  local ok, request = pcall(cjson.decode, value)
  if ok and type(request) == 'table' then return request end
  return nil
end
`;
// FLAG: Every caller checks HLEN before this bounded pass. Expiry never renews source authority.
const pruneActiveLua = `${decodeLua}local function pruneActive(key, worker, now)
  local rows = redis.call('HGETALL', key)
  for i = 1, #rows, 2 do
    local request = decode(rows[i + 1])
    if not request or request.worker ~= worker or type(request.source) ~= 'table'
      or not tonumber(request.source.deadlineAtMs) or tonumber(request.source.deadlineAtMs) <= now then
      redis.call('HDEL', key, rows[i])
    end
  end
end
`;

export class CommercialLlmEnforcementMailbox {
  private readonly logger = new Logger(CommercialLlmEnforcementMailbox.name);
  constructor(private readonly redis: Redis) {}

  async heartbeat(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `local owner = redis.call('GET', KEYS[1])
      if owner and owner ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 5000); return 1`,
        1,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        worker,
      )) === 1
    );
  }

  async ownsWorker(worker: string): Promise<boolean> {
    return (await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker)) === worker;
  }

  async advertise(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `${pruneActiveLua}
      if redis.call('GET', KEYS[3]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) > 0
          or redis.call('HLEN', KEYS[4]) > tonumber(ARGV[2]) then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      pruneActive(KEYS[4], ARGV[1], now)
      if redis.call('HLEN', KEYS[4]) >= tonumber(ARGV[2]) then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 2500); return 1`,
        4,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
        worker,
        COMMERCIAL_LLM_ACTIVE_LIMIT,
      )) === 1
    );
  }

  async withdraw(worker: string): Promise<void> {
    await this.redis.eval(release, 1, COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready, worker);
  }

  async offer(offer: { source: CommercialLlmSource; excerpt: string }): Promise<boolean> {
    return (await this.offerDetailed(offer)) === 'accepted';
  }

  async offerDetailed(offer: {
    source: CommercialLlmSource;
    excerpt: string;
  }): Promise<CommercialLlmAdmissionResult> {
    if (!commercialLlmSourceCurrent(offer.source)) return 'source_expired';
    const worker = await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready);
    const request = commercialLlmRequestSchema.parse({
      ...offer,
      worker: worker ?? '00000000-0000-4000-8000-000000000000',
      submittedAtMs: Date.now(),
    });
    // FLAG: One pending source is admitted atomically while another source awaits 9B. Actual 4B
    // starts retain their own lease/cooldown; neither buffer admission nor waiting renews a deadline.
    return (await this.redis.eval(
      `${pruneActiveLua}
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[3]) <= now then return 'source_expired' end
      if tonumber(ARGV[4]) < now - 10000 or tonumber(ARGV[4]) > now + 5000 then return 'source_stale' end
      local worker = redis.call('GET', KEYS[3])
      if not worker then return 'no_worker' end
      if redis.call('HLEN', KEYS[4]) > tonumber(ARGV[6]) then return 'active_limit' end
      pruneActive(KEYS[4], worker, now)
      local pending = decode(redis.call('GET', KEYS[2]))
      if pending and type(pending.source) == 'table' and pending.source.chatId == ARGV[5] then return 'chat_busy' end
      local active = redis.call('HVALS', KEYS[4])
      for _, raw in ipairs(active) do
        local item = decode(raw)
        if item and type(item.source) == 'table' and item.source.chatId == ARGV[5] then return 'chat_busy' end
      end
      if redis.call('EXISTS', KEYS[2]) > 0 then return 'buffer_full' end
      if #active >= tonumber(ARGV[6]) then return 'active_limit' end
      local ready = redis.call('GET', KEYS[1])
      if not ready then return 'not_ready' end
      if ready ~= ARGV[1] or worker ~= ARGV[1] then return 'worker_changed' end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]) - now)
      redis.call('DEL', KEYS[1]); return 'accepted'`,
      4,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
      worker ?? '',
      JSON.stringify(request),
      offer.source.deadlineAtMs,
      offer.source.eventAtMs,
      offer.source.chatId,
      COMMERCIAL_LLM_ACTIVE_LIMIT,
    )) as CommercialLlmAdmissionResult;
  }

  private async discardPending(
    raw: string,
    worker: string,
    reason: CommercialLlmPendingDiscardReason,
  ): Promise<void> {
    const discarded = await this.redis.eval(
      `if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[1]); redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
      redis.call('EXPIRE', KEYS[3], 86400); return 1`,
      3,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.metrics,
      raw,
      worker,
      reason,
    );
    if (discarded === 1) this.logPendingDiscard(reason, parseRequest(raw));
  }

  private logPendingDiscard(
    outcome: CommercialLlmPendingDiscardReason,
    request: CommercialLlmRequest | null,
  ): void {
    // FLAG: Only the successful exact discard CAS emits a terminal observation. Schema-validated
    // correlation is limited to the random trace and intake clock; source identifiers/text stay private.
    const intakeWindow = request
      ? new Date(Math.floor(request.submittedAtMs / 60_000) * 60_000)
      : null;
    this.logger.log(
      {
        stage: 'commercial-ai',
        schemaVersion: 2,
        mode: 'ENFORCE',
        outcome,
        ...(request && intakeWindow && Number.isFinite(intakeWindow.getTime())
          ? {
              traceId: request.source.nonce,
              admittedAtMs: request.submittedAtMs,
              admissionWindowStartAt: intakeWindow.toISOString(),
            }
          : {}),
      },
      'Commercial AI pending result',
    );
  }

  async readObservations(): Promise<Partial<Record<CommercialLlmPendingDiscardReason, number>>> {
    const counts = await this.redis.hmget(
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.metrics,
      ...pendingDiscardReasons,
    );
    return Object.fromEntries(
      pendingDiscardReasons.flatMap((reason, index) => {
        const count = Number(counts[index]);
        return Number.isSafeInteger(count) && count > 0 ? [[reason, count]] : [];
      }),
    );
  }

  async take(worker: string): Promise<{ request: CommercialLlmRequest; raw: string } | null> {
    if (!(await this.ownsWorker(worker))) return null;
    const raw = await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot);
    if (!raw) return null;
    const request = parseRequest(raw);
    const reason: CommercialLlmPendingDiscardReason | null = !request
      ? 'invalid_pending'
      : request.worker !== worker
        ? 'foreign_worker'
        : !commercialLlmSourceCurrent(request.source) ||
            Date.now() - request.submittedAtMs > COMMERCIAL_LLM_PENDING_MAX_AGE_MS ||
            request.submittedAtMs > Date.now() + 1000
          ? 'pending_expired'
          : null;
    if (reason || !request) {
      await this.discardPending(raw, worker, reason ?? 'invalid_pending');
      return null;
    }
    // FLAG: Transferring pending to active is one CAS. A busy primary cannot consume the buffer,
    // and releasing 4B never releases the active source/proof authority still needed by 9B.
    const taken = await this.redis.eval(
      `${pruneActiveLua}
      if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[5]) <= now or now - tonumber(ARGV[4]) > tonumber(ARGV[6]) or tonumber(ARGV[4]) > now + 1000 then
        redis.call('DEL', KEYS[1]); redis.call('HINCRBY', KEYS[6], 'pending_expired', 1)
        redis.call('EXPIRE', KEYS[6], 86400); return 2
      end
      if redis.call('HLEN', KEYS[3]) > tonumber(ARGV[8]) then return 0 end
      pruneActive(KEYS[3], ARGV[2], now)
      if redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[8]) or redis.call('EXISTS', KEYS[4], KEYS[5]) > 0 then return 0 end
      redis.call('HSET', KEYS[3], ARGV[3], ARGV[1])
      local expire = redis.call('PEXPIRETIME', KEYS[3])
      if expire < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[3], ARGV[5]) end
      redis.call('SET', KEYS[4], ARGV[1], 'PX', tonumber(ARGV[5]) - now)
      redis.call('SET', KEYS[5], '1', 'PX', ARGV[7]); redis.call('DEL', KEYS[1]); return 1`,
      6,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.primary,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.cooldown,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.metrics,
      raw,
      worker,
      rawKey(raw),
      request.submittedAtMs,
      request.source.deadlineAtMs,
      COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
      COMMERCIAL_LLM_PRIMARY_INTERVAL_MS,
      COMMERCIAL_LLM_ACTIVE_LIMIT,
    );
    if (taken === 2) this.logPendingDiscard('pending_expired', request);
    return taken === 1 ? { request, raw } : null;
  }

  async releasePrimary(raw: string, worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('HGET', KEYS[3], ARGV[3]) ~= ARGV[1] then return 0 end
      if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0`,
        3,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.primary,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
        raw,
        worker,
        rawKey(raw),
      )) === 1
    );
  }

  async owns(raw: string): Promise<boolean> {
    const request = parseRequest(raw);
    if (!request || !commercialLlmSourceCurrent(request.source)) return false;
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[2]) == ARGV[2] and redis.call('HGET', KEYS[1], ARGV[3]) == ARGV[1] then return 1 end; return 0`,
        2,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        raw,
        request.worker,
        rawKey(raw),
      )) === 1
    );
  }

  async prove(raw: string, source: CommercialLlmSource): Promise<boolean> {
    const request = parseRequest(raw);
    if (
      !request ||
      !commercialLlmSourceCurrent(source) ||
      JSON.stringify(request.source) !== JSON.stringify(source)
    )
      return false;
    // FLAG: Active authority and worker generation must match exactly; a new primary source does
    // not revoke an independently waiting server result or lend it another source's DELETE proof.
    return (
      (await this.redis.eval(
        `if redis.call('HGET', KEYS[1], ARGV[5]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[4] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[3]) <= now then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]) - now, 'NX'); return 1`,
        3,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
        commercialLlmProofKey(source),
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        raw,
        JSON.stringify(source),
        source.deadlineAtMs,
        request.worker,
        rawKey(raw),
      )) === 1
    );
  }

  async hasProof(source: CommercialLlmSource): Promise<boolean> {
    return (
      commercialLlmSourceCurrent(source) &&
      (await this.redis.get(commercialLlmProofKey(source))) === JSON.stringify(source)
    );
  }

  async finish(raw: string, worker?: string): Promise<void> {
    const request = parseRequest(raw);
    if (!request || (worker && request.worker !== worker)) return;
    // FLAG: Exact source and current worker own cleanup. Obsolete callers cannot remove a new
    // worker's active authority or primary; a completed source cannot consume its successor buffer.
    await this.redis.eval(
      `if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
      if redis.call('HGET', KEYS[1], ARGV[3]) == ARGV[1] then redis.call('HDEL', KEYS[1], ARGV[3]) end
      if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end; return 1`,
      3,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.active,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.primary,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      raw,
      request.worker,
      rawKey(raw),
    );
  }
}
