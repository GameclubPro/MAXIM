import {
  commercialAiPoolDiagnosticsSchema,
  safetyDeskCommercialAiPoolResponseSchema,
  type SafetyDeskCommercialAiPoolResponse,
} from '@maxim/contracts/safety-desk';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { projectCommercialAiStatus } from './safety-desk-commercial-ai.service';
import {
  COMMERCIAL_AI_POOL_EXPECTED,
  COMMERCIAL_AI_POOL_READ_KEYS,
  READ_COMMERCIAL_AI_POOL,
  commercialAiPoolReadSchema,
} from './safety-desk-commercial-ai-pool-read';

type Read =
  | { at: number; kind: 'value'; raw: string }
  | { at: number; kind: 'unavailable' | 'invalid' };
type Configuration = Pick<
  SafetyDeskCommercialAiPoolResponse,
  'workersEnabled' | 'routingEnabled' | 'policy'
>;

export function projectCommercialAiPool(
  config: Configuration,
  read: Read | null,
  now: number,
): SafetyDeskCommercialAiPoolResponse {
  const snapshot: SafetyDeskCommercialAiPoolResponse = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    observedAt: read ? new Date(read.at).toISOString() : null,
    ...config,
    availability: config.workersEnabled ? 'UNAVAILABLE' : 'DISABLED',
    nodes: null,
    metrics: null,
    trafficCoverage: 'NOT_ESTABLISHED',
    confirmedDeletes: null,
  };
  if (!config.workersEnabled || !read) return snapshot;
  if (read.kind !== 'value')
    return { ...snapshot, availability: read.kind === 'invalid' ? 'INVALID' : 'UNAVAILABLE' };
  try {
    if (Buffer.byteLength(read.raw) > 20_000 || read.at > now) throw new Error();
    const data = commercialAiPoolReadSchema.parse(JSON.parse(read.raw));
    snapshot.availability = now - read.at >= 2000 ? 'STALE' : 'FRESH';
    snapshot.nodes = data.nodes.map(({ nodeId, state, ttlMs }) => ({
      nodeId,
      state: ttlMs > 0 && now >= read.at + ttlMs ? 'STALE' : state,
      validUntil: ttlMs > 0 ? new Date(read.at + ttlMs).toISOString() : null,
    }));
    // FLAG: An older producer's missing metrics are unknown, never zero. Model attempts
    // include primary/consultation/retry work and are not final decisions or remote effects.
    const status = data.status;
    if (config.routingEnabled && status[0] === 'value') {
      const projected = projectCommercialAiStatus(
        'DELETE_ONLY',
        {
          kind: 'value',
          raw: status[1],
          ttl: status[2],
          at: read.at,
        },
        now,
      );
      let rawDiagnostics: unknown;
      try {
        rawDiagnostics = JSON.parse(status[1]).poolDiagnostics;
      } catch {
        /* Missing metrics do not erase node observations. */
      }
      const diagnostics = commercialAiPoolDiagnosticsSchema.safeParse(rawDiagnostics);
      if (
        diagnostics.success &&
        projected.observationProcessId &&
        projected.observationStartedAt &&
        projected.heartbeatAt &&
        ['FRESH', 'STALE'].includes(projected.availability)
      ) {
        const start = Date.parse(projected.observationStartedAt),
          end = Date.parse(projected.heartbeatAt);
        const valid = diagnostics.data.nodes.every(
          (node) =>
            (node.completedAttempts === 0) === (node.lastCompletedAt === null) &&
            (node.completedAttempts === 0) === (node.ewmaDurationMs === null) &&
            (node.failedAttempts === 0) === (node.lastFailureAt === null) &&
            [node.lastCompletedAt, node.lastFailureAt].every(
              (at) => at === null || (Date.parse(at) >= start && Date.parse(at) <= end),
            ),
        );
        if (valid)
          snapshot.metrics = {
            availability: projected.availability as 'FRESH' | 'STALE',
            observedAt: projected.heartbeatAt,
            observationProcessId: projected.observationProcessId,
            observationStartedAt: projected.observationStartedAt,
            basis: 'PROCESS_MODEL_ATTEMPTS',
            diagnostics: diagnostics.data,
          };
      }
    }
    return safetyDeskCommercialAiPoolResponseSchema.parse(snapshot);
  } catch {
    return { ...snapshot, availability: 'INVALID', nodes: null, metrics: null };
  }
}

@Injectable()
export class SafetyDeskCommercialAiPoolService implements OnModuleDestroy {
  private redis: Redis | null = null;
  private cached: Read | null = null;
  private inFlight: Promise<Read> | null = null;
  private stopping = false;
  constructor(private readonly config: ConfigService) {}

  async getSnapshot(): Promise<SafetyDeskCommercialAiPoolResponse> {
    const config: Configuration = {
      workersEnabled: this.config.get<boolean>('COMMERCIAL_LLM_POOL_WORKERS_ENABLED') === true,
      routingEnabled: this.config.get<boolean>('COMMERCIAL_LLM_POOL_ENABLED') === true,
      policy:
        this.config.get<'confirm-positive' | 'direct-4b'>('COMMERCIAL_LLM_POOL_4B_POLICY') ??
        'confirm-positive',
    };
    const now = Date.now();
    if (!config.workersEnabled) return projectCommercialAiPool(config, null, now);
    if (this.stopping)
      return projectCommercialAiPool(config, { kind: 'unavailable', at: now }, now);
    if (this.cached && now >= this.cached.at && now - this.cached.at < 2000)
      return projectCommercialAiPool(config, this.cached, now);
    if (!this.inFlight) {
      const request = this.read().then((read) => {
        if (!this.stopping) this.cached = read;
        return read;
      });
      this.inFlight = request;
      void request.finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    }
    const read = await this.inFlight;
    return projectCommercialAiPool(
      config,
      this.stopping ? { kind: 'unavailable', at: Date.now() } : read,
      Date.now(),
    );
  }

  private async read(): Promise<Read> {
    try {
      if (this.stopping) throw new Error();
      if (!this.redis || this.redis.status !== 'ready') {
        this.redis?.disconnect();
        this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
        await this.redis.connect();
      }
      if (this.stopping) throw new Error();
      // Subtract the whole round trip from TTL freshness, rather than extending it on receipt.
      const at = Date.now();
      const raw: unknown = await this.redis.eval(
        READ_COMMERCIAL_AI_POOL,
        COMMERCIAL_AI_POOL_READ_KEYS.length,
        ...COMMERCIAL_AI_POOL_READ_KEYS,
        COMMERCIAL_AI_POOL_EXPECTED,
      );
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 20_000)
        return { kind: 'invalid', at };
      return { kind: 'value', at, raw };
    } catch {
      return { kind: 'unavailable', at: Date.now() };
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.cached = null;
    this.redis?.disconnect();
  }
}
