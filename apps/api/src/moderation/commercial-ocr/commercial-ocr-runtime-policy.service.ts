import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';
import { z } from 'zod';

import {
  COMMERCIAL_OCR_ROLLOUT_MODES,
  resolveCommercialOcrRolloutMode,
  resolveCommercialOcrRuntimePolicy,
  type CommercialOcrRuntimePolicy,
} from './commercial-ocr.runtime';
import {
  COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES,
  digestCommercialOcrSettingsFingerprintSet,
  normalizeCommercialOcrSettingsFingerprints,
} from './commercial-ocr-settings-profile';
import { resolveCommercialOcrApprovalKeyIdSha256 } from './commercial-ocr-approval-key';
import {
  resolveCommercialOcrBehaviorIdentity,
  resolveCommercialOcrProductionBehaviorDescriptor,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
} from './commercial-ocr-behavior-identity';

export const COMMERCIAL_OCR_RUNTIME_CONTROL_KEY = 'commercial-ocr:runtime-control:v1';
export const COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY =
  'commercial-ocr:runtime-control-revision:v1';

const CONTROL_READ_TIMEOUT_MS = 750;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const MAX_CONTROL_CHAT_IDS = 10_000;
const MAX_CONTROL_LIFETIME_MS = 24 * 60 * 60_000;
export const COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION = Number.MAX_SAFE_INTEGER - 2;
const COMMERCIAL_OCR_MAX_ACTIVE_CONTROL_REVISION = Number.MAX_SAFE_INTEGER - 1;

export const COMMERCIAL_OCR_RUNTIME_CONTROL_REDIS_OPTIONS = {
  autoResendUnfulfilledCommands: false,
  commandTimeout: CONTROL_READ_TIMEOUT_MS,
  connectTimeout: CONTROL_READ_TIMEOUT_MS,
  enableOfflineQueue: false,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
} as const satisfies RedisOptions;

const SET_RUNTIME_CONTROL_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
local revision_raw = redis.call('GET', KEYS[2])
local current_revision = revision_raw and tonumber(revision_raw) or nil
if revision_raw and (string.match(revision_raw, '^[1-9][0-9]*$') == nil or
  not current_revision or current_revision < 1 or
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
  if not active_revision or active_revision < 1 or active_revision > 9007199254740990 or
    active_revision % 1 ~= 0 or (current_revision and current_revision ~= active_revision) then
    return {-1, current_revision or -1}
  end
  current_revision = active_revision
end

local expected_revision = tonumber(ARGV[1])
local next_revision = tonumber(ARGV[2])
local ttl_ms = tonumber(ARGV[4])
if (ARGV[1] ~= '-1' and string.match(ARGV[1], '^[1-9][0-9]*$') == nil) or
  string.match(ARGV[2], '^[1-9][0-9]*$') == nil or
  not expected_revision or expected_revision % 1 ~= 0 or
  (expected_revision ~= -1 and
    (expected_revision < 1 or expected_revision > 9007199254740989)) or
  not next_revision or next_revision < 1 or next_revision > 9007199254740990 or
  next_revision % 1 ~= 0 or not ttl_ms or ttl_ms < 1 then
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
redis.call('SET', KEYS[2], ARGV[2])
return {1, next_revision}
`;

const CLEAR_RUNTIME_CONTROL_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
local revision_raw = redis.call('GET', KEYS[2])
local current_revision = revision_raw and tonumber(revision_raw) or nil
local expected_revision = tonumber(ARGV[1])
local next_revision = tonumber(ARGV[2])
if revision_raw and (string.match(revision_raw, '^[1-9][0-9]*$') == nil or
  not current_revision or current_revision < 1 or
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
  if not active_revision or active_revision < 1 or active_revision > 9007199254740990 or
    active_revision % 1 ~= 0 or (current_revision and current_revision ~= active_revision) then
    return {-1, current_revision or -1}
  end
  current_revision = active_revision
end
if string.match(ARGV[1], '^[1-9][0-9]*$') == nil or
  string.match(ARGV[2], '^[1-9][0-9]*$') == nil or
  not expected_revision or expected_revision < 1 or expected_revision >= 9007199254740991 or
  expected_revision % 1 ~= 0 or not next_revision or next_revision < 2 or
  next_revision > 9007199254740991 or next_revision % 1 ~= 0 or
  next_revision ~= expected_revision + 1 then
  return {-2, current_revision or -1}
end
if not current_revision or current_revision ~= expected_revision then
  return {0, current_revision or -1}
end

redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2])
return {1, current_revision, next_revision}
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

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const runtimeControlSchema = z
  .object({
    version: z.literal(1),
    revision: z.number().int().positive().max(COMMERCIAL_OCR_MAX_ACTIVE_CONTROL_REVISION),
    mode: z.enum(COMMERCIAL_OCR_ROLLOUT_MODES),
    enforcementChatIds: z.array(exactChatIdSchema).max(MAX_CONTROL_CHAT_IDS),
    certificationSha256: sha256Schema,
    certificationExpiresAt: isoTimestampSchema,
    approvalKeyIdSha256: sha256Schema,
    behaviorIdentitySha256: sha256Schema,
    certifiedSettingsFingerprints: z
      .array(sha256Schema)
      .min(1)
      .max(COMMERCIAL_OCR_MAX_CERTIFIED_SETTINGS_PROFILES),
    certifiedSettingsFingerprintSetSha256: sha256Schema,
    actor: boundedAuditTextSchema(200),
    reason: boundedAuditTextSchema(1_000),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.enforcementChatIds).size !== value.enforcementChatIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['enforcementChatIds'],
        message: 'enforcementChatIds must not contain duplicates',
      });
    }
    if ((value.mode === 'off' || value.mode === 'shadow') && value.enforcementChatIds.length > 0) {
      context.addIssue({
        code: 'custom',
        path: ['enforcementChatIds'],
        message: 'non-enforcing controls must not list enforcement chats',
      });
    }
    if ((value.mode === 'canary' || value.mode === 'on') && value.enforcementChatIds.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['enforcementChatIds'],
        message: 'enforcing controls require at least one exact chat id',
      });
    }
    try {
      const normalizedFingerprints = normalizeCommercialOcrSettingsFingerprints(
        value.certifiedSettingsFingerprints,
      );
      if (
        normalizedFingerprints.some(
          (fingerprint, index) => fingerprint !== value.certifiedSettingsFingerprints[index],
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['certifiedSettingsFingerprints'],
          message: 'certified settings fingerprints must be sorted',
        });
      }
      if (
        value.certifiedSettingsFingerprintSetSha256 !==
        digestCommercialOcrSettingsFingerprintSet(normalizedFingerprints)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['certifiedSettingsFingerprintSetSha256'],
          message: 'certified settings fingerprint set digest is inconsistent',
        });
      }
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['certifiedSettingsFingerprints'],
        message: 'certified settings fingerprints are invalid',
      });
    }

    const createdAtMs = Date.parse(value.createdAt);
    const updatedAtMs = Date.parse(value.updatedAt);
    const expiresAtMs = Date.parse(value.expiresAt);
    const certificationExpiresAtMs = Date.parse(value.certificationExpiresAt);
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
    if (expiresAtMs > certificationExpiresAtMs) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'runtime control must not outlive its certification',
      });
    }
  });

export type CommercialOcrRuntimeControlV1 = z.infer<typeof runtimeControlSchema>;

export type EffectiveCommercialOcrRuntimePolicy = CommercialOcrRuntimePolicy & {
  controlRevision: number | null;
  controlExpiresAt: string | null;
  enforcementAuthority: 'authorized' | 'revoked' | 'unavailable';
};

export type CommercialOcrRuntimeControlSnapshot =
  | { kind: 'missing'; control: null; revision: number | null }
  | { kind: 'invalid'; control: null; revision: number | null }
  | { kind: 'expired'; control: CommercialOcrRuntimeControlV1; revision: number }
  | { kind: 'active'; control: CommercialOcrRuntimeControlV1; revision: number };

export type SetCommercialOcrRuntimeControlResult =
  | { kind: 'applied'; revision: number; expiresAt: string }
  | { kind: 'conflict'; currentRevision: number | null }
  | { kind: 'ambiguous'; reason: 'mutation_timeout' };

export type ClearCommercialOcrRuntimeControlResult =
  | { kind: 'cleared'; previousRevision: number; revision: number }
  | { kind: 'conflict'; currentRevision: number | null }
  | { kind: 'ambiguous'; reason: 'mutation_timeout' };

export class CommercialOcrRuntimeControlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialOcrRuntimeControlValidationError';
  }
}

const MODE_RANK = { off: 0, shadow: 1, canary: 2, on: 3 } as const;

export function parseCommercialOcrRuntimeControl(
  raw: string,
): CommercialOcrRuntimeControlV1 | null {
  try {
    const parsed = runtimeControlSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

@Injectable()
export class CommercialOcrRuntimePolicyService implements OnModuleDestroy {
  private readonly logger = new Logger(CommercialOcrRuntimePolicyService.name);
  private readonly redis: Redis;
  private readonly approvalKeyIdSha256: string | null;
  private readonly behaviorIdentitySha256: string | null;
  private redisConnectionAttempt: Promise<void> | null = null;
  private lastFailureLogAtMs = 0;

  constructor(private readonly configService: ConfigService) {
    this.approvalKeyIdSha256 = resolveCommercialOcrApprovalKeyIdSha256(
      configService.get<string>('COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64'),
    );
    const nativeBehavior = resolveExpectedCommercialOcrProductionBehaviorIdentity(
      configService,
    ).identity;
    this.behaviorIdentitySha256 = nativeBehavior.complete
      ? resolveCommercialOcrBehaviorIdentity(
          resolveCommercialOcrProductionBehaviorDescriptor(configService, nativeBehavior),
        ).fingerprintSha256
      : null;
    this.redis = new Redis(
      configService.getOrThrow<string>('REDIS_URL'),
      COMMERCIAL_OCR_RUNTIME_CONTROL_REDIS_OPTIONS,
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
    settingsFingerprint: string;
  }): Promise<EffectiveCommercialOcrRuntimePolicy> {
    const envPolicy = resolveCommercialOcrRuntimePolicy({
      chatId: params.chatId,
      configService: this.configService,
    });
    if (!envPolicy.enforce) {
      return {
        ...envPolicy,
        controlRevision: null,
        controlExpiresAt: null,
        enforcementAuthority: 'revoked',
      };
    }

    // FLAG: Environment values are only ceilings. Every OCR deletion also requires a fresh,
    // shared, exact-chat control so a missing or unreadable control revokes pending mutations.
    const controlResult = await this.readFreshControl();
    if (controlResult.kind !== 'active') {
      return this.toFailClosedShadow(envPolicy, controlResult.kind);
    }
    const control = controlResult.control;

    const effectiveMode =
      MODE_RANK[control.mode] < MODE_RANK[envPolicy.mode] ? control.mode : envPolicy.mode;
    const metadata = {
      controlRevision: control.revision,
      controlExpiresAt: control.expiresAt,
    } as const;
    if (
      effectiveMode === 'off' ||
      effectiveMode === 'shadow' ||
      !control.enforcementChatIds.includes(params.chatId) ||
      this.approvalKeyIdSha256 === null ||
      control.approvalKeyIdSha256 !== this.approvalKeyIdSha256 ||
      this.behaviorIdentitySha256 === null ||
      control.behaviorIdentitySha256 !== this.behaviorIdentitySha256 ||
      !sha256Schema.safeParse(params.settingsFingerprint).success ||
      !control.certifiedSettingsFingerprints.includes(params.settingsFingerprint)
    ) {
      return {
        mode: effectiveMode === 'off' ? 'off' : 'shadow',
        process: effectiveMode !== 'off',
        enforce: false,
        ...metadata,
        enforcementAuthority: 'revoked',
      };
    }
    return {
      mode: effectiveMode,
      process: true,
      enforce: true,
      ...metadata,
      enforcementAuthority: 'authorized',
    };
  }

  async setControl(params: {
    expectedRevision: number | null;
    control: unknown;
  }): Promise<SetCommercialOcrRuntimeControlResult> {
    const control = this.previewSetControl(params);
    const ttlMs = Date.parse(control.expiresAt) - Date.now();
    const attempt = await this.runRedisMutationWithin(() =>
      this.redis.eval(
        SET_RUNTIME_CONTROL_SCRIPT,
        2,
        COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
        COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
        String(params.expectedRevision ?? -1),
        String(control.revision),
        JSON.stringify(control),
        String(Math.ceil(ttlMs)),
      ),
    );
    if (attempt.kind === 'ambiguous') {
      return { kind: 'ambiguous', reason: 'mutation_timeout' };
    }
    const response = attempt.value as unknown;
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
      throw new Error('Redis contains an invalid commercial OCR runtime control');
    }
    throw new Error('Redis rejected the commercial OCR runtime control compare-and-set');
  }

  previewSetControl(params: {
    expectedRevision: number | null;
    control: unknown;
  }): CommercialOcrRuntimeControlV1 {
    const parsed = runtimeControlSchema.safeParse(params.control);
    if (!parsed.success) {
      throw new CommercialOcrRuntimeControlValidationError(
        'Commercial OCR runtime control does not match the strict v1 schema',
      );
    }
    const control = parsed.data;
    if (
      params.expectedRevision !== null &&
      (!Number.isSafeInteger(params.expectedRevision) ||
        params.expectedRevision < 1 ||
        params.expectedRevision > COMMERCIAL_OCR_MAX_PROMOTABLE_EXPECTED_REVISION)
    ) {
      throw new CommercialOcrRuntimeControlValidationError(
        'expectedRevision must leave one increment for set and one for guarded clear',
      );
    }
    const requiredRevision = (params.expectedRevision ?? 0) + 1;
    if (control.revision !== requiredRevision) {
      throw new CommercialOcrRuntimeControlValidationError(
        `control revision must be ${requiredRevision} for this compare-and-set`,
      );
    }
    this.assertControlWithinEnvCeilings(control);

    const ttlMs = Date.parse(control.expiresAt) - Date.now();
    if (ttlMs <= 0 || ttlMs > MAX_CONTROL_LIFETIME_MS) {
      throw new CommercialOcrRuntimeControlValidationError(
        'control expiresAt must be in the future and no more than 24 hours away',
      );
    }
    return control;
  }

  async clearControl(params: {
    expectedRevision: number;
  }): Promise<ClearCommercialOcrRuntimeControlResult> {
    if (
      !Number.isSafeInteger(params.expectedRevision) ||
      params.expectedRevision < 1 ||
      params.expectedRevision >= Number.MAX_SAFE_INTEGER
    ) {
      throw new CommercialOcrRuntimeControlValidationError(
        'expectedRevision must be a positive safe integer that can be incremented',
      );
    }
    const attempt = await this.runRedisMutationWithin(() =>
      this.redis.eval(
        CLEAR_RUNTIME_CONTROL_SCRIPT,
        2,
        COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
        COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
        String(params.expectedRevision),
        String(params.expectedRevision + 1),
      ),
    );
    if (attempt.kind === 'ambiguous') {
      return { kind: 'ambiguous', reason: 'mutation_timeout' };
    }
    const response = attempt.value as unknown;
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
      throw new Error('Redis contains an invalid commercial OCR runtime control');
    }
    throw new Error('Redis rejected the commercial OCR runtime control clear');
  }

  async getControlSnapshot(): Promise<CommercialOcrRuntimeControlSnapshot> {
    const [raw, revisionRaw] = await this.runRedisOperationWithin(() =>
      this.redis.mget(
        COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
        COMMERCIAL_OCR_RUNTIME_CONTROL_REVISION_KEY,
      ),
    );
    const storedRevision = this.parseStoredRevision(revisionRaw);
    if (revisionRaw !== null && storedRevision === null) {
      return { kind: 'invalid', control: null, revision: null };
    }
    if (!raw) {
      return { kind: 'missing', control: null, revision: storedRevision };
    }
    const control = parseCommercialOcrRuntimeControl(raw);
    if (!control || storedRevision === null || storedRevision !== control.revision) {
      return {
        kind: 'invalid',
        control: null,
        revision: storedRevision ?? control?.revision ?? null,
      };
    }
    return Date.parse(control.expiresAt) <= Date.now()
      ? { kind: 'expired', control, revision: storedRevision }
      : { kind: 'active', control, revision: storedRevision };
  }

  private async readFreshControl(): Promise<
    | { kind: 'active'; control: CommercialOcrRuntimeControlV1 }
    | { kind: 'revoked' }
    | { kind: 'unavailable' }
  > {
    let snapshot: CommercialOcrRuntimeControlSnapshot;
    try {
      snapshot = await this.getControlSnapshot();
    } catch (error: unknown) {
      this.logFailure('read_failed', error);
      return { kind: 'unavailable' };
    }
    if (snapshot.kind !== 'active') {
      this.logFailure(snapshot.kind);
      return { kind: 'revoked' };
    }
    return { kind: 'active', control: snapshot.control };
  }

  private toFailClosedShadow(
    envPolicy: CommercialOcrRuntimePolicy,
    authority: 'revoked' | 'unavailable',
  ): EffectiveCommercialOcrRuntimePolicy {
    return {
      ...envPolicy,
      mode: 'shadow',
      enforce: false,
      controlRevision: null,
      controlExpiresAt: null,
      enforcementAuthority: authority,
    };
  }

  private assertControlWithinEnvCeilings(control: CommercialOcrRuntimeControlV1): void {
    if (
      this.approvalKeyIdSha256 === null ||
      control.approvalKeyIdSha256 !== this.approvalKeyIdSha256
    ) {
      throw new CommercialOcrRuntimeControlValidationError(
        'control approval key does not match the active commercial OCR trust anchor',
      );
    }
    if (
      this.behaviorIdentitySha256 === null ||
      control.behaviorIdentitySha256 !== this.behaviorIdentitySha256
    ) {
      throw new CommercialOcrRuntimeControlValidationError(
        'control behavior identity does not match the active commercial OCR release',
      );
    }
    const envMode = resolveCommercialOcrRolloutMode(this.configService);
    if (MODE_RANK[control.mode] > MODE_RANK[envMode]) {
      throw new CommercialOcrRuntimeControlValidationError(
        'control mode exceeds COMMERCIAL_OCR_ROLLOUT_MODE',
      );
    }
    if (envMode !== 'canary') {
      return;
    }
    const envCanaryChatIds = this.parseEnvChatIds(
      this.configService.get<string>('COMMERCIAL_OCR_CANARY_CHAT_IDS'),
    );
    if (control.enforcementChatIds.some((chatId) => !envCanaryChatIds.has(chatId))) {
      throw new CommercialOcrRuntimeControlValidationError(
        'control chats exceed COMMERCIAL_OCR_CANARY_CHAT_IDS',
      );
    }
  }

  private parseEnvChatIds(value: unknown): ReadonlySet<string> {
    if (typeof value !== 'string') {
      return new Set();
    }
    return new Set(
      value
        .split(/[\s,;]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item !== '*'),
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
            const cleanup = () => {
              this.redis.off('ready', onReady);
              this.redis.off('end', onEnd);
            };
            const onReady = () => {
              cleanup();
              resolve();
            };
            const onEnd = () => {
              cleanup();
              reject(new Error('Commercial OCR runtime control Redis connection ended'));
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
    const deadlineAtMs = Date.now() + CONTROL_READ_TIMEOUT_MS;
    await this.runPromiseBeforeDeadline(this.ensureRedisReady(), deadlineAtMs);
    return this.runPromiseBeforeDeadline(operation(), deadlineAtMs);
  }

  private async runRedisMutationWithin<T>(
    operation: () => Promise<T>,
  ): Promise<{ kind: 'completed'; value: T } | { kind: 'ambiguous' }> {
    const deadlineAtMs = Date.now() + CONTROL_READ_TIMEOUT_MS;
    await this.runPromiseBeforeDeadline(this.ensureRedisReady(), deadlineAtMs);
    if (deadlineAtMs <= Date.now()) {
      throw new Error('Commercial OCR runtime control Redis operation timed out');
    }

    const dispatchedOperation = operation();
    try {
      return {
        kind: 'completed',
        value: await this.runPromiseBeforeDeadline(dispatchedOperation, deadlineAtMs),
      };
    } catch {
      // Once EVAL has been handed to Redis, a client error cannot prove that the script did not
      // commit. The operator must verify the state and must never retry this mutation implicitly.
      return { kind: 'ambiguous' };
    }
  }

  private runPromiseBeforeDeadline<T>(operation: Promise<T>, deadlineAtMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const remainingMs = deadlineAtMs - Date.now();
      if (remainingMs <= 0) {
        reject(new Error('Commercial OCR runtime control Redis operation timed out'));
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error('Commercial OCR runtime control Redis operation timed out'));
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
        key: COMMERCIAL_OCR_RUNTIME_CONTROL_KEY,
        failureKind: error instanceof Error ? 'error' : error ? 'unknown' : undefined,
      },
      'Commercial OCR enforcement downgraded to shadow by runtime control',
    );
  }
}
