import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
} from './max-client.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from './max-bot-link.service';
import { MaxBotRegistryService } from './max-bot-registry.service';

export type MaxMembershipLookupPolicy =
  | 'moderation_required_subscription'
  | 'giveaway_interactive'
  | 'giveaway_strict'
  | 'giveaway_draw_interactive'
  | 'giveaway_draw_background';

export type MaxMembershipLookupIssueKind = 'transient' | 'terminal';

export type MaxMembershipLookupIssue = {
  chatId: string;
  policyName: MaxMembershipLookupPolicy;
  kind: MaxMembershipLookupIssueKind;
  retryAfterMs: number;
  observedAtMs: number;
  expiresAtMs: number;
  statusCode: number | null;
  message: string;
};

type MaxMembershipLookupOptions = {
  forceRefresh?: boolean;
  allowStaleOnError?: boolean;
  botId?: string | null;
};

export type MaxMembershipLookupResolution = {
  membership: boolean | null;
  fresh: boolean;
};

type MembershipCacheSnapshot = {
  isMember: boolean;
  checkedAtMs: number;
};

type CacheEpochState = {
  epoch: number;
  expiresAtMs: number;
};

type ChatBackoffState = {
  failureCount: number;
  lastFailureAtMs: number;
};

type HotChannelState = {
  failureCount: number;
  lastFailureAtMs: number;
  hotUntilMs: number;
};

type MembershipLookupPolicyConfig = {
  positiveFreshTtlSec: number;
  negativeFreshTtlSec: number;
  backoffMs: number;
  trafficClass: MaxApiTrafficClass;
  allowStaleOnError: boolean;
  sourceTag?: string;
  ignoreFailureMetricStatuses?: readonly number[];
};

type PendingSingleLookup = {
  cacheKey: string;
  cacheEpoch: number;
  probeSequence: number;
  allowStaleOnError: boolean;
  resolve: (value: MaxMembershipLookupResolution) => void;
};

type PendingSingleLookupBatch = {
  chatId: string;
  policy: MembershipLookupPolicyConfig;
  policyName: MaxMembershipLookupPolicy;
  botId: string | null;
  lookups: Map<string, PendingSingleLookup>;
  scheduled: boolean;
  timeout: NodeJS.Timeout | null;
};

const MEMBERSHIP_LOOKUP_POLICIES: Record<MaxMembershipLookupPolicy, MembershipLookupPolicyConfig> =
  {
    moderation_required_subscription: {
      positiveFreshTtlSec: 15,
      negativeFreshTtlSec: 10,
      backoffMs: 15_000,
      trafficClass: 'critical',
      allowStaleOnError: false,
      sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
      ignoreFailureMetricStatuses: [403, 404],
    },
    giveaway_interactive: {
      positiveFreshTtlSec: 15,
      negativeFreshTtlSec: 3,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: true,
    },
    giveaway_strict: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: false,
    },
    giveaway_draw_interactive: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'interactive',
      allowStaleOnError: false,
    },
    giveaway_draw_background: {
      positiveFreshTtlSec: 10,
      negativeFreshTtlSec: 2,
      backoffMs: 5_000,
      trafficClass: 'background',
      allowStaleOnError: false,
      sourceTag: MAX_API_SOURCE_TAGS.GIVEAWAY_DRAW_BACKGROUND,
    },
  };

const BASE_MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.positiveFreshTtlSec),
);
const BASE_MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.negativeFreshTtlSec),
);
const MEMBERSHIP_INVALIDATION_CHANNEL = 'max:membership:invalidate:v1';
const MEMBERSHIP_INVALIDATION_GUARD_TTL_MS = 120_000;
const MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS = 10_000;
const MEMBERSHIP_REDIS_READ_TIMEOUT_MS = 100;
const MEMBERSHIP_LOOKUP_GUARD_SLACK_MS = 400;
const MEMBERSHIP_LOOKUP_SLOW_LOG_THRESHOLD_MS = 1_500;
const GIVEAWAY_DRAW_TERMINAL_CHAT_BACKOFF_MS = 30 * 60 * 1_000;
const REQUIRED_SUBSCRIPTION_TERMINAL_CHAT_BACKOFF_MS = 60_000;
const MEMBERSHIP_CACHE_LEGACY_KEY_PREFIX = 'max:membership:v1';
const MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX = 'max:membership:v2';

@Injectable()
export class MaxMembershipLookupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxMembershipLookupService.name);
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly membershipLookupBatchWindowMs: number;
  private readonly maxChatBackoffMs: number;
  private readonly chatBackoffResetMs: number;
  private readonly hotChannelFailureThreshold: number;
  private readonly hotChannelWindowMs: number;
  private readonly hotChannelDurationMs: number;
  private readonly hotChannelPositiveFreshTtlSec: number;
  private readonly hotChannelBatchWindowMs: number;
  private readonly requiredSubscriptionTerminalChatBackoffMs: number;
  private readonly lookupTimeoutMsByTrafficClass: Record<MaxApiTrafficClass, number>;
  private readonly membershipRetentionPositiveTtlSec: number;
  private readonly membershipRetentionNegativeTtlSec: number;
  private readonly botScopedCacheEnabled: boolean;
  private readonly botScopedCacheDualReadEnabled: boolean;
  private readonly botScopedCacheDualWriteEnabled: boolean;
  private readonly memoryCache = new Map<string, MembershipCacheSnapshot>();
  private readonly inFlight = new Map<string, Promise<MaxMembershipLookupResolution>>();
  private readonly backoffUntilMs = new Map<string, number>();
  private readonly chatBackoffUntilMs = new Map<string, number>();
  private readonly chatBackoffState = new Map<string, ChatBackoffState>();
  private readonly hotChannelStates = new Map<string, HotChannelState>();
  // Invalidation epochs cancel stale work; probe sequences only select the shared-cache writer.
  private readonly cacheEpochs = new Map<string, CacheEpochState>();
  private readonly latestProbeSequenceByCacheKey = new Map<string, number>();
  private readonly pendingSingleLookupBatches = new Map<string, PendingSingleLookupBatch>();
  private readonly lookupIssues = new Map<string, MaxMembershipLookupIssue>();
  private nextProbeSequence = 0;
  private lastRedisWriteFailureLogAtMs = 0;
  private lastRedisInvalidationFailureLogAtMs = 0;

  constructor(
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.subscriber = this.redis.duplicate({ enableReadyCheck: false });
    this.membershipLookupBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS'),
      20,
      0,
    );
    this.maxChatBackoffMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_MAX_MS'),
      60_000,
      1_000,
    );
    this.chatBackoffResetMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_CHAT_BACKOFF_RESET_MS'),
      45_000,
      1_000,
    );
    this.hotChannelFailureThreshold = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_FAILURE_THRESHOLD'),
      2,
    );
    this.hotChannelWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_WINDOW_MS'),
      45_000,
      1_000,
    );
    this.hotChannelDurationMs =
      this.readConfigInt(configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_DURATION_SEC'), 120) *
      1_000;
    this.hotChannelPositiveFreshTtlSec = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_POSITIVE_TTL_SEC'),
      90,
      MEMBERSHIP_LOOKUP_POLICIES.moderation_required_subscription.positiveFreshTtlSec,
    );
    this.hotChannelBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS'),
      25,
      this.membershipLookupBatchWindowMs,
    );
    this.requiredSubscriptionTerminalChatBackoffMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_REQUIRED_SUBSCRIPTION_TERMINAL_BACKOFF_MS'),
      REQUIRED_SUBSCRIPTION_TERMINAL_CHAT_BACKOFF_MS,
      1_000,
    );
    this.lookupTimeoutMsByTrafficClass = {
      critical: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL'),
        1_500,
      ),
      interactive: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE'),
        3_000,
      ),
      background: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_BACKGROUND'),
        5_000,
      ),
    };
    this.membershipRetentionPositiveTtlSec = Math.max(
      BASE_MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC,
      this.hotChannelPositiveFreshTtlSec,
    );
    this.membershipRetentionNegativeTtlSec = BASE_MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC;
    this.botScopedCacheEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_ENABLED',
      true,
    );
    this.botScopedCacheDualReadEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_DUAL_READ',
      true,
    );
    this.botScopedCacheDualWriteEnabled = configService.get<boolean>(
      'MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_DUAL_WRITE',
      true,
    );
  }

  async onModuleInit(): Promise<void> {
    this.subscriber.on('message', (channel, payload) => {
      if (channel !== MEMBERSHIP_INVALIDATION_CHANNEL) {
        return;
      }

      const normalized = this.parseInvalidationMessage(payload);
      if (!normalized) {
        return;
      }

      this.applyLocalInvalidation(normalized.chatId, normalized.userIds);
      void this.deleteInvalidatedRedisSnapshots(normalized.chatId, normalized.userIds).catch(
        (error: unknown) => {
          this.logRedisInvalidationFailure(normalized.chatId, normalized.userIds, error);
        },
      );
    });
    await this.subscriber.subscribe(MEMBERSHIP_INVALIDATION_CHANNEL);
  }

  async onModuleDestroy() {
    this.clearPendingSingleLookupBatchTimers();
    await this.subscriber.quit();
    await this.redis.quit();
  }

  async invalidateMemberships(chatId: string, userIds: readonly string[]): Promise<void> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return;
    }

    this.applyLocalInvalidation(normalizedChatId, normalizedUserIds);

    await Promise.all([
      this.deleteInvalidatedRedisSnapshots(normalizedChatId, normalizedUserIds),
      this.redis.publish(
        MEMBERSHIP_INVALIDATION_CHANNEL,
        JSON.stringify({
          chatId: normalizedChatId,
          userIds: normalizedUserIds,
        }),
      ),
    ]);
  }

  async getMembership(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<boolean | null> {
    const resolution = await this.getMembershipResolution(chatId, userId, policyName, options);
    return resolution.membership;
  }

  async getMembershipResolution(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<MaxMembershipLookupResolution> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return { membership: null, fresh: false };
    }

    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return { membership: false, fresh: true };
    }

    const membershipByUserId = await this.getMembershipResolutions(
      normalizedChatId,
      [normalizedUserId],
      policyName,
      options,
    );
    return membershipByUserId.get(normalizedUserId) ?? { membership: null, fresh: false };
  }

  async getMemberships(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<Map<string, boolean | null>> {
    const resolutions = await this.getMembershipResolutions(chatId, userIds, policyName, options);
    const memberships = new Map<string, boolean | null>();
    for (const [userId, resolution] of resolutions) {
      memberships.set(userId, resolution.membership);
    }
    return memberships;
  }

  async getMembershipResolutions(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<Map<string, MaxMembershipLookupResolution>> {
    const normalizedChatId = chatId.trim();
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    const results = new Map<string, MaxMembershipLookupResolution>();
    if (!normalizedChatId || normalizedUserIds.length === 0) {
      return results;
    }

    const now = Date.now();
    const requestedBotId = typeof options.botId === 'string' ? options.botId.trim() : '';
    let lookupBotId: string | null = this.normalizeBotScopedCacheBotId(requestedBotId);
    if (
      !lookupBotId &&
      this.botScopedCacheEnabled &&
      normalizedUserIds.length > 0 &&
      this.maxBotLinkService
    ) {
      lookupBotId = await this.resolveLookupBotId(normalizedChatId);
    }
    const basePolicy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const policy = this.resolveEffectivePolicy(normalizedChatId, policyName, basePolicy, now);
    const allowStaleOnError = options.allowStaleOnError ?? policy.allowStaleOnError;
    const chatBackoffKey = this.buildChatPolicyKey(normalizedChatId, policyName);
    const pendingPromises = new Map<string, Promise<MaxMembershipLookupResolution>>();
    const usersToLookup: string[] = [];
    const cacheKeyByUserId = new Map(
      normalizedUserIds.map((userId) => [
        userId,
        this.buildCacheKey(normalizedChatId, userId, lookupBotId, policyName),
      ]),
    );
    const legacyCacheKeyByUserId = new Map(
      normalizedUserIds.map((userId) => [
        userId,
        this.buildLegacyCacheKey(normalizedChatId, userId),
      ]),
    );
    let unresolvedUserIds: string[] = [];

    for (const userId of normalizedUserIds) {
      const cacheKey = cacheKeyByUserId.get(userId)!;
      const freshMemorySnapshot = !options.forceRefresh
        ? this.readFreshMemorySnapshot(cacheKey, policy, now)
        : null;
      if (freshMemorySnapshot) {
        results.set(userId, { membership: freshMemorySnapshot.isMember, fresh: true });
        continue;
      }

      unresolvedUserIds.push(userId);
    }

    if (!options.forceRefresh && unresolvedUserIds.length > 0) {
      const redisReadEpochByCacheKey = new Map(
        unresolvedUserIds.map((userId) => {
          const cacheKey = cacheKeyByUserId.get(userId)!;
          return [cacheKey, this.readCacheEpoch(cacheKey)] as const;
        }),
      );
      const redisReadKeys = unresolvedUserIds.flatMap((userId) =>
        this.buildRedisReadKeys(
          cacheKeyByUserId.get(userId)!,
          legacyCacheKeyByUserId.get(userId)!,
          lookupBotId,
          policyName,
        ),
      );
      const redisSnapshots = await this.readRedisSnapshots(redisReadKeys);
      const stillUnresolvedUserIds: string[] = [];

      for (const userId of unresolvedUserIds) {
        const cacheKey = cacheKeyByUserId.get(userId)!;
        const legacyCacheKey = legacyCacheKeyByUserId.get(userId)!;
        if (!this.hasSameCacheEpoch(cacheKey, redisReadEpochByCacheKey.get(cacheKey) ?? 0)) {
          stillUnresolvedUserIds.push(userId);
          continue;
        }
        const redisSnapshot =
          redisSnapshots.get(cacheKey) ??
          (this.shouldReadLegacyCache(lookupBotId) ? redisSnapshots.get(legacyCacheKey) : null) ??
          null;
        if (redisSnapshot) {
          this.memoryCache.set(cacheKey, redisSnapshot);
          if (this.isSnapshotFresh(redisSnapshot, policy, now)) {
            results.set(userId, { membership: redisSnapshot.isMember, fresh: true });
            continue;
          }
        }

        stillUnresolvedUserIds.push(userId);
      }

      unresolvedUserIds = stillUnresolvedUserIds;
    }

    for (const userId of unresolvedUserIds) {
      const cacheKey = cacheKeyByUserId.get(userId)!;
      const backoffUntilMs = this.backoffUntilMs.get(cacheKey) ?? 0;
      if (backoffUntilMs > now) {
        results.set(userId, {
          membership: this.resolveLookupFallback(
            normalizedChatId,
            policyName,
            cacheKey,
            allowStaleOnError,
            now,
          ),
          fresh: false,
        });
        continue;
      }

      const inFlightKey = this.buildInFlightKey(cacheKey, policyName, allowStaleOnError);
      const inFlight = this.inFlight.get(inFlightKey);
      if (inFlight) {
        pendingPromises.set(userId, inFlight);
        continue;
      }

      const chatBackoffUntilMs = this.chatBackoffUntilMs.get(chatBackoffKey) ?? 0;
      if (chatBackoffUntilMs > now) {
        results.set(userId, {
          membership: this.resolveLookupFallback(
            normalizedChatId,
            policyName,
            cacheKey,
            allowStaleOnError,
            now,
          ),
          fresh: false,
        });
        continue;
      }

      usersToLookup.push(userId);
    }

    if (usersToLookup.length > 0 && !lookupBotId && this.maxBotLinkService) {
      lookupBotId = await this.resolveLookupBotId(normalizedChatId);
    }

    if (usersToLookup.length === 1) {
      const [userId] = usersToLookup;
      pendingPromises.set(
        userId,
        this.enqueueSingleLookupBatch(
          normalizedChatId,
          userId,
          policyName,
          allowStaleOnError,
          lookupBotId,
        ),
      );
    } else if (usersToLookup.length > 1) {
      const batchPromises = this.createBatchLookupPromises(
        normalizedChatId,
        usersToLookup,
        policyName,
        allowStaleOnError,
        lookupBotId,
      );
      for (const [userId, promise] of batchPromises) {
        pendingPromises.set(userId, promise);
      }
    }

    for (const userId of normalizedUserIds) {
      if (results.has(userId)) {
        continue;
      }

      const promise = pendingPromises.get(userId);
      results.set(userId, promise ? await promise : { membership: null, fresh: false });
    }

    return results;
  }

  getLookupIssue(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): MaxMembershipLookupIssue | null {
    const key = this.buildChatPolicyKey(chatId.trim(), policyName);
    const issue = this.lookupIssues.get(key) ?? null;
    if (!issue) {
      return null;
    }

    if (issue.expiresAtMs <= now) {
      this.lookupIssues.delete(key);
      return null;
    }

    return { ...issue };
  }

  private enqueueSingleLookupBatch(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    botId: string | null,
  ): Promise<MaxMembershipLookupResolution> {
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const batchKey = this.buildSingleLookupBatchKey(chatId, policyName, botId, allowStaleOnError);
    let batch = this.pendingSingleLookupBatches.get(batchKey);
    if (!batch) {
      batch = {
        chatId,
        policy,
        policyName,
        botId,
        lookups: new Map(),
        scheduled: false,
        timeout: null,
      };
      this.pendingSingleLookupBatches.set(batchKey, batch);
    } else if (!batch.botId && botId) {
      batch.botId = botId;
    }

    const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
    const inFlightKey = this.buildInFlightKey(cacheKey, policyName, allowStaleOnError);
    const cacheEpoch = this.readCacheEpoch(cacheKey);
    const probeSequence = this.beginProbe(cacheKey);
    const lookupPromise = new Promise<MaxMembershipLookupResolution>((resolve) => {
      batch!.lookups.set(userId, {
        cacheKey,
        cacheEpoch,
        probeSequence,
        allowStaleOnError,
        resolve,
      });
    });

    const trackedPromise = lookupPromise.finally(() => {
      if (this.inFlight.get(inFlightKey) === trackedPromise) {
        this.inFlight.delete(inFlightKey);
      }
      this.finishProbe(cacheKey, probeSequence);
    });

    this.inFlight.set(inFlightKey, trackedPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      const batchWindowMs = this.resolveSingleLookupBatchWindowMs(chatId, policyName);
      if (batchWindowMs === 0) {
        void Promise.resolve().then(() => this.flushPendingSingleLookupBatch(batchKey));
      } else {
        batch.timeout = setTimeout(() => {
          batch!.timeout = null;
          void this.flushPendingSingleLookupBatch(batchKey);
        }, batchWindowMs);
        batch.timeout.unref?.();
      }
    }

    return trackedPromise;
  }

  private async flushPendingSingleLookupBatch(batchKey: string): Promise<void> {
    const batch = this.pendingSingleLookupBatches.get(batchKey);
    if (!batch) {
      return;
    }

    this.pendingSingleLookupBatches.delete(batchKey);
    if (batch.timeout) {
      clearTimeout(batch.timeout);
      batch.timeout = null;
    }
    const userIds = [...batch.lookups.keys()];
    if (userIds.length === 0) {
      return;
    }

    const probeStartedAt = new Date();
    try {
      const accessByUserId = await this.executeLookupWithGuard(
        async () =>
          this.maxClient.getChatMembersAccess(batch.chatId, userIds, {
            trafficClass: batch.policy.trafficClass,
            timeoutMs: this.resolveLookupTimeoutMs(batch.policy.trafficClass),
            ...(batch.policyName === 'moderation_required_subscription'
              ? { bypassCache: true }
              : {}),
            ...(batch.policy.sourceTag ? { sourceTag: batch.policy.sourceTag } : {}),
            ...(batch.policy.ignoreFailureMetricStatuses
              ? { ignoreFailureMetricStatuses: batch.policy.ignoreFailureMetricStatuses }
              : {}),
            ...(batch.botId ? { botId: batch.botId } : {}),
          }),
        {
          chatId: batch.chatId,
          userIds,
          policyName: batch.policyName,
          trafficClass: batch.policy.trafficClass,
        },
      );
      const checkedAtMs = Date.now();
      if (this.hasAuthoritativePendingLookup(batch.lookups.values())) {
        this.clearChatBackoff(batch.chatId, batch.policyName);
        this.clearHotChannelMode(batch.chatId, batch.policyName);
        this.clearLookupIssue(batch.chatId, batch.policyName);
      }

      for (const [userId, lookup] of batch.lookups.entries()) {
        if (!this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
          lookup.resolve({ membership: null, fresh: false });
          continue;
        }
        const isMember = accessByUserId.has(userId);
        const snapshot: MembershipCacheSnapshot = {
          isMember,
          checkedAtMs,
        };
        if (this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)) {
          this.storeSnapshot(lookup.cacheKey, snapshot, batch.policyName);
          this.backoffUntilMs.delete(lookup.cacheKey);
        }
        lookup.resolve({ membership: isMember, fresh: true });
      }
    } catch (error: unknown) {
      const transient = this.isTransientLookupError(error);
      const terminalBackoffMs = this.resolveTerminalChatBackoffMs(batch.policyName);
      const terminalAccess = this.isTerminalChatAccessError(error);
      const authoritative = this.hasAuthoritativePendingLookup(batch.lookups.values());
      const terminal = authoritative && terminalBackoffMs > 0 && terminalAccess;
      if (authoritative && terminalAccess) {
        await this.persistTerminalBotAccessProbe({
          chatId: batch.chatId,
          botId: batch.botId,
          policyName: batch.policyName,
          probeStartedAt,
          error,
        });
      }
      let appliedBackoffMs = 0;
      if (terminal) {
        const appliedBackoff = this.applyTerminalChatBackoff(
          batch.chatId,
          batch.policyName,
          terminalBackoffMs,
        );
        appliedBackoffMs = appliedBackoff.backoffMs;
      } else if (authoritative && transient) {
        const appliedBackoff = this.applyChatBackoff(batch.chatId, batch.policyName, batch.policy);
        appliedBackoffMs = appliedBackoff.backoffMs;
        this.recordHotChannelFailure(batch.chatId, batch.policyName);
        for (const lookup of batch.lookups.values()) {
          if (
            this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch) &&
            this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)
          ) {
            this.backoffUntilMs.set(lookup.cacheKey, appliedBackoff.backoffUntilMs);
          }
        }
      }

      if (terminal || (authoritative && transient)) {
        this.recordLookupIssue(batch.chatId, batch.policyName, error, {
          kind: terminal ? 'terminal' : 'transient',
          retryAfterMs: appliedBackoffMs,
        });
      }

      this.logLookupError(error, {
        chatId: batch.chatId,
        userIds,
        policyName: batch.policyName,
        backoffMs: appliedBackoffMs,
      });

      for (const lookup of batch.lookups.values()) {
        if (!this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
          lookup.resolve({ membership: null, fresh: false });
          continue;
        }
        lookup.resolve({
          membership: this.resolveLookupFallback(
            batch.chatId,
            batch.policyName,
            lookup.cacheKey,
            lookup.allowStaleOnError,
          ),
          fresh: false,
        });
      }
    }
  }

  private createBatchLookupPromises(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    botId: string | null,
  ): Map<string, Promise<MaxMembershipLookupResolution>> {
    const normalizedUserIds = Array.from(new Set(userIds));
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const cacheEpochByKey = new Map(
      normalizedUserIds.map((userId) => {
        const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
        return [cacheKey, this.readCacheEpoch(cacheKey)] as const;
      }),
    );
    const probeSequenceByKey = new Map(
      normalizedUserIds.map((userId) => {
        const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
        return [cacheKey, this.beginProbe(cacheKey)] as const;
      }),
    );
    const batchLookupPromise = (async () => {
      const probeStartedAt = new Date();
      try {
        const accessByUserId = await this.executeLookupWithGuard(
          async () =>
            this.maxClient.getChatMembersAccess(chatId, normalizedUserIds, {
              trafficClass: policy.trafficClass,
              timeoutMs: this.resolveLookupTimeoutMs(policy.trafficClass),
              ...(policyName === 'moderation_required_subscription' ? { bypassCache: true } : {}),
              ...(policy.sourceTag ? { sourceTag: policy.sourceTag } : {}),
              ...(policy.ignoreFailureMetricStatuses
                ? { ignoreFailureMetricStatuses: policy.ignoreFailureMetricStatuses }
                : {}),
              ...(botId ? { botId } : {}),
            }),
          {
            chatId,
            userIds: normalizedUserIds,
            policyName,
            trafficClass: policy.trafficClass,
          },
        );
        const checkedAtMs = Date.now();
        const results = new Map<string, MaxMembershipLookupResolution>();
        if (
          normalizedUserIds.some((userId) => {
            const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
            return (
              this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
              this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
            );
          })
        ) {
          this.clearChatBackoff(chatId, policyName);
          this.clearHotChannelMode(chatId, policyName);
          this.clearLookupIssue(chatId, policyName);
        }

        for (const userId of normalizedUserIds) {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          if (!this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
            results.set(userId, { membership: null, fresh: false });
            continue;
          }
          const isMember = accessByUserId.has(userId);
          const snapshot: MembershipCacheSnapshot = {
            isMember,
            checkedAtMs,
          };
          if (this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)) {
            this.storeSnapshot(cacheKey, snapshot, policyName);
            this.backoffUntilMs.delete(cacheKey);
          }
          results.set(userId, { membership: isMember, fresh: true });
        }

        return results;
      } catch (error: unknown) {
        const transient = this.isTransientLookupError(error);
        const terminalBackoffMs = this.resolveTerminalChatBackoffMs(policyName);
        const terminalAccess = this.isTerminalChatAccessError(error);
        const authoritative = normalizedUserIds.some((userId) => {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          return (
            this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
            this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
          );
        });
        const terminal = authoritative && terminalBackoffMs > 0 && terminalAccess;
        if (authoritative && terminalAccess) {
          await this.persistTerminalBotAccessProbe({
            chatId,
            botId,
            policyName,
            probeStartedAt,
            error,
          });
        }
        let appliedBackoffMs = 0;
        if (terminal) {
          const appliedBackoff = this.applyTerminalChatBackoff(
            chatId,
            policyName,
            terminalBackoffMs,
          );
          appliedBackoffMs = appliedBackoff.backoffMs;
        } else if (authoritative && transient) {
          const appliedBackoff = this.applyChatBackoff(chatId, policyName, policy);
          appliedBackoffMs = appliedBackoff.backoffMs;
          this.recordHotChannelFailure(chatId, policyName);
          for (const userId of normalizedUserIds) {
            const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
            if (
              this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0) &&
              this.isLatestProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0)
            ) {
              this.backoffUntilMs.set(cacheKey, appliedBackoff.backoffUntilMs);
            }
          }
        }
        if (terminal || (authoritative && transient)) {
          this.recordLookupIssue(chatId, policyName, error, {
            kind: terminal ? 'terminal' : 'transient',
            retryAfterMs: appliedBackoffMs,
          });
        }
        this.logLookupError(error, {
          chatId,
          userIds: normalizedUserIds,
          policyName,
          backoffMs: appliedBackoffMs,
        });

        const results = new Map<string, MaxMembershipLookupResolution>();
        for (const userId of normalizedUserIds) {
          const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
          if (!this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
            results.set(userId, { membership: null, fresh: false });
            continue;
          }
          results.set(userId, {
            membership: this.resolveLookupFallback(chatId, policyName, cacheKey, allowStaleOnError),
            fresh: false,
          });
        }
        return results;
      }
    })();

    const promises = new Map<string, Promise<MaxMembershipLookupResolution>>();
    for (const userId of normalizedUserIds) {
      const cacheKey = this.buildCacheKey(chatId, userId, botId, policyName);
      const inFlightKey = this.buildInFlightKey(cacheKey, policyName, allowStaleOnError);
      const trackedPromise = batchLookupPromise
        .then((results) => results.get(userId) ?? { membership: null, fresh: false })
        .finally(() => {
          if (this.inFlight.get(inFlightKey) === trackedPromise) {
            this.inFlight.delete(inFlightKey);
          }
          this.finishProbe(cacheKey, probeSequenceByKey.get(cacheKey) ?? 0);
        });
      this.inFlight.set(inFlightKey, trackedPromise);
      promises.set(userId, trackedPromise);
    }

    return promises;
  }

  private logLookupError(
    error: unknown,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      backoffMs: number;
    },
  ) {
    this.logger.warn(
      {
        chatId: context.chatId,
        userIds: context.userIds,
        policyName: context.policyName,
        backoffMs: context.backoffMs,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to resolve MAX membership',
    );
  }

  private async persistTerminalBotAccessProbe(params: {
    chatId: string;
    botId: string | null;
    policyName: MaxMembershipLookupPolicy;
    probeStartedAt: Date;
    error: unknown;
  }): Promise<void> {
    const botId = this.normalizeBotScopedCacheBotId(params.botId);
    const recordBotAccessProbe = this.maxBotLinkService?.recordBotAccessProbe;
    if (!botId || typeof recordBotAccessProbe !== 'function') {
      return;
    }

    try {
      await recordBotAccessProbe.call(this.maxBotLinkService, {
        chatId: params.chatId,
        botId,
        access: null,
        source: `membership_lookup_${params.policyName}`,
        checkedAt: params.probeStartedAt,
        lastErrorCode: this.resolveTerminalChatAccessErrorCode(params.error),
        allowMembershipRecovery: false,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          botId,
          policyName: params.policyName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist terminal MAX membership lookup bot access',
      );
    }
  }

  private async resolveLookupBotId(chatId: string): Promise<string | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver.resolveBotRoute === 'function') {
      const route = await routeResolver.resolveBotRoute({
        purpose: 'read',
        chatId,
      });
      if (route.botId) {
        return route.botId;
      }
    }

    if (typeof this.maxBotLinkService.resolveBotIdForRead === 'function') {
      const botId = await this.maxBotLinkService.resolveBotIdForRead({ chatId });
      if (botId) {
        return botId;
      }
    }

    if (typeof this.maxBotLinkService.resolveBotIdForMemberAccess === 'function') {
      const botId = await this.maxBotLinkService.resolveBotIdForMemberAccess({ chatId });
      if (botId) {
        return botId;
      }
    }

    return (
      (await this.maxBotLinkService.resolveBotId({
        chatId,
      })) ?? null
    );
  }

  private parseInvalidationMessage(payload: string): {
    chatId: string;
    userIds: string[];
  } | null {
    try {
      const parsed = JSON.parse(payload) as {
        chatId?: unknown;
        userIds?: unknown;
      };
      if (
        (typeof parsed.chatId !== 'string' && typeof parsed.chatId !== 'number') ||
        !Array.isArray(parsed.userIds)
      ) {
        return null;
      }

      const chatId = String(parsed.chatId).trim();
      const userIds = Array.from(
        new Set(
          parsed.userIds
            .map((value) => (typeof value === 'string' ? value.trim() : ''))
            .filter((value): value is string => value.length > 0),
        ),
      );
      if (!chatId || userIds.length === 0) {
        return null;
      }

      return {
        chatId,
        userIds,
      };
    } catch {
      return null;
    }
  }

  private applyLocalInvalidation(chatId: string, userIds: readonly string[]) {
    const now = Date.now();
    const cacheKeys = new Set(this.cancelPendingSingleLookups(chatId, userIds));
    for (const userId of userIds) {
      for (const cacheKey of this.buildInvalidationCacheKeys(chatId, userId)) {
        cacheKeys.add(cacheKey);
      }
    }

    for (const cacheKey of cacheKeys) {
      this.memoryCache.delete(cacheKey);
      this.deleteInFlightLookups(cacheKey);
      this.backoffUntilMs.delete(cacheKey);
      this.bumpCacheEpoch(cacheKey, now);
    }
  }

  private cancelPendingSingleLookups(chatId: string, userIds: readonly string[]): string[] {
    const invalidatedUserIds = new Set(userIds);
    const cacheKeys = new Set<string>();

    for (const [batchKey, batch] of this.pendingSingleLookupBatches) {
      if (batch.chatId !== chatId) {
        continue;
      }

      for (const userId of invalidatedUserIds) {
        const lookup = batch.lookups.get(userId);
        if (!lookup) {
          continue;
        }

        batch.lookups.delete(userId);
        cacheKeys.add(lookup.cacheKey);
        lookup.resolve({ membership: null, fresh: false });
      }

      if (batch.lookups.size === 0) {
        if (batch.timeout) {
          clearTimeout(batch.timeout);
          batch.timeout = null;
        }
        this.pendingSingleLookupBatches.delete(batchKey);
      }
    }

    return [...cacheKeys];
  }

  private deleteInvalidatedRedisSnapshots(
    chatId: string,
    userIds: readonly string[],
  ): Promise<number> {
    const cacheKeys = Array.from(
      new Set(userIds.flatMap((userId) => this.buildInvalidationCacheKeys(chatId, userId))),
    );
    return cacheKeys.length > 0 ? this.redis.del(...cacheKeys) : Promise.resolve(0);
  }

  private resolveLookupFallback(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    cacheKey: string,
    allowStaleOnError: boolean,
    now = Date.now(),
  ): boolean | null {
    if (!allowStaleOnError) {
      return null;
    }

    const snapshot = this.readRetainedMemorySnapshot(cacheKey, now);
    if (!snapshot) {
      return null;
    }

    if (
      snapshot.isMember ||
      !this.isHotChannelModeActive(chatId, policyName, now) ||
      policyName !== 'moderation_required_subscription'
    ) {
      return snapshot.isMember;
    }

    return null;
  }

  private storeSnapshot(
    cacheKey: string,
    snapshot: MembershipCacheSnapshot,
    policyName: MaxMembershipLookupPolicy,
  ) {
    this.memoryCache.set(cacheKey, snapshot);
    // A bypassed moderation result may warm general reads; general reads never write its key.
    const sharedCacheKey = this.deriveSharedCacheKey(cacheKey, policyName);
    if (sharedCacheKey !== cacheKey) {
      this.memoryCache.set(sharedCacheKey, snapshot);
    }
    const legacyCacheKey = this.deriveLegacyCacheKeyFromCacheKey(cacheKey);
    void this.writeRedisSnapshot(cacheKey, legacyCacheKey, snapshot, policyName).catch(
      (error: unknown) => {
        this.logRedisWriteFailure(cacheKey, error);
      },
    );
  }

  private readCacheEpoch(cacheKey: string, now = Date.now()): number {
    const state = this.cacheEpochs.get(cacheKey);
    if (!state) {
      return 0;
    }

    if (state.expiresAtMs <= now) {
      this.cacheEpochs.delete(cacheKey);
      return 0;
    }

    return state.epoch;
  }

  private hasSameCacheEpoch(cacheKey: string, epoch: number): boolean {
    return this.readCacheEpoch(cacheKey) === epoch;
  }

  private beginProbe(cacheKey: string): number {
    this.nextProbeSequence += 1;
    this.latestProbeSequenceByCacheKey.set(cacheKey, this.nextProbeSequence);
    return this.nextProbeSequence;
  }

  private isLatestProbe(cacheKey: string, probeSequence: number): boolean {
    return this.latestProbeSequenceByCacheKey.get(cacheKey) === probeSequence;
  }

  private finishProbe(cacheKey: string, probeSequence: number): void {
    if (this.isLatestProbe(cacheKey, probeSequence)) {
      this.latestProbeSequenceByCacheKey.delete(cacheKey);
    }
  }

  private hasAuthoritativePendingLookup(
    lookups: Iterable<Pick<PendingSingleLookup, 'cacheKey' | 'cacheEpoch' | 'probeSequence'>>,
  ): boolean {
    for (const lookup of lookups) {
      if (
        this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch) &&
        this.isLatestProbe(lookup.cacheKey, lookup.probeSequence)
      ) {
        return true;
      }
    }
    return false;
  }

  private bumpCacheEpoch(cacheKey: string, now = Date.now()): number {
    const nextEpoch = this.readCacheEpoch(cacheKey, now) + 1;
    this.cacheEpochs.set(cacheKey, {
      epoch: nextEpoch,
      expiresAtMs: now + MEMBERSHIP_INVALIDATION_GUARD_TTL_MS,
    });
    return nextEpoch;
  }

  private async readRedisSnapshots(
    cacheKeys: readonly string[],
  ): Promise<Map<string, MembershipCacheSnapshot>> {
    const normalizedCacheKeys = Array.from(
      new Set(cacheKeys.filter((cacheKey): cacheKey is string => cacheKey.trim().length > 0)),
    );
    if (normalizedCacheKeys.length === 0) {
      return new Map();
    }

    const rawValues = await this.runRedisReadWithin(
      this.redis.mget(...normalizedCacheKeys).catch(() => normalizedCacheKeys.map(() => null)),
      MEMBERSHIP_REDIS_READ_TIMEOUT_MS,
    );
    if (!rawValues) {
      return new Map();
    }
    const snapshots = new Map<string, MembershipCacheSnapshot>();

    for (const [index, rawValue] of rawValues.entries()) {
      if (typeof rawValue !== 'string' || rawValue.length === 0) {
        continue;
      }

      const snapshot = this.parseRedisSnapshot(rawValue);
      if (!snapshot) {
        continue;
      }

      snapshots.set(normalizedCacheKeys[index]!, snapshot);
    }

    return snapshots;
  }

  private async writeRedisSnapshot(
    cacheKey: string,
    legacyCacheKey: string,
    snapshot: MembershipCacheSnapshot,
    policyName: MaxMembershipLookupPolicy,
  ): Promise<void> {
    const ttlSec = snapshot.isMember
      ? this.membershipRetentionPositiveTtlSec
      : this.membershipRetentionNegativeTtlSec;
    const redisWriteKeys = this.buildRedisWriteKeys(cacheKey, legacyCacheKey, policyName);
    if (redisWriteKeys.length === 1) {
      await this.redis.set(cacheKey, JSON.stringify(snapshot), 'EX', ttlSec);
      return;
    }

    const pipeline = this.redis.pipeline();
    for (const writeKey of redisWriteKeys) {
      pipeline.set(writeKey, JSON.stringify(snapshot), 'EX', ttlSec);
    }
    await pipeline.exec();
  }

  private deriveLegacyCacheKeyFromCacheKey(cacheKey: string): string {
    if (cacheKey.startsWith(`${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:`)) {
      const parts = cacheKey.slice(`${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:`.length).split(':');
      if (parts.length >= 3) {
        const [chatId, userId] = parts;
        if (chatId && userId) {
          return this.buildLegacyCacheKey(chatId, userId);
        }
      }
    }

    return cacheKey;
  }

  private async runRedisReadWithin<T>(operation: Promise<T>, maxWaitMs: number): Promise<T | null> {
    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), Math.max(1, Math.trunc(maxWaitMs)));
      timeout.unref?.();
    });

    try {
      return await Promise.race([operation, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private parseRedisSnapshot(raw: string): MembershipCacheSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as {
        checkedAtMs?: unknown;
        isMember?: unknown;
      };
      if (
        typeof parsed.checkedAtMs !== 'number' ||
        !Number.isFinite(parsed.checkedAtMs) ||
        typeof parsed.isMember !== 'boolean'
      ) {
        return null;
      }

      const snapshot: MembershipCacheSnapshot = {
        checkedAtMs: Math.trunc(parsed.checkedAtMs),
        isMember: parsed.isMember,
      };
      const retentionTtlMs = this.resolveRetentionTtlMs(snapshot.isMember);
      if (snapshot.checkedAtMs + retentionTtlMs <= Date.now()) {
        return null;
      }

      return snapshot;
    } catch {
      return null;
    }
  }

  private readFreshMemorySnapshot(
    cacheKey: string,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): MembershipCacheSnapshot | null {
    const snapshot = this.readRetainedMemorySnapshot(cacheKey, now);
    if (!snapshot) {
      return null;
    }

    return this.isSnapshotFresh(snapshot, policy, now) ? snapshot : null;
  }

  private readRetainedMemorySnapshot(
    cacheKey: string,
    now = Date.now(),
  ): MembershipCacheSnapshot | null {
    const snapshot = this.memoryCache.get(cacheKey);
    if (!snapshot) {
      return null;
    }

    const retentionTtlMs = this.resolveRetentionTtlMs(snapshot.isMember);
    if (snapshot.checkedAtMs + retentionTtlMs <= now) {
      this.memoryCache.delete(cacheKey);
      return null;
    }

    return snapshot;
  }

  private isSnapshotFresh(
    snapshot: MembershipCacheSnapshot,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): boolean {
    const freshTtlMs =
      (snapshot.isMember ? policy.positiveFreshTtlSec : policy.negativeFreshTtlSec) * 1_000;
    return snapshot.checkedAtMs + freshTtlMs > now;
  }

  private resolveRetentionTtlMs(isMember: boolean): number {
    return (
      (isMember ? this.membershipRetentionPositiveTtlSec : this.membershipRetentionNegativeTtlSec) *
      1_000
    );
  }

  private buildCacheKey(
    chatId: string,
    userId: string,
    botId: string | null,
    policyName: MaxMembershipLookupPolicy,
  ): string {
    const normalizedBotId = this.normalizeBotScopedCacheBotId(botId);
    const baseKey =
      this.botScopedCacheEnabled && normalizedBotId
        ? `${MEMBERSHIP_CACHE_BOT_SCOPED_KEY_PREFIX}:${chatId}:${userId}:${normalizedBotId}`
        : this.buildLegacyCacheKey(chatId, userId);
    return policyName === 'moderation_required_subscription'
      ? `${baseKey}:policy:${policyName}`
      : baseKey;
  }

  private buildInFlightKey(
    cacheKey: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
  ): string {
    return `${cacheKey}|${policyName}|${allowStaleOnError ? 'stale' : 'strict'}`;
  }

  private deleteInFlightLookups(cacheKey: string): void {
    const keyPrefix = `${cacheKey}|`;
    for (const inFlightKey of this.inFlight.keys()) {
      if (inFlightKey.startsWith(keyPrefix)) {
        this.inFlight.delete(inFlightKey);
      }
    }
  }

  private buildLegacyCacheKey(chatId: string, userId: string): string {
    return `${MEMBERSHIP_CACHE_LEGACY_KEY_PREFIX}:${chatId}:${userId}`;
  }

  private buildSingleLookupBatchKey(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    botId: string | null,
    allowStaleOnError: boolean,
  ): string {
    const normalizedBotId = this.normalizeBotScopedCacheBotId(botId);
    const routeKey = normalizedBotId
      ? `${this.buildChatPolicyKey(chatId, policyName)}:${normalizedBotId}`
      : this.buildChatPolicyKey(chatId, policyName);
    return `${routeKey}:${allowStaleOnError ? 'stale' : 'strict'}`;
  }

  private shouldReadLegacyCache(botId: string | null): boolean {
    return (
      this.botScopedCacheDualReadEnabled &&
      (!this.botScopedCacheEnabled || !this.normalizeBotScopedCacheBotId(botId))
    );
  }

  private buildRedisReadKeys(
    primaryCacheKey: string,
    legacyCacheKey: string,
    botId: string | null,
    policyName: MaxMembershipLookupPolicy,
  ): string[] {
    if (policyName === 'moderation_required_subscription') {
      return [primaryCacheKey];
    }
    if (primaryCacheKey === legacyCacheKey) {
      return [primaryCacheKey];
    }

    if (this.shouldReadLegacyCache(botId)) {
      return [primaryCacheKey, legacyCacheKey];
    }

    return [primaryCacheKey];
  }

  private buildRedisWriteKeys(
    primaryCacheKey: string,
    legacyCacheKey: string,
    policyName: MaxMembershipLookupPolicy,
  ): string[] {
    if (policyName === 'moderation_required_subscription') {
      return Array.from(
        new Set([primaryCacheKey, this.deriveSharedCacheKey(primaryCacheKey, policyName)]),
      );
    }
    if (primaryCacheKey === legacyCacheKey || !this.botScopedCacheDualWriteEnabled) {
      return [primaryCacheKey];
    }

    return [primaryCacheKey, legacyCacheKey];
  }

  private deriveSharedCacheKey(cacheKey: string, policyName: MaxMembershipLookupPolicy): string {
    if (policyName !== 'moderation_required_subscription') {
      return cacheKey;
    }

    const suffix = `:policy:${policyName}`;
    return cacheKey.endsWith(suffix) ? cacheKey.slice(0, -suffix.length) : cacheKey;
  }

  private buildInvalidationCacheKeys(
    chatId: string,
    userId: string,
    botId?: string | null,
  ): string[] {
    const keys = new Set<string>([this.buildLegacyCacheKey(chatId, userId)]);
    const explicitBotId = this.normalizeBotScopedCacheBotId(botId ?? null);
    for (const policyName of Object.keys(
      MEMBERSHIP_LOOKUP_POLICIES,
    ) as MaxMembershipLookupPolicy[]) {
      keys.add(this.buildCacheKey(chatId, userId, explicitBotId, policyName));
    }

    if (this.botScopedCacheEnabled) {
      for (const configuredBotId of this.resolveConfiguredBotIds()) {
        for (const policyName of Object.keys(
          MEMBERSHIP_LOOKUP_POLICIES,
        ) as MaxMembershipLookupPolicy[]) {
          keys.add(this.buildCacheKey(chatId, userId, configuredBotId, policyName));
        }
      }
    }

    return [...keys];
  }

  private normalizeBotScopedCacheBotId(botId: string | null | undefined): string | null {
    const normalized = typeof botId === 'string' ? botId.trim() : '';
    if (!normalized) {
      return null;
    }

    return this.maxBotRegistry?.getBotById(normalized)?.id ?? normalized;
  }

  private resolveConfiguredBotIds(): string[] {
    const configuredBotIds = new Set<string>();
    for (const bot of this.maxBotRegistry?.getAllBots() ?? []) {
      configuredBotIds.add(bot.id);
    }
    const defaultBotId = this.maxBotLinkService?.getDefaultBotId?.();
    if (typeof defaultBotId === 'string' && defaultBotId.trim()) {
      configuredBotIds.add(defaultBotId.trim());
    }
    return [...configuredBotIds];
  }

  private buildChatPolicyKey(chatId: string, policyName: MaxMembershipLookupPolicy): string {
    return `max:membership:chat:v1:${policyName}:${chatId}`;
  }

  private applyChatBackoff(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
  ): {
    backoffMs: number;
    backoffUntilMs: number;
  } {
    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const now = Date.now();
    const previousState = this.chatBackoffState.get(cacheKey);
    const failureCount =
      previousState && now - previousState.lastFailureAtMs <= this.chatBackoffResetMs
        ? previousState.failureCount + 1
        : 1;
    const backoffMs = Math.min(
      this.resolveMaxChatBackoffMs(policyName, policy),
      policy.backoffMs * 2 ** Math.max(0, failureCount - 1),
    );
    const backoffUntilMs = now + backoffMs;

    this.chatBackoffState.set(cacheKey, {
      failureCount,
      lastFailureAtMs: now,
    });
    this.chatBackoffUntilMs.set(cacheKey, backoffUntilMs);
    void this.runtimeDiagnosticsService?.recordMembershipBackoff({
      chatId,
      policyName,
      retryAfterMs: backoffMs,
    });

    return {
      backoffMs,
      backoffUntilMs,
    };
  }

  private clearChatBackoff(chatId: string, policyName: MaxMembershipLookupPolicy) {
    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    this.chatBackoffState.delete(cacheKey);
    this.chatBackoffUntilMs.delete(cacheKey);
  }

  private clearLookupIssue(chatId: string, policyName: MaxMembershipLookupPolicy) {
    this.lookupIssues.delete(this.buildChatPolicyKey(chatId, policyName));
  }

  private recordLookupIssue(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    error: unknown,
    options: {
      kind: MaxMembershipLookupIssueKind;
      retryAfterMs: number;
    },
  ): void {
    const now = Date.now();
    this.lookupIssues.set(this.buildChatPolicyKey(chatId, policyName), {
      chatId,
      policyName,
      kind: options.kind,
      retryAfterMs: Math.max(0, Math.ceil(options.retryAfterMs)),
      observedAtMs: now,
      expiresAtMs: now + Math.max(1_000, Math.ceil(options.retryAfterMs)),
      statusCode: this.extractStatusCode(error),
      message: error instanceof Error ? error.message : String(error),
    });
    void this.runtimeDiagnosticsService?.recordMembershipIssue({
      chatId,
      policyName,
      kind: options.kind,
      retryAfterMs: Math.max(0, Math.ceil(options.retryAfterMs)),
    });
  }

  private applyTerminalChatBackoff(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    backoffMs: number,
  ): {
    backoffMs: number;
    backoffUntilMs: number;
  } {
    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const now = Date.now();
    const backoffUntilMs = now + backoffMs;

    this.chatBackoffState.set(cacheKey, {
      failureCount: 0,
      lastFailureAtMs: now,
    });
    this.chatBackoffUntilMs.set(cacheKey, backoffUntilMs);
    void this.runtimeDiagnosticsService?.recordMembershipBackoff({
      chatId,
      policyName,
      retryAfterMs: backoffMs,
    });

    return {
      backoffMs,
      backoffUntilMs,
    };
  }

  private resolveEffectivePolicy(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
    now = Date.now(),
  ): MembershipLookupPolicyConfig {
    if (!this.isHotChannelModeActive(chatId, policyName, now)) {
      return policy;
    }

    return {
      ...policy,
      positiveFreshTtlSec: Math.max(policy.positiveFreshTtlSec, this.hotChannelPositiveFreshTtlSec),
    };
  }

  private recordHotChannelFailure(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): void {
    if (policyName !== 'moderation_required_subscription') {
      return;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const previousState = this.hotChannelStates.get(cacheKey);
    const failureCount =
      previousState && now - previousState.lastFailureAtMs <= this.hotChannelWindowMs
        ? previousState.failureCount + 1
        : 1;
    const hotUntilMs =
      failureCount >= this.hotChannelFailureThreshold
        ? Math.max(previousState?.hotUntilMs ?? 0, now + this.hotChannelDurationMs)
        : Math.max(previousState?.hotUntilMs ?? 0, 0);

    this.hotChannelStates.set(cacheKey, {
      failureCount,
      lastFailureAtMs: now,
      hotUntilMs,
    });
    if (hotUntilMs > now) {
      void this.runtimeDiagnosticsService?.recordMembershipHotChannel({
        chatId,
        policyName,
        hotDurationMs: hotUntilMs - now,
      });
    }
  }

  private clearHotChannelMode(chatId: string, policyName: MaxMembershipLookupPolicy) {
    if (policyName !== 'moderation_required_subscription') {
      return;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    this.hotChannelStates.delete(cacheKey);
  }

  private isHotChannelModeActive(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): boolean {
    if (policyName !== 'moderation_required_subscription') {
      return false;
    }

    const cacheKey = this.buildChatPolicyKey(chatId, policyName);
    const state = this.hotChannelStates.get(cacheKey);
    if (!state) {
      return false;
    }

    if (state.hotUntilMs > now) {
      return true;
    }

    if (now - state.lastFailureAtMs > this.hotChannelWindowMs) {
      this.hotChannelStates.delete(cacheKey);
    }
    return false;
  }

  private resolveMaxChatBackoffMs(
    policyName: MaxMembershipLookupPolicy,
    policy: MembershipLookupPolicyConfig,
  ): number {
    if (policyName === 'moderation_required_subscription') {
      return this.maxChatBackoffMs;
    }

    return Math.min(this.maxChatBackoffMs, Math.max(policy.backoffMs * 2, 15_000));
  }

  private resolveTerminalChatBackoffMs(policyName: MaxMembershipLookupPolicy): number {
    switch (policyName) {
      case 'moderation_required_subscription':
        return this.requiredSubscriptionTerminalChatBackoffMs;
      case 'giveaway_draw_background':
        return GIVEAWAY_DRAW_TERMINAL_CHAT_BACKOFF_MS;
      default:
        return 0;
    }
  }

  private logRedisWriteFailure(cacheKey: string, error: unknown) {
    const nowMs = Date.now();
    if (nowMs - this.lastRedisWriteFailureLogAtMs < MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastRedisWriteFailureLogAtMs = nowMs;
    this.logger.warn(
      {
        cacheKey,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to write MAX membership snapshot to Redis',
    );
  }

  private logRedisInvalidationFailure(chatId: string, userIds: readonly string[], error: unknown) {
    const nowMs = Date.now();
    if (nowMs - this.lastRedisInvalidationFailureLogAtMs < MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS) {
      return;
    }

    this.lastRedisInvalidationFailureLogAtMs = nowMs;
    this.logger.warn(
      {
        chatId,
        userIds,
        err: error instanceof Error ? error.message : String(error),
      },
      'Failed to remove invalidated MAX membership snapshots from Redis',
    );
  }

  private clearPendingSingleLookupBatchTimers() {
    for (const batch of this.pendingSingleLookupBatches.values()) {
      if (!batch.timeout) {
        continue;
      }
      clearTimeout(batch.timeout);
      batch.timeout = null;
    }
  }

  private resolveSingleLookupBatchWindowMs(
    chatId: string,
    policyName: MaxMembershipLookupPolicy,
    now = Date.now(),
  ): number {
    if (policyName !== 'moderation_required_subscription') {
      return 0;
    }

    return this.isHotChannelModeActive(chatId, policyName, now)
      ? Math.max(this.membershipLookupBatchWindowMs, this.hotChannelBatchWindowMs)
      : this.membershipLookupBatchWindowMs;
  }

  private resolveLookupTimeoutMs(trafficClass: MaxApiTrafficClass): number {
    return this.lookupTimeoutMsByTrafficClass[trafficClass];
  }

  private resolveLookupGuardTimeoutMs(trafficClass: MaxApiTrafficClass): number {
    return this.resolveLookupTimeoutMs(trafficClass) + MEMBERSHIP_LOOKUP_GUARD_SLACK_MS;
  }

  private async executeLookupWithGuard<T>(
    operation: () => Promise<T>,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      trafficClass: MaxApiTrafficClass;
    },
  ): Promise<T> {
    const startedAtMs = Date.now();
    const guardTimeoutMs = this.resolveLookupGuardTimeoutMs(context.trafficClass);
    let timeoutHandle: NodeJS.Timeout | null = null;
    let timedOut = false;

    const operationPromise = operation().catch((error: unknown) => {
      if (timedOut) {
        return Promise.reject(error);
      }
      throw error;
    });
    operationPromise.catch(() => undefined);

    const guardPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(this.createLookupTimeoutError(context, guardTimeoutMs));
      }, guardTimeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      const result = await Promise.race([operationPromise, guardPromise]);
      const durationMs = Date.now() - startedAtMs;
      if (durationMs >= MEMBERSHIP_LOOKUP_SLOW_LOG_THRESHOLD_MS) {
        this.logger.warn(
          {
            chatId: context.chatId,
            userIds: context.userIds,
            policyName: context.policyName,
            trafficClass: context.trafficClass,
            durationMs,
          },
          'Slow MAX membership lookup completed close to the hot-path deadline',
        );
      }
      return result;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private createLookupTimeoutError(
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      trafficClass: MaxApiTrafficClass;
    },
    timeoutMs: number,
  ): Error & { code: string } {
    const error = new Error(
      `MAX membership lookup guard timed out after ${timeoutMs}ms for ${context.policyName}`,
    ) as Error & { code: string };
    error.code = 'ECONNABORTED';
    return error;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractErrorMessage(error);
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    return this.extractErrorMessage(error).includes('timeout');
  }

  private isTerminalChatAccessError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return status === 403 || status === 404;
  }

  private resolveTerminalChatAccessErrorCode(error: unknown): string {
    const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    if (typeof code === 'string' && code.trim().length > 0) {
      return code.trim().toLowerCase();
    }

    return this.extractStatusCode(error) === 404 ? 'chat.not.found' : 'access.denied';
  }

  private isTransientLookupError(error: unknown): boolean {
    return this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error);
  }
}
