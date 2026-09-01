import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ChatBotAccessState, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import { PublisherBindingRefreshQueueService } from './publisher-binding-refresh.queue';

export const PUBLISHER_DISPATCH_HEALTH_REDIS = Symbol('PUBLISHER_DISPATCH_HEALTH_REDIS');
export const PUBLISHER_DISPATCH_PAUSE_KEY_PREFIX = 'publisher:dispatch:pause:v1:';
const PUBLISHER_PRESERVED_PAUSE_MAX_BYTES = 16 * 1_024;
const PUBLISHER_DISPATCH_HEALTH_READY_TIMEOUT_MS = 1_250;
const PUBLISHER_DISPATCH_HEALTH_REDIS_STATUSES = new Set([
  'wait',
  'reconnecting',
  'connecting',
  'connect',
  'ready',
  'close',
  'end',
]);
const PUBLISHER_DISPATCH_RECORD_PAUSE_SCRIPT = `
-- PUBLISHER_DISPATCH_RECORD_PAUSE_V1
local nextRaw = ARGV[1]
if string.len(nextRaw) > tonumber(ARGV[2]) then
  return redis.error_reply('publisher pause payload exceeds the bounded size')
end
local nextOk, nextDecoded = pcall(cjson.decode, nextRaw)
if not nextOk then
  return redis.error_reply('publisher pause payload is invalid')
end

local current = redis.call('GET', KEYS[1])
if current then
  local currentOk, currentDecoded = pcall(cjson.decode, current)
  if currentOk and currentDecoded['reason'] == 'operator_rollout' then
    local replacePreserved = true
    local preservedRaw = currentDecoded['preservedPauseRaw']
    if type(preservedRaw) == 'string' then
      local preservedOk, preservedDecoded = pcall(cjson.decode, preservedRaw)
      if preservedOk then
        local preservedAtMs = tonumber(preservedDecoded['observedAtMs'])
        local nextAtMs = tonumber(nextDecoded['observedAtMs'])
        if preservedAtMs and nextAtMs and preservedAtMs > nextAtMs then
          replacePreserved = false
        end
      end
    end
    if replacePreserved then
      currentDecoded['preservedPauseRaw'] = nextRaw
      return redis.call('SET', KEYS[1], cjson.encode(currentDecoded))
    end
    return 0
  end
end

return redis.call('SET', KEYS[1], nextRaw)
`;
const PUBLISHER_DISPATCH_CLEAR_AUTH_PAUSE_SCRIPT = `
-- PUBLISHER_DISPATCH_CLEAR_AUTH_PAUSE_V2
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local ok, decoded = pcall(cjson.decode, current)
if not ok then return 0 end
local attemptedAtMs = tonumber(ARGV[1])
if not attemptedAtMs then return 0 end

if decoded['reason'] == 'operator_rollout' then
  local preservedRaw = decoded['preservedPauseRaw']
  if type(preservedRaw) ~= 'string' then return 0 end
  local preservedOk, preserved = pcall(cjson.decode, preservedRaw)
  if not preservedOk then return 0 end
  local preservedReason = preserved['reason']
  if preservedReason ~= 'unauthorized'
    and preservedReason ~= 'identity_authorization_failed'
    and preservedReason ~= 'identity_mismatch'
  then return 0 end
  local preservedAtMs = tonumber(preserved['observedAtMs'])
  if not preservedAtMs or attemptedAtMs <= preservedAtMs then return 0 end
  decoded['preservedPauseRaw'] = nil
  redis.call('SET', KEYS[1], cjson.encode(decoded))
  return 2
end

local reason = decoded['reason']
if reason ~= 'unauthorized'
  and reason ~= 'identity_authorization_failed'
  and reason ~= 'identity_mismatch'
then return 0 end
local observedAtMs = tonumber(decoded['observedAtMs'])
if not observedAtMs or attemptedAtMs <= observedAtMs then return 0 end
return redis.call('DEL', KEYS[1])
`;

type PublisherDispatchHealthRedis = Pick<Redis, 'get' | 'eval' | 'disconnect'> &
  Partial<Pick<Redis, 'connect' | 'off' | 'once' | 'status'>>;

export type PublisherFailureClassification =
  | 'global_paused'
  | 'setup_required'
  | 'retryable'
  | 'transient';

export class PublisherDispatchPausedError extends Error {
  readonly code = 'PUBLISHER_DISPATCH_PAUSED';

  constructor(readonly observedAt: string | null) {
    super('MAX publisher dispatch is paused after an authorization failure');
    this.name = 'PublisherDispatchPausedError';
  }
}

export type PublisherDispatchHealthUnavailableCauseCode =
  | 'redis_timeout'
  | 'redis_connection'
  | 'redis_command_error';

export class PublisherDispatchHealthUnavailableError extends Error {
  readonly code = 'PUBLISHER_DISPATCH_HEALTH_UNAVAILABLE';
  readonly causeCode: PublisherDispatchHealthUnavailableCauseCode;
  readonly redisStatus: string;

  constructor(cause: unknown, redisStatus?: unknown) {
    const causeCode = classifyPublisherDispatchHealthUnavailableCause(cause);
    const normalizedRedisStatus = normalizePublisherDispatchHealthRedisStatus(redisStatus);
    super(
      `MAX publisher dispatch health is unavailable (cause=${causeCode}; redis=${normalizedRedisStatus})`,
      { cause },
    );
    this.name = 'PublisherDispatchHealthUnavailableError';
    this.causeCode = causeCode;
    this.redisStatus = normalizedRedisStatus;
  }
}

function classifyPublisherDispatchHealthUnavailableCause(
  error: unknown,
): PublisherDispatchHealthUnavailableCauseCode {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    const row = current as { cause?: unknown; code?: unknown; message?: unknown };
    const code = typeof row.code === 'string' ? row.code.trim().toUpperCase() : '';
    const message = typeof row.message === 'string' ? row.message.toLowerCase() : '';
    if (code === 'ETIMEDOUT' || message.includes('timed out') || message.includes('timeout')) {
      return 'redis_timeout';
    }
    if (
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ENETUNREACH',
        'EHOSTUNREACH',
      ].includes(code) ||
      message.includes('connection is closed') ||
      message.includes('connection ended') ||
      message.includes('connection closed') ||
      message.includes('socket closed') ||
      message.includes('reached the max retries per request limit') ||
      message.includes("stream isn't writeable") ||
      message.includes('stream is not writeable')
    ) {
      return 'redis_connection';
    }
    current = row.cause;
  }
  return 'redis_command_error';
}

function normalizePublisherDispatchHealthRedisStatus(status: unknown): string {
  if (typeof status !== 'string') {
    return 'unknown';
  }
  const normalized = status.trim().toLowerCase();
  return PUBLISHER_DISPATCH_HEALTH_REDIS_STATUSES.has(normalized) ? normalized : 'unknown';
}

export function extractPublisherMaxStatusCode(error: unknown): number | null {
  const visited = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    const row = current as {
      response?: { status?: unknown };
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
    };
    for (const candidate of [row.response?.status, row.status, row.statusCode]) {
      const parsed = typeof candidate === 'number' ? candidate : Number(candidate);
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) {
        return parsed;
      }
    }
    current = row.cause;
  }
  return null;
}

export function classifyPublisherFailure(error: unknown): PublisherFailureClassification {
  const statusCode = extractPublisherMaxStatusCode(error);
  if (statusCode === 401) {
    return 'global_paused';
  }
  if (statusCode === 403 || statusCode === 404) {
    return 'setup_required';
  }
  if (
    statusCode === 429 ||
    (error as { code?: unknown } | null)?.code === 'MAX_API_INTERNAL_RATE_LIMIT'
  ) {
    return 'retryable';
  }
  return 'transient';
}

export function buildPublisherDispatchPauseKey(botId: string): string {
  return `${PUBLISHER_DISPATCH_PAUSE_KEY_PREFIX}${encodeURIComponent(botId.trim())}`;
}

@Injectable()
export class PublisherDispatchHealthService implements OnModuleDestroy {
  private readonly logger = new Logger(PublisherDispatchHealthService.name);
  private readonly publisherBotId: string;
  private readonly redis: PublisherDispatchHealthRedis;
  private readonly ownsRedis: boolean;
  private redisConnectionAttempt: Promise<void> | null = null;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly refreshQueue: PublisherBindingRefreshQueueService,
    @Optional()
    @Inject(PUBLISHER_DISPATCH_HEALTH_REDIS)
    redis?: PublisherDispatchHealthRedis,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    if (redis) {
      this.redis = redis;
      this.ownsRedis = false;
    } else {
      const ownedRedis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 1_000,
        commandTimeout: 1_000,
      });
      ownedRedis.on('error', () => undefined);
      this.redis = ownedRedis;
      this.ownsRedis = true;
    }
  }

  async assertDispatchAllowed(): Promise<void> {
    const raw = await this.readPauseRaw();
    if (!raw) {
      return;
    }

    let observedAt: string | null = null;
    try {
      const parsed = JSON.parse(raw) as { observedAt?: unknown };
      observedAt = typeof parsed.observedAt === 'string' ? parsed.observedAt : null;
    } catch {
      // FLAG: A malformed pause marker still fails closed.
    }
    throw new PublisherDispatchPausedError(observedAt);
  }

  async isGloballyPaused(): Promise<boolean> {
    return Boolean(await this.readPauseRaw());
  }

  private async readPauseRaw(): Promise<string | null> {
    try {
      await this.ensureRedisReady();
      return await this.redis.get(buildPublisherDispatchPauseKey(this.publisherBotId));
    } catch (error: unknown) {
      throw new PublisherDispatchHealthUnavailableError(error, this.redis.status);
    }
  }

  private async ensureRedisReady(): Promise<void> {
    const status = this.redis.status;
    if (!status || status === 'ready') {
      return;
    }
    if (this.redisConnectionAttempt) {
      return this.redisConnectionAttempt;
    }
    if (!this.redis.once || !this.redis.off) {
      throw new Error(`Publisher dispatch health Redis is not ready (${status})`);
    }

    const attempt = new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const cleanup = () => {
        if (timeout) {
          clearTimeout(timeout);
        }
        this.redis.off?.('ready', onReady);
        this.redis.off?.('end', onEnd);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('Publisher dispatch health Redis connection ended before ready'));
      };

      this.redis.once?.('ready', onReady);
      this.redis.once?.('end', onEnd);
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Publisher dispatch health Redis readiness timed out'));
      }, PUBLISHER_DISPATCH_HEALTH_READY_TIMEOUT_MS);

      if (this.redis.status === 'ready') {
        onReady();
        return;
      }
      if (this.redis.status === 'end') {
        onEnd();
        return;
      }
      if (this.redis.status === 'wait' && this.redis.connect) {
        void this.redis.connect().catch((error: unknown) => {
          cleanup();
          reject(error);
        });
      }
    });
    const trackedAttempt = attempt.finally(() => {
      if (this.redisConnectionAttempt === trackedAttempt) {
        this.redisConnectionAttempt = null;
      }
    });
    this.redisConnectionAttempt = trackedAttempt;
    void trackedAttempt.catch(() => undefined);
    return trackedAttempt;
  }

  async recordSendSuccess(chatId: string, attemptedAt?: Date): Promise<void> {
    const healthObservedAt = attemptedAt ?? new Date();
    const operations: Promise<unknown>[] = [
      this.prisma.publisherEntityBinding.updateMany({
        where: {
          chatId: chatId.trim(),
          publisherBotId: this.publisherBotId,
          AND: [
            {
              OR: [
                { sendRouteLastSuccessAt: null },
                { sendRouteLastSuccessAt: { lt: healthObservedAt } },
              ],
            },
            {
              OR: [
                { sendRouteLastFailureAt: null },
                { sendRouteLastFailureAt: { lte: healthObservedAt } },
              ],
            },
          ],
        },
        data: {
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureCode: null,
          sendRouteLastSuccessAt: healthObservedAt,
        },
      }),
    ];
    if (attemptedAt) {
      operations.push(this.recordAuthenticatedSuccess(attemptedAt));
    }
    const results = await Promise.allSettled(operations);
    if (results.some((result) => result.status === 'rejected')) {
      // FLAG: A confirmed MAX send must never become retryable because health bookkeeping failed.
      this.logger.warn(
        { chatId: chatId.trim() },
        'Publisher send succeeded but route health bookkeeping was incomplete',
      );
    }
  }

  async recordSendFailure(
    chatId: string,
    error: unknown,
    observedAt = new Date(),
  ): Promise<PublisherFailureClassification> {
    const classification = classifyPublisherFailure(error);
    if (classification === 'global_paused') {
      await this.recordGlobalAuthorizationFailure(observedAt);
      return classification;
    }
    if (classification !== 'setup_required') {
      return classification;
    }

    const statusCode = extractPublisherMaxStatusCode(error);
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return classification;
    }
    await this.prisma.publisherEntityBinding.updateMany({
      where: {
        chatId: normalizedChatId,
        publisherBotId: this.publisherBotId,
        AND: [
          {
            OR: [{ botAccessCheckedAt: null }, { botAccessCheckedAt: { lte: observedAt } }],
          },
          {
            OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lte: observedAt } }],
          },
          {
            OR: [{ sendRouteLastFailureAt: null }, { sendRouteLastFailureAt: { lt: observedAt } }],
          },
        ],
      },
      data: {
        permissionsSnapshot: Prisma.JsonNull,
        botAccessState: ChatBotAccessState.LOST,
        botAccessCheckedAt: observedAt,
        botAccessExpiresAt: null,
        botAccessSource: 'publisher_send_failure',
        botAccessLastErrorCode: statusCode ? `HTTP_${statusCode}` : 'ACCESS_LOST',
        sendRouteFailureCount: { increment: 1 },
        sendRouteLastFailureAt: observedAt,
        sendRouteLastFailureCode: statusCode ? `HTTP_${statusCode}` : 'ACCESS_LOST',
        permissionsHash: null,
      },
    });
    await this.refreshQueue.enqueue({
      chatId: normalizedChatId,
      publisherBotId: this.publisherBotId,
      reason: 'send_access_lost',
      requestedAt: observedAt,
    });
    return classification;
  }

  async recordGlobalAuthorizationFailure(observedAt = new Date()): Promise<void> {
    await this.recordGlobalPause('unauthorized', 401, observedAt);
  }

  async recordGlobalIdentityAttestationFailure(
    reason: 'identity_authorization_failed' | 'identity_mismatch',
    statusCode: number | null,
    observedAt = new Date(),
  ): Promise<void> {
    await this.recordGlobalPause(reason, statusCode, observedAt);
  }

  private async recordGlobalPause(
    reason: 'identity_authorization_failed' | 'identity_mismatch' | 'unauthorized',
    statusCode: number | null,
    observedAt: Date,
  ): Promise<void> {
    const pauseRaw = JSON.stringify({
      version: 1,
      reason,
      statusCode,
      observedAt: observedAt.toISOString(),
      observedAtMs: observedAt.getTime(),
    });
    await this.redis.eval(
      PUBLISHER_DISPATCH_RECORD_PAUSE_SCRIPT,
      1,
      buildPublisherDispatchPauseKey(this.publisherBotId),
      pauseRaw,
      PUBLISHER_PRESERVED_PAUSE_MAX_BYTES,
    );
  }

  async recordAuthenticatedSuccess(attemptedAt = new Date()): Promise<void> {
    await this.redis.eval(
      PUBLISHER_DISPATCH_CLEAR_AUTH_PAUSE_SCRIPT,
      1,
      buildPublisherDispatchPauseKey(this.publisherBotId),
      attemptedAt.getTime(),
    );
  }

  onModuleDestroy(): void {
    if (this.ownsRedis) {
      this.redis.disconnect(false);
    }
  }
}
