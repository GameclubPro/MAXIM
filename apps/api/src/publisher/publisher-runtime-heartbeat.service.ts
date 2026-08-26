import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';
import { PublisherDispatchHealthService } from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';

export const PUBLISHER_RUNTIME_HEARTBEAT_TTL_SEC = 45;
export const PUBLISHER_RUNTIME_HEARTBEAT_INTERVAL_MS = 15_000;
export const PUBLISHER_RUNTIME_HEARTBEAT_KEY_PREFIX = 'publisher:runtime:v1:';

export type PublisherRuntimeHeartbeatSnapshot = Readonly<{
  version: 1;
  botId: string;
  dispatchEnabled: boolean;
  observedAt: string;
  instanceId: string;
}>;

export function buildPublisherRuntimeHeartbeatKey(botId: string): string {
  return `${PUBLISHER_RUNTIME_HEARTBEAT_KEY_PREFIX}${encodeURIComponent(botId.trim())}`;
}

export function resolvePublisherHeartbeatDispatchEnabled(
  dispatchConfigured: boolean,
  globallyPaused: boolean,
  identityAttested: boolean,
): boolean {
  return dispatchConfigured && identityAttested && !globallyPaused;
}

export function parsePublisherRuntimeHeartbeat(
  raw: string,
  expectedBotId: string,
  nowMs = Date.now(),
): PublisherRuntimeHeartbeatSnapshot | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const observedAt = typeof value.observedAt === 'string' ? value.observedAt : '';
    const observedAtMs = Date.parse(observedAt);
    if (
      value.version !== 1 ||
      value.botId !== expectedBotId ||
      typeof value.dispatchEnabled !== 'boolean' ||
      typeof value.instanceId !== 'string' ||
      !value.instanceId.trim() ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs > nowMs + 30_000 ||
      nowMs - observedAtMs > PUBLISHER_RUNTIME_HEARTBEAT_TTL_SEC * 1_000
    ) {
      return null;
    }
    return {
      version: 1,
      botId: expectedBotId,
      dispatchEnabled: value.dispatchEnabled,
      observedAt,
      instanceId: value.instanceId,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class PublisherRuntimeHeartbeatWriterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherRuntimeHeartbeatWriterService.name);
  private readonly redis: Redis;
  private readonly botId: string;
  private readonly instanceId = randomUUID();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    configService: ConfigService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
  ) {
    this.botId = configService.getOrThrow<string>('MAX_PUBLISHER_BOT_ID').trim();
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  async onModuleInit(): Promise<void> {
    await this.redis.connect();
    await this.publish();
    this.timer = setInterval(() => {
      void this.publish().catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to refresh publisher runtime heartbeat',
        );
      });
    }, PUBLISHER_RUNTIME_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.redis.eval(
        `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok or decoded['instanceId'] ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`,
        1,
        buildPublisherRuntimeHeartbeatKey(this.botId),
        this.instanceId,
      );
    } catch {
      // TTL clears a stale heartbeat if shutdown cleanup cannot reach Redis.
    }
    this.redis.disconnect(false);
  }

  private async publish(): Promise<void> {
    let identityAttested = false;
    try {
      await this.identityAttestation.assertAttested();
      identityAttested = true;
    } catch {
      // A disabled heartbeat keeps readiness fail-closed while runtime attestation retries.
    }
    const globallyPaused = await this.dispatchHealth.isGloballyPaused();
    const heartbeat: PublisherRuntimeHeartbeatSnapshot = {
      version: 1,
      botId: this.botId,
      dispatchEnabled: resolvePublisherHeartbeatDispatchEnabled(
        this.runtimeBoundary.dispatchEnabled,
        globallyPaused,
        identityAttested,
      ),
      observedAt: new Date().toISOString(),
      instanceId: this.instanceId,
    };
    await this.redis.set(
      buildPublisherRuntimeHeartbeatKey(this.botId),
      JSON.stringify(heartbeat),
      'EX',
      PUBLISHER_RUNTIME_HEARTBEAT_TTL_SEC,
    );
  }
}

@Injectable()
export class PublisherRuntimeHeartbeatReaderService implements OnModuleDestroy {
  private readonly redisUrl: string;
  private redis: Redis | null = null;

  constructor(configService: ConfigService) {
    this.redisUrl = configService.getOrThrow<string>('REDIS_URL');
  }

  async read(botId: string): Promise<PublisherRuntimeHeartbeatSnapshot | null> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return null;
    }
    try {
      const raw = await this.getRedis().get(buildPublisherRuntimeHeartbeatKey(normalizedBotId));
      return raw ? parsePublisherRuntimeHeartbeat(raw, normalizedBotId) : null;
    } catch {
      return null;
    }
  }

  onModuleDestroy(): void {
    this.redis?.disconnect(false);
    this.redis = null;
  }

  private getRedis(): Redis {
    if (this.redis) {
      return this.redis;
    }
    this.redis = new Redis(this.redisUrl, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
    });
    this.redis.on('error', () => undefined);
    return this.redis;
  }
}
