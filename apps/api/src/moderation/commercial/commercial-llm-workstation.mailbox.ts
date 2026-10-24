import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { CommercialLlmError, parseCommercialLlmEnvelope } from './commercial-llm.client';
import {
  buildCommercialLlmRequest,
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS,
  COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS,
  COMMERCIAL_LLM_WORKSTATION_IDENTITY as identity,
  COMMERCIAL_LLM_WORKSTATION_KEYS as keys,
  COMMERCIAL_LLM_WORKSTATION_LEASE_MS,
  COMMERCIAL_LLM_WORKSTATION_REQUEST_BYTES,
  COMMERCIAL_LLM_WORKSTATION_RESPONSE_BYTES,
  COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES,
  commercialLlmWorkstationIdentityMatches,
} from './commercial-llm-workstation.protocol';

type Store = Pick<Redis, 'eval' | 'get'>;
export type WorkstationOutcome =
  | { outcome: 'COMPLETE'; result: CommercialLlmObservationResult }
  | { outcome: 'UNAVAILABLE' | 'BUSY' | 'TIMEOUT' | 'FAILED' };
export type WorkstationRequest = { id: string; owner: string; body: string; remainingMs: number };
const tokenPattern = /^[a-f0-9-]{36}$/u;
const decodeLua = `local function decode(v)
 if not v then return nil end
 local ok,data=pcall(cjson.decode,v)
 if ok and type(data)=='table' then return data end
 return nil
end
`;
const refreshLua = `${decodeLua}
if redis.call('GET',KEYS[1])~=ARGV[1] then return nil end
redis.call('PEXPIRE',KEYS[1],ARGV[2])
if ARGV[3]=='1' then redis.call('SET',KEYS[2],ARGV[4],'PX',ARGV[5])
else
 local heartbeat=decode(redis.call('GET',KEYS[2]))
 if heartbeat and heartbeat.owner==ARGV[1] then redis.call('DEL',KEYS[2]) end
 return {'',0}
end
local raw=redis.call('GET',KEYS[3])
local request=decode(raw)
if request and request.owner==ARGV[1] then return {raw,redis.call('PTTL',KEYS[3])} end
return {'',0}`;
const publishLua = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return -1 end
if redis.call('EXISTS',KEYS[3])+redis.call('EXISTS',KEYS[4])>0 then return 0 end
redis.call('SET',KEYS[3],ARGV[3],'PX',ARGV[4])
return 1`;
const respondLua = `${decodeLua}
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
local request=decode(redis.call('GET',KEYS[2]))
local ttl=redis.call('PTTL',KEYS[2])
if not request or request.owner~=ARGV[1] or request.id~=ARGV[2] or ttl<=0 then return 0 end
if redis.call('EXISTS',KEYS[3])==1 then return 0 end
redis.call('SET',KEYS[3],ARGV[3],'PX',ttl)
return 1`;
const cleanupLua = `${decodeLua}
for i=1,#KEYS do
 local item=decode(redis.call('GET',KEYS[i]))
 if item and item.owner==ARGV[1] and item.id==ARGV[2] then redis.call('DEL',KEYS[i]) end
end
return 1`;
const releaseLua = `${decodeLua}
if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
redis.call('DEL',KEYS[1])
for i=2,#KEYS do
 local item=decode(redis.call('GET',KEYS[i]))
 if item and item.owner==ARGV[1] then redis.call('DEL',KEYS[i]) end
end
return 1`;

function record(raw: string | null, maximumBytes: number): Record<string, unknown> | null {
  if (!raw || Buffer.byteLength(raw) > maximumBytes) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// FLAG: Exactly one expiring slot, never a durable queue or a source of moderation effects.
export class CommercialLlmWorkstationMailbox {
  constructor(
    private readonly redis: Store,
    private readonly timeoutMs = COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS,
  ) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS
    )
      throw new Error('workstation_budget_refused');
  }

  async acquireWorker(owner: string): Promise<boolean> {
    if (!tokenPattern.test(owner)) throw new Error('workstation_owner_refused');
    return (
      (await this.redis.eval(
        "return redis.call('SET',KEYS[1],ARGV[1],'NX','PX',ARGV[2]) and 1 or 0",
        1,
        keys.lease,
        owner,
        COMMERCIAL_LLM_WORKSTATION_LEASE_MS,
      )) === 1
    );
  }

  async refreshWorker(owner: string, ready: boolean): Promise<WorkstationRequest | null> {
    const response = await this.redis.eval(
      refreshLua,
      3,
      keys.lease,
      keys.heartbeat,
      keys.request,
      owner,
      COMMERCIAL_LLM_WORKSTATION_LEASE_MS,
      ready ? '1' : '0',
      JSON.stringify({ owner, identity }),
      COMMERCIAL_LLM_WORKSTATION_HEARTBEAT_MS,
    );
    if (!Array.isArray(response)) throw new Error('workstation_lease_lost');
    const item = record(String(response[0] ?? ''), COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES);
    const remainingMs = Number(response[1]);
    if (!item) return null;
    if (
      typeof item.id !== 'string' ||
      !tokenPattern.test(item.id) ||
      item.owner !== owner ||
      typeof item.body !== 'string' ||
      Buffer.byteLength(item.body) > COMMERCIAL_LLM_WORKSTATION_REQUEST_BYTES ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs <= 0 ||
      remainingMs > COMMERCIAL_LLM_PRIMARY_TIMEOUT_MS
    )
      throw new Error('workstation_request_refused');
    return { id: item.id, owner, body: item.body, remainingMs };
  }

  async respond(owner: string, id: string, body: string): Promise<boolean> {
    if (
      !tokenPattern.test(owner) ||
      !tokenPattern.test(id) ||
      typeof body !== 'string' ||
      Buffer.byteLength(body) > COMMERCIAL_LLM_WORKSTATION_RESPONSE_BYTES
    )
      return false;
    return (
      (await this.redis.eval(
        respondLua,
        3,
        keys.lease,
        keys.request,
        keys.response,
        owner,
        id,
        JSON.stringify({ owner, id, body }),
      )) === 1
    );
  }

  async releaseWorker(owner: string): Promise<void> {
    await this.redis.eval(
      releaseLua,
      4,
      keys.lease,
      keys.heartbeat,
      keys.request,
      keys.response,
      owner,
    );
  }

  async classify(excerpt: string, signal?: AbortSignal): Promise<WorkstationOutcome> {
    const budget = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([budget, ...(signal ? [signal] : [])]);
    let abort: () => void = () => undefined;
    const stopped = new Promise<WorkstationOutcome>((resolve, reject) => {
      abort = () =>
        signal?.aborted
          ? reject(new CommercialLlmError('ABORTED'))
          : resolve({ outcome: 'TIMEOUT' });
      combined.addEventListener('abort', abort, { once: true });
      if (combined.aborted) abort();
    });
    try {
      return await Promise.race([this.run(excerpt, combined), stopped]);
    } finally {
      combined.removeEventListener('abort', abort);
    }
  }

  private async run(excerpt: string, signal: AbortSignal): Promise<WorkstationOutcome> {
    if (signal?.aborted) throw new CommercialLlmError('ABORTED');
    const startedAt = performance.now(),
      id = randomUUID();
    const deadline = startedAt + this.timeoutMs;
    let owner: string | null = null;
    try {
      const heartbeatRaw = await this.redis.get(keys.heartbeat);
      const heartbeat = record(heartbeatRaw, 2048);
      if (
        !heartbeat ||
        typeof heartbeat.owner !== 'string' ||
        !tokenPattern.test(heartbeat.owner) ||
        !commercialLlmWorkstationIdentityMatches(heartbeat.identity)
      )
        return { outcome: 'UNAVAILABLE' };
      owner = heartbeat.owner;
      const body = JSON.stringify({
        ...buildCommercialLlmRequest(excerpt),
        model: identity.modelAlias,
      });
      if (Buffer.byteLength(body) > COMMERCIAL_LLM_WORKSTATION_REQUEST_BYTES)
        return { outcome: 'FAILED' };
      if (signal?.aborted) throw new CommercialLlmError('ABORTED');
      const published = await this.redis.eval(
        publishLua,
        4,
        keys.lease,
        keys.heartbeat,
        keys.request,
        keys.response,
        owner,
        heartbeatRaw!,
        JSON.stringify({ owner, id, body }),
        Math.max(1, Math.floor(deadline - performance.now())),
      );
      if (published !== 1) return { outcome: published === 0 ? 'BUSY' : 'UNAVAILABLE' };
      while (performance.now() < deadline) {
        if (signal?.aborted) throw new CommercialLlmError('ABORTED');
        const response = record(
          await this.redis.get(keys.response),
          COMMERCIAL_LLM_WORKSTATION_FRAME_BYTES,
        );
        if (signal?.aborted) throw new CommercialLlmError('ABORTED');
        if (performance.now() >= deadline) break;
        if (response?.id === id && response.owner === owner) {
          if (
            typeof response.body !== 'string' ||
            Buffer.byteLength(response.body) > COMMERCIAL_LLM_WORKSTATION_RESPONSE_BYTES
          )
            return { outcome: 'FAILED' };
          const decision = parseCommercialLlmEnvelope(
            JSON.parse(response.body),
            identity.modelAlias,
          );
          return {
            outcome: 'COMPLETE',
            result: {
              ...decision,
              ...identity,
              policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
              durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
            },
          };
        }
        await pause(Math.min(75, Math.max(1, deadline - performance.now())), undefined, { signal });
      }
      return { outcome: 'TIMEOUT' };
    } catch {
      if (signal?.aborted) throw new CommercialLlmError('ABORTED');
      return { outcome: 'FAILED' };
    } finally {
      // FLAG: Late/stale replies can remove only their own nonce; foreign slots expire naturally.
      if (owner)
        await this.redis
          .eval(cleanupLua, 2, keys.request, keys.response, owner, id)
          .catch(() => undefined);
    }
  }
}
