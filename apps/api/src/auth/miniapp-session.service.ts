import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import Redis from 'ioredis';
import { z } from 'zod';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  DEFAULT_MINIAPP_SESSION_REDIS_TIMEOUT_MS,
  DEFAULT_MINIAPP_SESSION_TTL_SEC,
  MINIAPP_CSRF_TOKEN_PATTERN,
  MINIAPP_SESSION_CREATE_RATE_LIMIT,
  MINIAPP_SESSION_CREATE_RATE_WINDOW_SEC,
  MINIAPP_SESSION_MAX_PER_PRINCIPAL,
  MINIAPP_SESSION_TOKEN_PATTERN,
} from './miniapp-session.constants';
import {
  MiniappSessionRateLimitedException,
  MiniappSessionUnavailableException,
} from './miniapp-session.error';
import type { MiniappSessionRecord, ResolvedMiniappSession } from './miniapp-session.types';

const SESSION_KEY_PREFIX = 'miniapp:session:v1:';
const SESSION_PRINCIPAL_INDEX_PREFIX = 'miniapp:session-principal:v1:';
const SESSION_CREATE_RATE_PREFIX = 'miniapp:session-create-rate:v1:';
const SESSION_RECORD_VERSION = 1;
const SESSION_CREATE_RATE_LIMITED = -1;
const SESSION_CREATE_COLLISION = 0;
const SESSION_CREATE_OK = 1;

const CREATE_SESSION_SCRIPT = String.raw`
local createCount = redis.call('INCR', KEYS[3])
if createCount == 1 or redis.call('TTL', KEYS[3]) < 0 then
  redis.call('EXPIRE', KEYS[3], ARGV[5])
end
if createCount > tonumber(ARGV[4]) then
  return -1
end

local stored = redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')
if not stored then
  return 0
end

local cutoffMs = tonumber(ARGV[3]) - tonumber(ARGV[2]) * 1000
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoffMs)
while redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[6]) do
  local evicted = redis.call('ZPOPMIN', KEYS[2], 1)
  if #evicted == 0 then
    break
  end
  redis.call('DEL', ARGV[7] .. evicted[1])
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[8])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
`;

const DESTROY_RESOLVED_SESSION_SCRIPT = String.raw`
local removed = redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return removed
`;

const authUserSchema = z
  .object({
    userId: z.string().min(1).max(128),
    launchBotId: z.string().min(1).max(256).nullable().optional(),
    username: z.string().max(256).nullable(),
    displayName: z.string().max(512).nullable(),
    avatarUrl: z.string().max(4_096).nullable().optional(),
    profileUrl: z.string().max(4_096).nullable().optional(),
    chatId: z.string().max(256).optional(),
    chatTitle: z.string().max(512).nullable().optional(),
    chatType: z.enum(['chat', 'channel', 'dialog']).nullable().optional(),
  })
  .strict();

const sessionRecordSchema = z
  .object({
    version: z.literal(SESSION_RECORD_VERSION),
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    csrfToken: z.string().regex(MINIAPP_CSRF_TOKEN_PATTERN),
    user: authUserSchema,
  })
  .strict();

type CreatedMiniappSession = {
  sessionToken: string;
  csrfToken: string;
  expiresAt: number;
};

@Injectable()
export class MiniappSessionService implements OnModuleDestroy {
  private readonly redisUrl: string;
  private readonly ttlSec: number;
  private readonly redisTimeoutMs: number;
  private redis: Redis | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(configService: ConfigService) {
    this.redisUrl = configService.getOrThrow<string>('REDIS_URL');
    this.ttlSec = configService.get<number>(
      'MINIAPP_SESSION_TTL_SEC',
      DEFAULT_MINIAPP_SESSION_TTL_SEC,
    );
    this.redisTimeoutMs = configService.get<number>(
      'MINIAPP_SESSION_REDIS_TIMEOUT_MS',
      DEFAULT_MINIAPP_SESSION_REDIS_TIMEOUT_MS,
    );
  }

  async create(user: AuthUser): Promise<CreatedMiniappSession> {
    const redis = await this.getReadyRedis();
    const createdAt = Date.now();
    const expiresAt = createdAt + this.ttlSec * 1_000;
    const validatedUser = authUserSchema.parse(user);
    const principalHash = this.hashPrincipal(validatedUser);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const sessionToken = this.createToken();
      const keyHash = this.hash(sessionToken);
      const csrfToken = this.createToken();
      const record: MiniappSessionRecord = {
        version: SESSION_RECORD_VERSION,
        createdAt,
        expiresAt,
        csrfToken,
        user: validatedUser,
      };
      const result = Number(
        await this.runRedisCommand(
          redis.eval(
            CREATE_SESSION_SCRIPT,
            3,
            this.buildKey(keyHash),
            this.buildPrincipalIndexKey(principalHash),
            this.buildCreateRateKey(principalHash),
            JSON.stringify(record),
            String(this.ttlSec),
            String(createdAt),
            String(MINIAPP_SESSION_CREATE_RATE_LIMIT),
            String(MINIAPP_SESSION_CREATE_RATE_WINDOW_SEC),
            String(MINIAPP_SESSION_MAX_PER_PRINCIPAL),
            SESSION_KEY_PREFIX,
            keyHash,
          ),
        ),
      );
      if (result === SESSION_CREATE_RATE_LIMITED) {
        throw new MiniappSessionRateLimitedException();
      }
      if (result === SESSION_CREATE_OK) {
        return { sessionToken, csrfToken, expiresAt };
      }
      if (result !== SESSION_CREATE_COLLISION) {
        throw new MiniappSessionUnavailableException();
      }
    }

    throw new MiniappSessionUnavailableException();
  }

  async resolve(sessionToken: string | undefined): Promise<ResolvedMiniappSession | null> {
    if (!sessionToken || !MINIAPP_SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return null;
    }

    const keyHash = this.hash(sessionToken);
    const redis = await this.getReadyRedis();
    const serialized = await this.runRedisCommand(redis.get(this.buildKey(keyHash)));
    if (!serialized) {
      return null;
    }

    const record = this.parseRecord(serialized);
    if (!record || record.expiresAt <= Date.now()) {
      void this.runRedisCommand(redis.del(this.buildKey(keyHash))).catch(() => undefined);
      return null;
    }

    return { keyHash, record };
  }

  async destroy(sessionToken: string | undefined): Promise<void> {
    if (!sessionToken || !MINIAPP_SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return;
    }

    const redis = await this.getReadyRedis();
    await this.runRedisCommand(redis.del(this.buildKey(this.hash(sessionToken))));
  }

  async destroyResolved(
    sessionToken: string | undefined,
    session: ResolvedMiniappSession,
  ): Promise<void> {
    if (!sessionToken || !MINIAPP_SESSION_TOKEN_PATTERN.test(sessionToken)) {
      return;
    }

    const keyHash = this.hash(sessionToken);
    if (keyHash !== session.keyHash) {
      await this.destroy(sessionToken);
      return;
    }

    const redis = await this.getReadyRedis();
    await this.runRedisCommand(
      redis.eval(
        DESTROY_RESOLVED_SESSION_SCRIPT,
        2,
        this.buildKey(keyHash),
        this.buildPrincipalIndexKey(this.hashPrincipal(session.record.user)),
        keyHash,
      ),
    );
  }

  async refreshUser(
    session: ResolvedMiniappSession,
    user: AuthUser,
  ): Promise<ResolvedMiniappSession | null> {
    if (session.record.expiresAt <= Date.now()) {
      return null;
    }

    const redis = await this.getReadyRedis();
    const updated: ResolvedMiniappSession = {
      keyHash: session.keyHash,
      record: {
        ...session.record,
        user: authUserSchema.parse(user),
      },
    };
    const result = await this.runRedisCommand(
      redis.set(this.buildKey(session.keyHash), JSON.stringify(updated.record), 'KEEPTTL', 'XX'),
    );
    return result === 'OK' ? updated : null;
  }

  verifyCsrf(session: ResolvedMiniappSession, csrfToken: string | undefined): boolean {
    if (!csrfToken || !MINIAPP_CSRF_TOKEN_PATTERN.test(csrfToken)) {
      return false;
    }

    const provided = Buffer.from(this.hash(csrfToken), 'hex');
    const expected = Buffer.from(this.hash(session.record.csrfToken), 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }

  async onModuleDestroy(): Promise<void> {
    const redis = this.redis;
    this.redis = null;
    this.connectPromise = null;
    if (!redis || redis.status === 'end') {
      return;
    }

    redis.disconnect(false);
  }

  private parseRecord(serialized: string): MiniappSessionRecord | null {
    try {
      const result = sessionRecordSchema.safeParse(JSON.parse(serialized));
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private createToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private buildKey(keyHash: string): string {
    return `${SESSION_KEY_PREFIX}${keyHash}`;
  }

  private buildPrincipalIndexKey(principalHash: string): string {
    return `${SESSION_PRINCIPAL_INDEX_PREFIX}${principalHash}`;
  }

  private buildCreateRateKey(principalHash: string): string {
    return `${SESSION_CREATE_RATE_PREFIX}${principalHash}`;
  }

  private hashPrincipal(user: AuthUser): string {
    return this.hash(`${user.userId}\0${user.launchBotId ?? ''}`);
  }

  private async getReadyRedis(): Promise<Redis> {
    if (!this.redis || this.redis.status === 'end') {
      this.redis = new Redis(this.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        enableReadyCheck: true,
        maxRetriesPerRequest: 1,
        connectTimeout: this.redisTimeoutMs,
        commandTimeout: this.redisTimeoutMs,
        retryStrategy: (attempt) => (attempt <= 1 ? 50 : null),
      });
      this.redis.on('error', () => undefined);
      this.connectPromise = null;
    }

    if (this.redis.status === 'wait') {
      this.connectPromise ??= this.redis
        .connect()
        .then(() => undefined)
        .catch((error: unknown) => {
          this.connectPromise = null;
          throw error;
        });
    }

    if (this.redis.status === 'wait' || this.redis.status === 'connecting') {
      if (!this.connectPromise) {
        throw new MiniappSessionUnavailableException();
      }
      try {
        await this.connectPromise;
      } catch {
        throw new MiniappSessionUnavailableException();
      }
    }

    if (this.redis.status !== 'ready') {
      throw new MiniappSessionUnavailableException();
    }
    return this.redis;
  }

  private async runRedisCommand<T>(command: Promise<T>): Promise<T> {
    try {
      return await command;
    } catch {
      throw new MiniappSessionUnavailableException();
    }
  }
}
