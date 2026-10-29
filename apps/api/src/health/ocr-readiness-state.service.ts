import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { z } from 'zod';

export const OCR_READINESS_KEY = 'system:ocr-runtime-readiness:v1:api-media-analysis';
export const OCR_READINESS_TTL_MS = 15_000;
export const OCR_READINESS_CACHE_MS = 2_000;
export const OCR_READINESS_MAX_BYTES = 2_048;

// FLAG: Cross-role readiness reads one bounded diagnostic value. It cannot expose source work,
// grant execution authority, or make the isolated media HTTP listener reachable from other roles.
export const READ_OCR_READINESS = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return {'missing'} end
if kind ~= 'string' then return {'invalid'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 or size > tonumber(ARGV[1]) then return {'invalid'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 or ttl > tonumber(ARGV[2]) then return {'invalid'} end
return {'value', redis.call('GET', KEYS[1]), ttl}`;

const RELEASE_OCR_READINESS = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind ~= 'string' then return 0 end
if redis.call('STRLEN', KEYS[1]) > tonumber(ARGV[2]) then return 0 end
local ok, current = pcall(cjson.decode, redis.call('GET', KEYS[1]))
if not ok or type(current) ~= 'table' or current.bootId ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])`;

const heartbeatSchema = z
  .object({
    version: z.literal(1),
    serviceName: z.literal('api-media-analysis'),
    bootId: z.uuid(),
    observedAt: z.iso.datetime(),
    mode: z.enum(['off', 'shadow', 'on']),
    ready: z.boolean(),
    identityVerified: z.boolean(),
  })
  .strict()
  .refine((value) => !value.ready || value.identityVerified);

export type OcrReadinessHeartbeat = Readonly<z.infer<typeof heartbeatSchema>>;
type ReadinessRead = {
  value: OcrReadinessHeartbeat | null;
  readAtMs: number;
  expiresAtMs: number;
};

export function parseOcrReadinessHeartbeat(
  raw: string,
  readAtMs: number,
  ttlMs: number,
): { value: OcrReadinessHeartbeat; expiresAtMs: number } | null {
  try {
    if (
      Buffer.byteLength(raw, 'utf8') > OCR_READINESS_MAX_BYTES ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > OCR_READINESS_TTL_MS ||
      !Number.isSafeInteger(readAtMs)
    )
      return null;
    const value = heartbeatSchema.parse(JSON.parse(raw));
    const observedAtMs = Date.parse(value.observedAt);
    if (observedAtMs > readAtMs + 5_000 || readAtMs - observedAtMs >= OCR_READINESS_TTL_MS)
      return null;
    return {
      value: Object.freeze(value),
      expiresAtMs: Math.min(readAtMs + ttlMs, observedAtMs + OCR_READINESS_TTL_MS),
    };
  } catch {
    return null;
  }
}

@Injectable()
export class OcrReadinessStateService implements OnApplicationShutdown {
  private redis: Redis | null = null;
  private connecting: Promise<Redis> | null = null;
  private cached: ReadinessRead | null = null;
  private inFlight: Promise<ReadinessRead> | null = null;
  private stopping = false;

  constructor(private readonly config: ConfigService) {}

  async read(): Promise<OcrReadinessHeartbeat | null> {
    if (this.stopping) return null;
    const now = Date.now();
    if (
      this.cached &&
      now >= this.cached.readAtMs &&
      now < this.cached.expiresAtMs &&
      now - this.cached.readAtMs < OCR_READINESS_CACHE_MS
    )
      return this.cached.value;
    const pending = this.inFlight ?? (this.inFlight = this.readStatus());
    try {
      const result = await pending;
      if (this.stopping) return null;
      this.cached = result;
      const completedAt = Date.now();
      return completedAt >= result.readAtMs && completedAt < result.expiresAtMs
        ? result.value
        : null;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }

  async publish(heartbeat: OcrReadinessHeartbeat): Promise<void> {
    const serialized = JSON.stringify(heartbeatSchema.parse(heartbeat));
    const redis = await this.getRedis();
    await redis.set(OCR_READINESS_KEY, serialized, 'PX', OCR_READINESS_TTL_MS);
  }

  async release(bootId: string): Promise<void> {
    try {
      const redis = await this.getRedis();
      await redis.eval(
        RELEASE_OCR_READINESS,
        1,
        OCR_READINESS_KEY,
        bootId,
        OCR_READINESS_MAX_BYTES,
      );
    } catch {
      // TTL expires the observation when the owner cannot remove its own heartbeat.
    }
  }

  // FLAG: Writer destroy hooks remove their own observation before this shared transport closes.
  onApplicationShutdown(): void {
    this.stopping = true;
    this.cached = null;
    this.redis?.disconnect(false);
  }

  private async readStatus(): Promise<ReadinessRead> {
    let readAtMs = Date.now();
    const unavailable = (): ReadinessRead => ({
      value: null,
      readAtMs,
      expiresAtMs: readAtMs + OCR_READINESS_CACHE_MS,
    });
    try {
      const redis = await this.getRedis();
      // Anchor PTTL before the round trip: transport time cannot renew a returned lease.
      readAtMs = Date.now();
      const reply: unknown = await redis.eval(
        READ_OCR_READINESS,
        1,
        OCR_READINESS_KEY,
        OCR_READINESS_MAX_BYTES,
        OCR_READINESS_TTL_MS,
      );
      if (
        !Array.isArray(reply) ||
        reply.length !== 3 ||
        reply[0] !== 'value' ||
        typeof reply[1] !== 'string' ||
        typeof reply[2] !== 'number'
      )
        return unavailable();
      const parsed = parseOcrReadinessHeartbeat(reply[1], readAtMs, reply[2]);
      return parsed ? { ...parsed, readAtMs } : unavailable();
    } catch {
      // FLAG: Transport errors can contain credentials. Only the finite unavailable state leaves here.
      return unavailable();
    }
  }

  private async getRedis(): Promise<Redis> {
    if (this.stopping) throw new Error('OCR readiness state is stopping');
    if (this.redis?.status === 'ready') return this.redis;
    if (!this.connecting) {
      this.redis?.disconnect(false);
      const redis = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
        connectTimeout: 1_000,
        commandTimeout: 1_000,
      });
      redis.on('error', () => undefined);
      this.redis = redis;
      this.connecting = redis.connect().then(() => {
        if (this.stopping) throw new Error('OCR readiness state is stopping');
        return redis;
      });
    }
    const connecting = this.connecting;
    try {
      return await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }
}
