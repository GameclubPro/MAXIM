import type Redis from 'ioredis';
import {
  commercialLlmRequestSchema,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
const prefix = 'commercial-llm-enforcement:v1';
export const COMMERCIAL_LLM_PRIMARY_INTERVAL_MS = 2_000;
export const COMMERCIAL_LLM_ENFORCEMENT_KEYS = {
  worker: `${prefix}:worker`,
  ready: `${prefix}:ready`,
  slot: `${prefix}:slot`,
  status: `${prefix}:status`,
  cooldown: `${prefix}:primary-cooldown`,
} as const;
export const commercialLlmProofKey = (source: CommercialLlmSource) =>
  `${prefix}:proof:${commercialLlmSourceKey(source)}`;
const release =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

export class CommercialLlmEnforcementMailbox {
  constructor(private readonly redis: Redis) {}

  async heartbeat(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `
      local owner = redis.call('GET', KEYS[1])
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
        `
      if redis.call('GET', KEYS[4]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2], KEYS[3]) > 0 then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 2500); return 1`,
        4,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.cooldown,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        worker,
      )) === 1
    );
  }

  async withdraw(worker: string): Promise<void> {
    await this.redis.eval(release, 1, COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready, worker);
  }

  async offer(offer: { source: CommercialLlmSource; excerpt: string }): Promise<boolean> {
    const worker = await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready);
    if (!worker || !commercialLlmSourceCurrent(offer.source)) return false;
    const request = commercialLlmRequestSchema.parse({
      ...offer,
      worker,
      submittedAtMs: Date.now(),
    });
    // FLAG: One slot, zero waiting list. Primary admission never consumes server capacity.
    // The server's independent lease/cooldown is required immediately before its inference.
    return (
      (await this.redis.eval(
        `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[4]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2], KEYS[3]) > 0 then return 0 end
      local time = redis.call('TIME'); local now = time[1]*1000 + math.floor(time[2]/1000)
      if tonumber(ARGV[3]) <= now or tonumber(ARGV[4]) < now - 10000 or tonumber(ARGV[4]) > now + 5000 then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3])-now)
      redis.call('SET', KEYS[3], '1', 'PX', ARGV[5])
      redis.call('DEL', KEYS[1]); return 1`,
        4,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.ready,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.cooldown,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        worker,
        JSON.stringify(request),
        offer.source.deadlineAtMs,
        offer.source.eventAtMs,
        COMMERCIAL_LLM_PRIMARY_INTERVAL_MS,
      )) === 1
    );
  }

  async take(worker: string): Promise<{ request: CommercialLlmRequest; raw: string } | null> {
    if (!(await this.ownsWorker(worker))) return null;
    const raw = await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot);
    if (!raw) return null;
    let request: CommercialLlmRequest | null = null;
    try {
      request = commercialLlmRequestSchema.parse(JSON.parse(raw));
    } catch {
      /* FLAG: Invalid input never grants authority. */
    }
    if (
      !request ||
      request.worker !== worker ||
      !commercialLlmSourceCurrent(request.source) ||
      Date.now() - request.submittedAtMs > COMMERCIAL_LLM_PENDING_MAX_AGE_MS ||
      request.submittedAtMs > Date.now() + 1000
    ) {
      await this.finish(raw, worker);
      return null;
    }
    return { request, raw };
  }

  async owns(raw: string): Promise<boolean> {
    return (await this.redis.get(COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot)) === raw;
  }

  async prove(raw: string, source: CommercialLlmSource): Promise<boolean> {
    // FLAG: A late result cannot authorize a successor's slot or extend the source lifetime.
    return (
      (await this.redis.eval(
        `
      if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[4] then return 0 end
      local time = redis.call('TIME'); local now = time[1]*1000 + math.floor(time[2]/1000)
      if tonumber(ARGV[3]) <= now then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3])-now, 'NX'); return 1`,
        3,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
        commercialLlmProofKey(source),
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        raw,
        JSON.stringify(source),
        source.deadlineAtMs,
        commercialLlmRequestSchema.parse(JSON.parse(raw)).worker,
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
    if (worker) {
      // FLAG: A stale reader must not discard a successor after losing the worker lease.
      await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
         if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        2,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot,
        COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
        raw,
        worker,
      );
    } else await this.redis.eval(release, 1, COMMERCIAL_LLM_ENFORCEMENT_KEYS.slot, raw);
  }
}
