import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';

import { EventType, Operator, Prisma, SanctionAction } from '../prisma/prisma-client';
import type { RedisCounterService } from './redis-counter.service';
import { REQUIRED_SUBSCRIPTION_NOTICE_LOCK_TTL_MS } from './moderation.service.support';

export const REQUIRED_SUBSCRIPTION_MEDIA_BURST_WINDOW_MS = 10_000;
export const REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_STATE_TTL_SEC = 10 * 60;
export const REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_COVERAGE_RULE_CODE =
  'REQUIRED_SUBSCRIPTION_NOTICE_COVERAGE';

const REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_VERSION = 1 as const;
const REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_MAX_METADATA_BYTES = 8 * 1_024;
const REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_TEST_CACHE_MAX = 1_000;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export type RequiredSubscriptionMediaNoticeScope = {
  kind: 'media_group' | 'burst';
  scopeDigest: string;
  sourceCreatedAtMs: number;
};

export type RequiredSubscriptionMediaNoticeState = {
  version: 1;
  status: 'planned' | 'delivered';
  scopeKind: RequiredSubscriptionMediaNoticeScope['kind'];
  scopeDigest: string;
  anchorMessageId: string;
  noticeIdempotencyKey: string;
  anchorSourceCreatedAtMs: number;
};

export type RequiredSubscriptionMediaNoticeDeliveredState = RequiredSubscriptionMediaNoticeState & {
  status: 'delivered';
};

export type RequiredSubscriptionMediaNoticeCoverage = RequiredSubscriptionMediaNoticeDeliveredState;

type RequiredSubscriptionMediaNoticeCoverageModel = {
  findUnique?: (args: {
    where: { id: string };
    select: { metadata: true };
  }) => Promise<{ metadata: unknown } | null>;
  upsert?: (args: {
    where: { id: string };
    create: Prisma.ModerationEventUncheckedCreateInput;
    update: Record<string, never>;
    select: { metadata: true };
  }) => Promise<{ metadata: unknown }>;
};

type RequiredSubscriptionMediaNoticeCoordinatorParams<TPlan> = {
  chatId: string;
  userId: string;
  messageId: string;
  botId?: string | null;
  mediaScope: RequiredSubscriptionMediaNoticeScope | null;
  readNoticePlan: (messageId: string) => Promise<TPlan | null>;
  handoffNoticePlan: (
    plan: TPlan,
    idempotencyKey: string,
    assertOwned: () => Promise<void>,
  ) => Promise<void>;
  executeDelete: (assertOwned: () => Promise<void>) => Promise<void>;
  lead: (params: {
    assertOwned: () => Promise<void>;
    noticeIdempotencyKey: string;
    settleNoticePlan: (plan: TPlan) => Promise<void>;
  }) => Promise<boolean>;
};

export function resolveRequiredSubscriptionMediaNoticeScope(params: {
  chatId: string;
  userId: string;
  sourceCreatedAt: string;
  mediaGroupId: string | null;
  mediaEligible: boolean;
}): RequiredSubscriptionMediaNoticeScope | null {
  if (!params.mediaEligible) {
    return null;
  }
  const sourceCreatedAtMs = Date.parse(params.sourceCreatedAt);
  if (!Number.isFinite(sourceCreatedAtMs) || sourceCreatedAtMs <= 0) {
    return null;
  }

  const normalizedGroupId = params.mediaGroupId?.trim() || null;
  const kind = normalizedGroupId ? 'media_group' : 'burst';
  const scopeDigest = digestParts(
    params.chatId.trim(),
    params.userId.trim(),
    kind,
    normalizedGroupId ?? 'fallback',
  );
  return { kind, scopeDigest, sourceCreatedAtMs };
}

export function bindRequiredSubscriptionMediaNoticeScope(params: {
  scope: RequiredSubscriptionMediaNoticeScope;
  requiredChannelIds: readonly string[];
  missingChannelIds: readonly string[];
}): RequiredSubscriptionMediaNoticeScope {
  const requiredChannelIds = normalizeIds(params.requiredChannelIds);
  const missingChannelIds = normalizeIds(params.missingChannelIds);
  return {
    ...params.scope,
    scopeDigest: digestParts(
      params.scope.scopeDigest,
      'required',
      ...requiredChannelIds,
      'missing',
      ...missingChannelIds,
    ),
  };
}

export function buildRequiredSubscriptionMediaNoticeLockKey(
  scope: RequiredSubscriptionMediaNoticeScope,
): string {
  return `moderation:required-subscription:media-notice-lock:v1:${scope.scopeDigest}`;
}

export function buildRequiredSubscriptionMediaNoticeStateKey(
  scope: RequiredSubscriptionMediaNoticeScope,
): string {
  return `moderation:required-subscription:media-notice-state:v1:${scope.scopeDigest}`;
}

export function createRequiredSubscriptionMediaNoticePlannedState(params: {
  scope: RequiredSubscriptionMediaNoticeScope;
  anchorMessageId: string;
  noticeIdempotencyKey: string;
}): RequiredSubscriptionMediaNoticeState {
  return {
    version: REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_VERSION,
    status: 'planned',
    scopeKind: params.scope.kind,
    scopeDigest: params.scope.scopeDigest,
    anchorMessageId: params.anchorMessageId,
    noticeIdempotencyKey: params.noticeIdempotencyKey,
    anchorSourceCreatedAtMs: params.scope.sourceCreatedAtMs,
  };
}

export function markRequiredSubscriptionMediaNoticeDelivered(
  state: RequiredSubscriptionMediaNoticeState,
): RequiredSubscriptionMediaNoticeDeliveredState {
  return { ...state, status: 'delivered' };
}

export function isRequiredSubscriptionMediaNoticeDeliveredState(
  state: RequiredSubscriptionMediaNoticeState,
): state is RequiredSubscriptionMediaNoticeDeliveredState {
  return state.status === 'delivered';
}

export function isRequiredSubscriptionMediaNoticeStateCovering(
  state: RequiredSubscriptionMediaNoticeState,
  scope: RequiredSubscriptionMediaNoticeScope,
): boolean {
  if (state.scopeKind !== scope.kind || state.scopeDigest !== scope.scopeDigest) {
    return false;
  }
  if (scope.kind === 'media_group') {
    return true;
  }
  return (
    Math.abs(scope.sourceCreatedAtMs - state.anchorSourceCreatedAtMs) <=
    REQUIRED_SUBSCRIPTION_MEDIA_BURST_WINDOW_MS
  );
}

export function serializeRequiredSubscriptionMediaNoticeState(
  state: RequiredSubscriptionMediaNoticeState,
): string {
  const serialized = JSON.stringify(state);
  if (
    Buffer.byteLength(serialized, 'utf8') > REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_MAX_METADATA_BYTES
  ) {
    throw new UnrecoverableError('Required subscription media notice state exceeds the limit');
  }
  return serialized;
}

export function parseRequiredSubscriptionMediaNoticeState(
  value: string | null | undefined,
): RequiredSubscriptionMediaNoticeState | null {
  if (
    !value ||
    Buffer.byteLength(value, 'utf8') > REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_MAX_METADATA_BYTES
  ) {
    return null;
  }
  try {
    return parseMediaNoticeReference(JSON.parse(value), false);
  } catch {
    return null;
  }
}

export function buildRequiredSubscriptionMediaNoticeCoverageId(
  chatId: string,
  messageId: string,
): string {
  return `required-subscription-media-notice-coverage-v1:${digestParts(
    chatId.trim(),
    messageId.trim(),
  )}`;
}

export class RequiredSubscriptionMediaNoticeCoverageStore {
  private readonly model: RequiredSubscriptionMediaNoticeCoverageModel;
  private readonly testFallbackCache = new Map<string, RequiredSubscriptionMediaNoticeCoverage>();

  constructor(model: unknown) {
    this.model = model as RequiredSubscriptionMediaNoticeCoverageModel;
  }

  async read(
    chatId: string,
    messageId: string,
  ): Promise<RequiredSubscriptionMediaNoticeCoverage | null> {
    const coverageId = buildRequiredSubscriptionMediaNoticeCoverageId(chatId, messageId);
    if (typeof this.model.findUnique !== 'function') {
      return this.testFallbackCache.get(coverageId) ?? null;
    }
    const row = await this.model.findUnique({
      where: { id: coverageId },
      select: { metadata: true },
    });
    if (!row) {
      return null;
    }
    const coverage = parseCoverageMetadata(row.metadata);
    if (!coverage) {
      throw new UnrecoverableError(`Invalid required subscription media coverage ${coverageId}`);
    }
    return coverage;
  }

  async persist(params: {
    chatId: string;
    userId: string;
    messageId: string;
    botId?: string | null;
    state: RequiredSubscriptionMediaNoticeDeliveredState;
  }): Promise<RequiredSubscriptionMediaNoticeCoverage> {
    const coverageId = buildRequiredSubscriptionMediaNoticeCoverageId(
      params.chatId,
      params.messageId,
    );
    const coverage: RequiredSubscriptionMediaNoticeCoverage = { ...params.state };
    const metadata = {
      requiredSubscriptionMediaNoticeCoverage: coverage,
    } satisfies Prisma.InputJsonObject;
    if (typeof this.model.upsert !== 'function') {
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('Required subscription media coverage persistence is unavailable');
      }
      const existing = this.testFallbackCache.get(coverageId);
      if (existing) {
        return existing;
      }
      if (this.testFallbackCache.size >= REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_TEST_CACHE_MAX) {
        const oldestKey = this.testFallbackCache.keys().next().value;
        if (typeof oldestKey === 'string') {
          this.testFallbackCache.delete(oldestKey);
        }
      }
      this.testFallbackCache.set(coverageId, coverage);
      return coverage;
    }

    const row = await this.model.upsert({
      where: { id: coverageId },
      create: {
        id: coverageId,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        ...(params.botId ? { botId: params.botId } : {}),
        eventType: EventType.SYSTEM,
        ruleCode: REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_COVERAGE_RULE_CODE,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: 0,
        operator: Operator.BOT,
        metadata,
      },
      update: {},
      select: { metadata: true },
    });
    const persisted = parseCoverageMetadata(row.metadata);
    if (!persisted) {
      throw new UnrecoverableError(`Invalid required subscription media coverage ${coverageId}`);
    }
    return persisted;
  }
}

export class RequiredSubscriptionMediaNoticeCoordinator {
  private readonly logger = new Logger(RequiredSubscriptionMediaNoticeCoordinator.name);
  private readonly coverageStore: RequiredSubscriptionMediaNoticeCoverageStore;

  constructor(
    moderationEventModel: unknown,
    private readonly redisCounter?: RedisCounterService,
  ) {
    this.coverageStore = new RequiredSubscriptionMediaNoticeCoverageStore(moderationEventModel);
  }

  canCoordinateMediaNotice(): boolean {
    const redis = this.redisCounter as Partial<RedisCounterService> | undefined;
    return (
      typeof redis?.getString === 'function' &&
      typeof redis.setStringWithTtl === 'function' &&
      typeof redis.acquireLock === 'function' &&
      typeof redis.renewLock === 'function' &&
      typeof redis.releaseLock === 'function'
    );
  }

  async run<TPlan>(
    params: RequiredSubscriptionMediaNoticeCoordinatorParams<TPlan>,
  ): Promise<boolean> {
    const mediaScope = this.canCoordinateMediaNotice() ? params.mediaScope : null;
    const noticeIdempotencyKey = buildNoticeIdempotencyKey(params.chatId, params.messageId);
    const lockKey = mediaScope
      ? buildRequiredSubscriptionMediaNoticeLockKey(mediaScope)
      : buildMessageNoticeLockKey(params.chatId, params.messageId);

    // FLAG: A covered message may be deleted only after a delivered state or durable coverage.
    return this.runExclusive(params, lockKey, async (assertOwned) => {
      const executeDelete = async () => {
        await params.executeDelete(assertOwned);
      };
      const writeMediaState = async (state: RequiredSubscriptionMediaNoticeState) => {
        if (!mediaScope || !this.redisCounter) return;
        await assertOwned();
        await this.redisCounter.setStringWithTtl(
          buildRequiredSubscriptionMediaNoticeStateKey(mediaScope),
          serializeRequiredSubscriptionMediaNoticeState(state),
          REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_STATE_TTL_SEC,
        );
        await assertOwned();
      };
      const handoff = async (
        plan: TPlan,
        state?: RequiredSubscriptionMediaNoticeState,
      ): Promise<RequiredSubscriptionMediaNoticeDeliveredState | null> => {
        await params.handoffNoticePlan(
          plan,
          state?.noticeIdempotencyKey ?? noticeIdempotencyKey,
          assertOwned,
        );
        if (!state) return null;
        const delivered = markRequiredSubscriptionMediaNoticeDelivered(state);
        await writeMediaState(delivered);
        return delivered;
      };
      const persistCoverage = async (state: RequiredSubscriptionMediaNoticeDeliveredState) => {
        if (state.anchorMessageId === params.messageId) return;
        await assertOwned();
        await this.coverageStore.persist({
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          botId: params.botId,
          state,
        });
        await assertOwned();
      };

      if (mediaScope) {
        const coverage = await this.coverageStore.read(params.chatId, params.messageId);
        if (coverage) {
          await executeDelete();
          return true;
        }

        const rawState = await this.redisCounter?.getString(
          buildRequiredSubscriptionMediaNoticeStateKey(mediaScope),
        );
        const state = parseRequiredSubscriptionMediaNoticeState(rawState);
        if (state && isRequiredSubscriptionMediaNoticeStateCovering(state, mediaScope)) {
          let delivered: RequiredSubscriptionMediaNoticeDeliveredState;
          if (state.status === 'planned') {
            const anchorPlan = await params.readNoticePlan(state.anchorMessageId);
            if (!anchorPlan) {
              throw new Error('Required subscription media notice plan is not available yet');
            }
            const recovered = await handoff(anchorPlan, state);
            if (!recovered) {
              throw new Error('Required subscription media notice recovery did not settle');
            }
            delivered = recovered;
          } else if (isRequiredSubscriptionMediaNoticeDeliveredState(state)) {
            delivered = state;
          } else {
            throw new Error('Required subscription media notice state is invalid');
          }
          await persistCoverage(delivered);
          await executeDelete();
          return true;
        }
      }

      const persistedPlan = await params.readNoticePlan(params.messageId);
      if (persistedPlan) {
        const recoveredState = mediaScope
          ? createRequiredSubscriptionMediaNoticePlannedState({
              scope: mediaScope,
              anchorMessageId: params.messageId,
              noticeIdempotencyKey,
            })
          : undefined;
        if (recoveredState) await writeMediaState(recoveredState);
        await handoff(persistedPlan, recoveredState);
        await executeDelete();
        return true;
      }

      return params.lead({
        assertOwned,
        noticeIdempotencyKey,
        settleNoticePlan: async (plan) => {
          const state = mediaScope
            ? createRequiredSubscriptionMediaNoticePlannedState({
                scope: mediaScope,
                anchorMessageId: params.messageId,
                noticeIdempotencyKey,
              })
            : undefined;
          if (state) await writeMediaState(state);
          await handoff(plan, state);
          await executeDelete();
        },
      });
    });
  }

  private async runExclusive<TPlan>(
    params: RequiredSubscriptionMediaNoticeCoordinatorParams<TPlan>,
    lockKey: string,
    task: (assertOwned: () => Promise<void>) => Promise<boolean>,
  ): Promise<boolean> {
    const redis = this.redisCounter as Partial<RedisCounterService> | undefined;
    if (!redis) {
      if (process.env.NODE_ENV === 'test') return task(async () => undefined);
      throw new Error('Required subscription notice lock service is unavailable');
    }
    if (
      typeof redis.acquireLock !== 'function' ||
      typeof redis.renewLock !== 'function' ||
      typeof redis.releaseLock !== 'function'
    ) {
      throw new Error('Required subscription notice lock API is unavailable');
    }

    const lockToken = await redis.acquireLock(lockKey, REQUIRED_SUBSCRIPTION_NOTICE_LOCK_TTL_MS);
    if (!lockToken) {
      throw new Error('Required subscription notice handoff is already in progress');
    }
    let leaseError: Error | null = null;
    const assertOwned = async () => {
      if (leaseError) throw leaseError;
      try {
        const renewed = await redis.renewLock!(
          lockKey,
          lockToken,
          REQUIRED_SUBSCRIPTION_NOTICE_LOCK_TTL_MS,
        );
        if (!renewed) throw new Error('Required subscription notice lease was lost');
      } catch (error: unknown) {
        leaseError =
          error instanceof Error
            ? error
            : new Error('Required subscription notice lease renewal failed');
        throw leaseError;
      }
    };
    const renewalTimer = setInterval(
      () => void assertOwned().catch(() => undefined),
      Math.max(1_000, Math.trunc(REQUIRED_SUBSCRIPTION_NOTICE_LOCK_TTL_MS / 3)),
    );
    renewalTimer.unref?.();

    try {
      const result = await task(assertOwned);
      await assertOwned();
      return result;
    } finally {
      clearInterval(renewalTimer);
      await redis.releaseLock(lockKey, lockToken).catch((error: unknown) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.userId,
            messageId: params.messageId,
            mediaNoticeScope: Boolean(params.mediaScope),
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to release required subscription notice lock',
        );
      });
    }
  }
}

function parseCoverageMetadata(value: unknown): RequiredSubscriptionMediaNoticeCoverage | null {
  const metadata = asRecord(value);
  const parsed = parseMediaNoticeReference(metadata?.requiredSubscriptionMediaNoticeCoverage, true);
  return parsed && isRequiredSubscriptionMediaNoticeDeliveredState(parsed) ? parsed : null;
}

function parseMediaNoticeReference(
  value: unknown,
  deliveredOnly: boolean,
): RequiredSubscriptionMediaNoticeState | null {
  const row = asRecord(value);
  const status = row?.status;
  const scopeKind = row?.scopeKind;
  const scopeDigest = readBoundedString(row?.scopeDigest, 64);
  const anchorMessageId = readBoundedString(row?.anchorMessageId, 1_024);
  const noticeIdempotencyKey = readBoundedString(row?.noticeIdempotencyKey, 2_048);
  const anchorSourceCreatedAtMs = row?.anchorSourceCreatedAtMs;
  if (
    row?.version !== REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_VERSION ||
    (status !== 'planned' && status !== 'delivered') ||
    (deliveredOnly && status !== 'delivered') ||
    (scopeKind !== 'media_group' && scopeKind !== 'burst') ||
    !scopeDigest ||
    !SHA256_HEX_PATTERN.test(scopeDigest) ||
    !anchorMessageId ||
    !noticeIdempotencyKey ||
    typeof anchorSourceCreatedAtMs !== 'number' ||
    !Number.isSafeInteger(anchorSourceCreatedAtMs) ||
    anchorSourceCreatedAtMs <= 0
  ) {
    return null;
  }
  return {
    version: REQUIRED_SUBSCRIPTION_MEDIA_NOTICE_VERSION,
    status,
    scopeKind,
    scopeDigest,
    anchorMessageId,
    noticeIdempotencyKey,
    anchorSourceCreatedAtMs,
  };
}

function digestParts(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part).update('\u0000');
  }
  return hash.digest('hex');
}

function buildNoticeIdempotencyKey(chatId: string, messageId: string): string {
  return `required-subscription:notice:v1:${chatId}:${messageId}`;
}

function buildMessageNoticeLockKey(chatId: string, messageId: string): string {
  return `moderation:required-subscription:notice-lock:v1:${chatId}:${messageId}`;
}

function normalizeIds(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}
