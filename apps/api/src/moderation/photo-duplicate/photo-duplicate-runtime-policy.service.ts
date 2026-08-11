import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { z } from 'zod';

import {
  PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS,
  PHOTO_DUPLICATE_MAX_ACTIONS,
  PHOTO_DUPLICATE_ROLLOUT_MODES,
  resolvePhotoDuplicateAllowedMatchKinds,
  resolvePhotoDuplicateMaxAction,
  resolvePhotoDuplicateRolloutMode,
  resolvePhotoDuplicateRuntimePolicy,
  restrictPhotoDuplicateMaxAction,
  type PhotoDuplicateMatchKind,
  type PhotoDuplicateMatchPreset,
  type PhotoDuplicateRuntimePolicy,
  type PhotoDuplicateScope,
} from './photo-duplicate.runtime';

export const PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY = 'photo-duplicate:runtime-control:v1';
export const PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY =
  'photo-duplicate:runtime-control-revision:v1';

const PHOTO_DUPLICATE_RUNTIME_CONTROL_READ_TIMEOUT_MS = 750;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const MAX_CONTROL_CHAT_IDS = 10_000;
const MAX_CONTROL_LIFETIME_MS = 24 * 60 * 60_000;

export const PHOTO_DUPLICATE_RUNTIME_CONTROL_REDIS_OPTIONS = {
  commandTimeout: PHOTO_DUPLICATE_RUNTIME_CONTROL_READ_TIMEOUT_MS,
  connectTimeout: PHOTO_DUPLICATE_RUNTIME_CONTROL_READ_TIMEOUT_MS,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
} as const satisfies RedisOptions;

const SET_PHOTO_DUPLICATE_RUNTIME_CONTROL_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
local current_revision = nil
local revision_raw = redis.call('GET', KEYS[2])
if revision_raw then
  current_revision = tonumber(revision_raw)
  if not current_revision or current_revision < 1 or current_revision > 9007199254740991 or
    current_revision % 1 ~= 0 then
    return {-1, -1}
  end
end
if current_raw and not revision_raw then
  return {-1, -1}
end
if current_raw then
  local decoded, current = pcall(cjson.decode, current_raw)
  if not decoded or type(current) ~= 'table' or current.version ~= 1 then
    return {-1, -1}
  end
  local active_revision = tonumber(current.revision)
  if not active_revision or active_revision < 1 or active_revision > 9007199254740991 or
    active_revision % 1 ~= 0 then
    return {-1, -1}
  end
  if current_revision and current_revision ~= active_revision then
    return {-1, current_revision}
  end
  current_revision = active_revision
end

local expected_revision = tonumber(ARGV[1])
local next_revision = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[4])
if not expected_revision or not next_revision or next_revision > 9007199254740991 or
  not ttl_ms or ttl_ms < 1 then
  return {-2, current_revision or -1}
end
if expected_revision == -1 then
  if current_revision then
    return {0, current_revision}
  end
  if next_revision ~= 1 then
    return {-2, -1}
  end
else
  if not current_revision or current_revision ~= expected_revision then
    return {0, current_revision or -1}
  end
  if next_revision ~= expected_revision + 1 then
    return {-2, current_revision}
  end
end

local incoming_decoded, incoming = pcall(cjson.decode, ARGV[3])
if not incoming_decoded or type(incoming) ~= 'table' or incoming.version ~= 1 or
  tonumber(incoming.revision) ~= next_revision then
  return {-2, current_revision or -1}
end

redis.call('SET', KEYS[1], ARGV[3], 'PX', ttl_ms)
redis.call('SET', KEYS[2], tostring(next_revision))
return {1, next_revision}
`;

const CLEAR_PHOTO_DUPLICATE_RUNTIME_CONTROL_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
local revision_raw = redis.call('GET', KEYS[2])
local current_revision = revision_raw and tonumber(revision_raw) or nil
local expected_revision = tonumber(ARGV[1])
if revision_raw and (not current_revision or current_revision < 1 or
  current_revision > 9007199254740991 or current_revision % 1 ~= 0) then
  return {-1, -1}
end
if current_raw and not revision_raw then
  return {-1, -1}
end
if current_raw then
  local decoded, current = pcall(cjson.decode, current_raw)
  if not decoded or type(current) ~= 'table' or current.version ~= 1 then
    return {-1, current_revision or -1}
  end
  local active_revision = tonumber(current.revision)
  if not active_revision or active_revision < 1 or active_revision > 9007199254740991 or
    active_revision % 1 ~= 0 then
    return {-1, current_revision or -1}
  end
  if current_revision and current_revision ~= active_revision then
    return {-1, current_revision}
  end
  current_revision = active_revision
end
if not expected_revision or expected_revision < 1 or expected_revision >= 9007199254740991 or
  expected_revision % 1 ~= 0 then
  return {-2, current_revision or -1}
end
if not current_revision or current_revision ~= expected_revision then
  return {0, current_revision or -1}
end

redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], tostring(current_revision + 1))
return {1, current_revision, current_revision + 1}
`;

const exactChatIdSchema = z
  .string()
  .min(1)
  .max(160)
  .refine((value) => value === value.trim(), 'chat ids must not contain surrounding whitespace')
  .refine((value) => !value.includes('*'), 'wildcards are not allowed in chat id allowlists')
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
    'chat ids contain control characters',
  );

const boundedAuditTextSchema = (maxLength: number) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => value === value.trim(),
      'audit text must not contain surrounding whitespace',
    );

const isoTimestampSchema = z.string().refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}, 'timestamp must be a canonical ISO-8601 UTC value');

const photoDuplicateRuntimeControlSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    mode: z.enum(PHOTO_DUPLICATE_ROLLOUT_MODES),
    enforcementChatIds: z.array(exactChatIdSchema).max(MAX_CONTROL_CHAT_IDS),
    advancedCanaryChatIds: z.array(exactChatIdSchema).max(MAX_CONTROL_CHAT_IDS),
    allowedMatchKinds: z
      .array(z.enum(PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS))
      .max(PHOTO_DUPLICATE_ENFORCEABLE_MATCH_KINDS.length),
    maxAction: z.enum(PHOTO_DUPLICATE_MAX_ACTIONS),
    actor: boundedAuditTextSchema(200),
    reason: boundedAuditTextSchema(1_000),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    for (const [field, values] of [
      ['enforcementChatIds', value.enforcementChatIds],
      ['advancedCanaryChatIds', value.advancedCanaryChatIds],
      ['allowedMatchKinds', value.allowedMatchKinds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} must not contain duplicates`,
        });
      }
    }

    const createdAtMs = Date.parse(value.createdAt);
    const updatedAtMs = Date.parse(value.updatedAt);
    const expiresAtMs = Date.parse(value.expiresAt);
    if (updatedAtMs < createdAtMs) {
      context.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: 'updatedAt must not precede createdAt',
      });
    }
    if (expiresAtMs <= updatedAtMs) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'expiresAt must be later than updatedAt',
      });
    }
    if (expiresAtMs - updatedAtMs > MAX_CONTROL_LIFETIME_MS) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'runtime control lifetime must not exceed 24 hours',
      });
    }
    if (value.advancedCanaryChatIds.some((chatId) => !value.enforcementChatIds.includes(chatId))) {
      context.addIssue({
        code: 'custom',
        path: ['advancedCanaryChatIds'],
        message: 'advanced canary chats must also be enforcement chats',
      });
    }
  });

export type PhotoDuplicateRuntimeControlV1 = z.infer<typeof photoDuplicateRuntimeControlSchema>;

export type EffectivePhotoDuplicateRuntimePolicy = PhotoDuplicateRuntimePolicy & {
  controlRevision: number | null;
  controlExpiresAt: string | null;
};

export type SetPhotoDuplicateRuntimeControlResult =
  | { kind: 'applied'; revision: number; expiresAt: string }
  | { kind: 'conflict'; currentRevision: number | null };

export type ClearPhotoDuplicateRuntimeControlResult =
  | { kind: 'cleared'; previousRevision: number; revision: number }
  | { kind: 'conflict'; currentRevision: number | null };

export type PhotoDuplicateRuntimeControlSnapshot =
  | { kind: 'missing'; control: null; revision: number | null }
  | { kind: 'invalid'; control: null; revision: number | null }
  | { kind: 'expired'; control: PhotoDuplicateRuntimeControlV1; revision: number }
  | { kind: 'active'; control: PhotoDuplicateRuntimeControlV1; revision: number };

export class PhotoDuplicateRuntimeControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoDuplicateRuntimeControlValidationError';
  }
}

const MODE_RANK = {
  off: 0,
  shadow: 1,
  delete_only: 2,
  full: 3,
} as const;

export function parsePhotoDuplicateRuntimeControl(
  raw: string,
): PhotoDuplicateRuntimeControlV1 | null {
  try {
    const parsed = photoDuplicateRuntimeControlSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

@Injectable()
export class PhotoDuplicateRuntimePolicyService implements OnModuleDestroy {
  private readonly logger = new Logger(PhotoDuplicateRuntimePolicyService.name);
  private readonly redis: Redis;
  private redisConnectionAttempt: Promise<void> | null = null;
  private lastFailureLogAtMs = 0;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(
      configService.getOrThrow<string>('REDIS_URL'),
      PHOTO_DUPLICATE_RUNTIME_CONTROL_REDIS_OPTIONS,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit();
      return;
    }
    this.redis.disconnect();
  }

  async resolveEffectivePolicy(params: {
    chatId: string;
    preset: PhotoDuplicateMatchPreset;
    scope: PhotoDuplicateScope;
  }): Promise<EffectivePhotoDuplicateRuntimePolicy> {
    const envPolicy = resolvePhotoDuplicateRuntimePolicy({
      ...params,
      configService: this.configService,
    });
    if (!envPolicy.enforce) {
      return { ...envPolicy, controlRevision: null, controlExpiresAt: null };
    }

    // FLAG: Redis is the shared, execution-time downgrade switch. A potentially enforcing env
    // policy is never enough by itself; a missing, expired, malformed or unreadable control must
    // collapse to shadow before any action can be authorized.
    const control = await this.readFreshControl();
    if (!control) {
      return this.toFailClosedShadow(envPolicy);
    }

    const effectiveMode =
      MODE_RANK[control.mode] < MODE_RANK[envPolicy.mode] ? control.mode : envPolicy.mode;
    const controlMetadata = {
      controlRevision: control.revision,
      controlExpiresAt: control.expiresAt,
    } as const;
    if (effectiveMode === 'off') {
      return {
        ...envPolicy,
        mode: 'off',
        enforce: false,
        advancedCanary: false,
        ...controlMetadata,
      };
    }
    if (effectiveMode === 'shadow' || !control.enforcementChatIds.includes(params.chatId)) {
      return {
        ...envPolicy,
        mode: 'shadow',
        enforce: false,
        advancedCanary: false,
        ...controlMetadata,
      };
    }

    const advancedCanary =
      envPolicy.advancedCanary && control.advancedCanaryChatIds.includes(params.chatId);
    if ((params.preset === 'MINOR_EDITS' || params.scope === 'CHAT') && !advancedCanary) {
      return {
        ...envPolicy,
        mode: 'shadow',
        enforce: false,
        advancedCanary: false,
        ...controlMetadata,
      };
    }

    const controlMatchKinds = new Set<PhotoDuplicateMatchKind>(control.allowedMatchKinds);
    return {
      mode: effectiveMode,
      enforce: true,
      advancedCanary,
      allowedMatchKinds: envPolicy.allowedMatchKinds.filter((kind) => controlMatchKinds.has(kind)),
      maxAction: restrictPhotoDuplicateMaxAction(envPolicy.maxAction, control.maxAction),
      ...controlMetadata,
    };
  }

  async setControl(params: {
    expectedRevision: number | null;
    control: unknown;
  }): Promise<SetPhotoDuplicateRuntimeControlResult> {
    const control = this.previewSetControl(params);
    const ttlMs = Date.parse(control.expiresAt) - Date.now();

    const response = (await this.runRedisOperationWithin(() =>
      this.redis.eval(
        SET_PHOTO_DUPLICATE_RUNTIME_CONTROL_SCRIPT,
        2,
        PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
        PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
        String(params.expectedRevision ?? -1),
        String(control.revision),
        JSON.stringify(control),
        String(Math.ceil(ttlMs)),
      ),
    )) as unknown;
    const values = Array.isArray(response) ? response : [];
    const status = Number(values[0]);
    const currentRevision = Number(values[1]);
    if (status === 1 && currentRevision === control.revision) {
      return { kind: 'applied', revision: control.revision, expiresAt: control.expiresAt };
    }
    if (status === 0) {
      return {
        kind: 'conflict',
        currentRevision:
          Number.isSafeInteger(currentRevision) && currentRevision >= 1 ? currentRevision : null,
      };
    }
    if (status === -1) {
      throw new Error('Redis contains an invalid photo duplicate runtime control');
    }
    throw new Error('Redis rejected the photo duplicate runtime control compare-and-set');
  }

  previewSetControl(params: {
    expectedRevision: number | null;
    control: unknown;
  }): PhotoDuplicateRuntimeControlV1 {
    const parsed = photoDuplicateRuntimeControlSchema.safeParse(params.control);
    if (!parsed.success) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'Photo duplicate runtime control does not match the strict v1 schema',
      );
    }
    const control = parsed.data;
    const expectedRevision = params.expectedRevision;
    if (
      expectedRevision !== null &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    ) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'expectedRevision must be null or a positive safe integer',
      );
    }
    const requiredRevision = (expectedRevision ?? 0) + 1;
    if (control.revision !== requiredRevision) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        `control revision must be ${requiredRevision} for this compare-and-set`,
      );
    }
    this.assertControlWithinEnvCeilings(control);

    const ttlMs = Date.parse(control.expiresAt) - Date.now();
    if (ttlMs <= 0 || ttlMs > MAX_CONTROL_LIFETIME_MS) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control expiresAt must be in the future and no more than 24 hours away',
      );
    }
    return control;
  }

  async clearControl(params: {
    expectedRevision: number;
  }): Promise<ClearPhotoDuplicateRuntimeControlResult> {
    if (
      !Number.isSafeInteger(params.expectedRevision) ||
      params.expectedRevision < 1 ||
      params.expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'expectedRevision must be a positive safe integer that can be incremented',
      );
    }
    const response = (await this.runRedisOperationWithin(() =>
      this.redis.eval(
        CLEAR_PHOTO_DUPLICATE_RUNTIME_CONTROL_SCRIPT,
        2,
        PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
        PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
        String(params.expectedRevision),
      ),
    )) as unknown;
    const values = Array.isArray(response) ? response : [];
    const status = Number(values[0]);
    const currentRevision = Number(values[1]);
    const nextRevision = Number(values[2]);
    if (
      status === 1 &&
      currentRevision === params.expectedRevision &&
      nextRevision === params.expectedRevision + 1
    ) {
      return { kind: 'cleared', previousRevision: currentRevision, revision: nextRevision };
    }
    if (status === 0) {
      return {
        kind: 'conflict',
        currentRevision:
          Number.isSafeInteger(currentRevision) && currentRevision >= 1 ? currentRevision : null,
      };
    }
    if (status === -1) {
      throw new Error('Redis contains an invalid photo duplicate runtime control');
    }
    throw new Error('Redis rejected the photo duplicate runtime control clear');
  }

  async getControlSnapshot(): Promise<PhotoDuplicateRuntimeControlSnapshot> {
    const [raw, revisionRaw] = await this.runRedisOperationWithin(() =>
      this.redis.mget(
        PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
        PHOTO_DUPLICATE_RUNTIME_CONTROL_REVISION_KEY,
      ),
    );
    const storedRevision = this.parseStoredRevision(revisionRaw);
    if (revisionRaw !== null && storedRevision === null) {
      return { kind: 'invalid', control: null, revision: null };
    }
    if (!raw) {
      return { kind: 'missing', control: null, revision: storedRevision };
    }
    const control = parsePhotoDuplicateRuntimeControl(raw);
    if (!control) {
      return { kind: 'invalid', control: null, revision: storedRevision };
    }
    if (storedRevision === null) {
      return { kind: 'invalid', control: null, revision: control.revision };
    }
    if (storedRevision !== control.revision) {
      return { kind: 'invalid', control: null, revision: storedRevision };
    }
    return Date.parse(control.expiresAt) <= Date.now()
      ? { kind: 'expired', control, revision: storedRevision }
      : { kind: 'active', control, revision: storedRevision };
  }

  private async readFreshControl(): Promise<PhotoDuplicateRuntimeControlV1 | null> {
    let snapshot: PhotoDuplicateRuntimeControlSnapshot;
    try {
      snapshot = await this.getControlSnapshot();
    } catch (error: unknown) {
      this.logFailure('read_failed', error);
      return null;
    }
    if (snapshot.kind !== 'active') {
      this.logFailure(snapshot.kind);
      return null;
    }
    return snapshot.control;
  }

  private toFailClosedShadow(
    envPolicy: PhotoDuplicateRuntimePolicy,
  ): EffectivePhotoDuplicateRuntimePolicy {
    return {
      ...envPolicy,
      mode: 'shadow',
      enforce: false,
      advancedCanary: false,
      controlRevision: null,
      controlExpiresAt: null,
    };
  }

  private assertControlWithinEnvCeilings(control: PhotoDuplicateRuntimeControlV1): void {
    const envMode = resolvePhotoDuplicateRolloutMode(this.configService);
    if (MODE_RANK[control.mode] > MODE_RANK[envMode]) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control mode exceeds PHOTO_DUPLICATE_ROLLOUT_MODE',
      );
    }

    const envEnforcementChatIds = this.parseEnvChatIds(
      this.configService.get<string>('PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS'),
    );
    if (
      !envEnforcementChatIds.has('*') &&
      control.enforcementChatIds.some((chatId) => !envEnforcementChatIds.has(chatId))
    ) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control enforcement chats exceed PHOTO_DUPLICATE_ENFORCEMENT_CHAT_IDS',
      );
    }

    const envAdvancedChatIds = this.parseEnvChatIds(
      this.configService.get<string>('PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS'),
    );
    if (control.advancedCanaryChatIds.some((chatId) => !envAdvancedChatIds.has(chatId))) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control advanced chats exceed PHOTO_DUPLICATE_ADVANCED_CANARY_CHAT_IDS',
      );
    }

    const envMatchKinds = new Set(resolvePhotoDuplicateAllowedMatchKinds(this.configService));
    if (control.allowedMatchKinds.some((kind) => !envMatchKinds.has(kind))) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control match kinds exceed PHOTO_DUPLICATE_ALLOWED_MATCH_KINDS',
      );
    }

    const envMaxAction = resolvePhotoDuplicateMaxAction(this.configService);
    if (restrictPhotoDuplicateMaxAction(envMaxAction, control.maxAction) !== control.maxAction) {
      throw new PhotoDuplicateRuntimeControlValidationError(
        'control max action exceeds PHOTO_DUPLICATE_MAX_ACTION',
      );
    }
  }

  private parseEnvChatIds(value: unknown): ReadonlySet<string> {
    if (typeof value !== 'string') {
      return new Set();
    }
    return new Set(
      value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  private parseStoredRevision(value: string | null): number | null {
    if (value === null || !/^[1-9]\d*$/u.test(value)) {
      return null;
    }
    const revision = Number(value);
    return Number.isSafeInteger(revision) ? revision : null;
  }

  private async ensureRedisReady(): Promise<void> {
    if (this.redis.status === 'ready') {
      return;
    }
    if (this.redisConnectionAttempt) {
      return this.redisConnectionAttempt;
    }

    const attempt =
      this.redis.status === 'wait' || this.redis.status === 'end'
        ? this.redis.connect()
        : new Promise<void>((resolve, reject) => {
            const onReady = () => {
              cleanup();
              resolve();
            };
            const onEnd = () => {
              cleanup();
              reject(new Error('Photo duplicate runtime control Redis connection ended'));
            };
            const cleanup = () => {
              this.redis.off('ready', onReady);
              this.redis.off('end', onEnd);
            };
            this.redis.once('ready', onReady);
            this.redis.once('end', onEnd);
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

  private async runRedisOperationWithin<T>(operation: () => Promise<T>): Promise<T> {
    const deadlineAtMs = Date.now() + PHOTO_DUPLICATE_RUNTIME_CONTROL_READ_TIMEOUT_MS;
    await this.runPromiseBeforeDeadline(this.ensureRedisReady(), deadlineAtMs);
    return this.runPromiseBeforeDeadline(operation(), deadlineAtMs);
  }

  private runPromiseBeforeDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        reject(new Error('Photo duplicate runtime control Redis operation timed out'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('Photo duplicate runtime control Redis operation timed out'));
      }, remainingMs);
      timeout.unref();
      operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  private logFailure(reason: 'missing' | 'invalid' | 'expired' | 'read_failed', error?: unknown) {
    const now = Date.now();
    if (now - this.lastFailureLogAtMs < FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastFailureLogAtMs = now;
    this.logger.warn(
      {
        reason,
        key: PHOTO_DUPLICATE_RUNTIME_CONTROL_KEY,
        err: error instanceof Error ? error.message : error ? String(error) : undefined,
      },
      'Photo duplicate enforcement downgraded to shadow by runtime control',
    );
  }
}
