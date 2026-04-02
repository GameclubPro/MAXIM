import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
} from './max-client.service';
import { MaxBotLinkService } from './max-bot-link.service';

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
};

type PendingSingleLookup = {
  cacheKey: string;
  cacheEpoch: number;
  allowStaleOnError: boolean;
  resolve: (value: boolean | null) => void;
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
      positiveFreshTtlSec: 60,
      negativeFreshTtlSec: 10,
      backoffMs: 15_000,
      trafficClass: 'critical',
      allowStaleOnError: true,
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
  private readonly lookupTimeoutMsByTrafficClass: Record<MaxApiTrafficClass, number>;
  private readonly membershipRetentionPositiveTtlSec: number;
  private readonly membershipRetentionNegativeTtlSec: number;
  private readonly memoryCache = new Map<string, MembershipCacheSnapshot>();
  private readonly inFlight = new Map<string, Promise<boolean | null>>();
  private readonly backoffUntilMs = new Map<string, number>();
  private readonly chatBackoffUntilMs = new Map<string, number>();
  private readonly chatBackoffState = new Map<string, ChatBackoffState>();
  private readonly hotChannelStates = new Map<string, HotChannelState>();
  private readonly cacheEpochs = new Map<string, CacheEpochState>();
  private readonly pendingSingleLookupBatches = new Map<string, PendingSingleLookupBatch>();
  private readonly lookupIssues = new Map<string, MaxMembershipLookupIssue>();
  private lastRedisWriteFailureLogAtMs = 0;

  constructor(
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.subscriber = this.redis.duplicate();
    this.membershipLookupBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS'),
      12,
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
      this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_DURATION_SEC'),
        120,
      ) * 1_000;
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

    const cacheKeys = normalizedUserIds.map((userId) =>
      this.buildCacheKey(normalizedChatId, userId),
    );
    await Promise.all([
      this.redis.del(...cacheKeys),
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
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return null;
    }

    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }

    const membershipByUserId = await this.getMemberships(
      normalizedChatId,
      [normalizedUserId],
      policyName,
      options,
    );
    return membershipByUserId.get(normalizedUserId) ?? null;
  }

  async getMemberships(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<Map<string, boolean | null>> {
    const normalizedChatId = chatId.trim();
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    const results = new Map<string, boolean | null>();
    if (!normalizedChatId || normalizedUserIds.length === 0) {
      return results;
    }

    const now = Date.now();
    const basePolicy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const policy = this.resolveEffectivePolicy(normalizedChatId, policyName, basePolicy, now);
    const allowStaleOnError = options.allowStaleOnError ?? policy.allowStaleOnError;
    const chatBackoffKey = this.buildChatPolicyKey(normalizedChatId, policyName);
    const pendingPromises = new Map<string, Promise<boolean | null>>();
    const usersToLookup: string[] = [];
    const cacheKeyByUserId = new Map(
      normalizedUserIds.map((userId) => [userId, this.buildCacheKey(normalizedChatId, userId)]),
    );
    let unresolvedUserIds: string[] = [];

    for (const userId of normalizedUserIds) {
      const cacheKey = cacheKeyByUserId.get(userId)!;
      const freshMemorySnapshot = !options.forceRefresh
        ? this.readFreshMemorySnapshot(cacheKey, policy, now)
        : null;
      if (freshMemorySnapshot) {
        results.set(userId, freshMemorySnapshot.isMember);
        continue;
      }

      unresolvedUserIds.push(userId);
    }

    if (!options.forceRefresh && unresolvedUserIds.length > 0) {
      const redisSnapshots = await this.readRedisSnapshots(
        unresolvedUserIds.map((userId) => cacheKeyByUserId.get(userId)!),
      );
      const stillUnresolvedUserIds: string[] = [];

      for (const userId of unresolvedUserIds) {
        const cacheKey = cacheKeyByUserId.get(userId)!;
        const redisSnapshot = redisSnapshots.get(cacheKey) ?? null;
        if (redisSnapshot) {
          this.memoryCache.set(cacheKey, redisSnapshot);
          if (this.isSnapshotFresh(redisSnapshot, policy, now)) {
            results.set(userId, redisSnapshot.isMember);
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
        results.set(
          userId,
          this.resolveLookupFallback(
            normalizedChatId,
            policyName,
            cacheKey,
            allowStaleOnError,
            now,
          ),
        );
        continue;
      }

      const inFlight = this.inFlight.get(cacheKey);
      if (inFlight) {
        pendingPromises.set(userId, inFlight);
        continue;
      }

      const chatBackoffUntilMs = this.chatBackoffUntilMs.get(chatBackoffKey) ?? 0;
      if (chatBackoffUntilMs > now) {
        results.set(
          userId,
          this.resolveLookupFallback(
            normalizedChatId,
            policyName,
            cacheKey,
            allowStaleOnError,
            now,
          ),
        );
        continue;
      }

      usersToLookup.push(userId);
    }

    let lookupBotId: string | null = null;
    if (usersToLookup.length > 0) {
      const requestedBotId =
        typeof options.botId === 'string' ? options.botId.trim() : '';
      if (requestedBotId) {
        lookupBotId = requestedBotId;
      } else if (this.maxBotLinkService) {
        lookupBotId = await this.resolveLookupBotId(normalizedChatId);
      }
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
      results.set(userId, promise ? await promise : null);
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
  ): Promise<boolean | null> {
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const batchKey = this.buildChatPolicyKey(chatId, policyName);
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

    const cacheKey = this.buildCacheKey(chatId, userId);
    const cacheEpoch = this.readCacheEpoch(cacheKey);
    const lookupPromise = new Promise<boolean | null>((resolve) => {
      batch!.lookups.set(userId, {
        cacheKey,
        cacheEpoch,
        allowStaleOnError,
        resolve,
      });
    });

    let trackedPromise!: Promise<boolean | null>;
    trackedPromise = lookupPromise.finally(() => {
      if (this.inFlight.get(cacheKey) === trackedPromise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, trackedPromise);

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

    try {
      const accessByUserId = await this.executeLookupWithGuard(
        async () =>
          this.maxClient.getChatMembersAccess(batch.chatId, userIds, {
            trafficClass: batch.policy.trafficClass,
            timeoutMs: this.resolveLookupTimeoutMs(batch.policy.trafficClass),
            ...(batch.policy.sourceTag ? { sourceTag: batch.policy.sourceTag } : {}),
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
      this.clearChatBackoff(batch.chatId, batch.policyName);
      this.clearHotChannelMode(batch.chatId, batch.policyName);
      this.clearLookupIssue(batch.chatId, batch.policyName);

      for (const [userId, lookup] of batch.lookups.entries()) {
        const isMember = accessByUserId.has(userId);
        const snapshot: MembershipCacheSnapshot = {
          isMember,
          checkedAtMs,
        };
        if (this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
          this.storeSnapshot(lookup.cacheKey, snapshot);
          this.backoffUntilMs.delete(lookup.cacheKey);
        }
        lookup.resolve(isMember);
      }
    } catch (error: unknown) {
      const transient = this.isTransientLookupError(error);
      const terminalBackoffMs = this.resolveTerminalChatBackoffMs(batch.policyName);
      const terminal = terminalBackoffMs > 0 && this.isTerminalChatAccessError(error);
      let appliedBackoffMs = 0;
      if (terminal) {
        const appliedBackoff = this.applyTerminalChatBackoff(
          batch.chatId,
          batch.policyName,
          terminalBackoffMs,
        );
        appliedBackoffMs = appliedBackoff.backoffMs;
      } else if (transient) {
        const appliedBackoff = this.applyChatBackoff(batch.chatId, batch.policyName, batch.policy);
        appliedBackoffMs = appliedBackoff.backoffMs;
        this.recordHotChannelFailure(batch.chatId, batch.policyName);
        for (const lookup of batch.lookups.values()) {
          if (this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
            this.backoffUntilMs.set(lookup.cacheKey, appliedBackoff.backoffUntilMs);
          }
        }
      }

      if (terminal || transient) {
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
        lookup.resolve(
          this.resolveLookupFallback(
            batch.chatId,
            batch.policyName,
            lookup.cacheKey,
            lookup.allowStaleOnError,
          ),
        );
      }
    }
  }

  private createBatchLookupPromises(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
    botId: string | null,
  ): Map<string, Promise<boolean | null>> {
    const normalizedUserIds = Array.from(new Set(userIds));
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const cacheEpochByKey = new Map(
      normalizedUserIds.map((userId) => {
        const cacheKey = this.buildCacheKey(chatId, userId);
        return [cacheKey, this.readCacheEpoch(cacheKey)] as const;
      }),
    );
    const batchLookupPromise = (async () => {
      try {
        const accessByUserId = await this.executeLookupWithGuard(
          async () =>
            this.maxClient.getChatMembersAccess(
              chatId,
              normalizedUserIds,
              {
                trafficClass: policy.trafficClass,
                timeoutMs: this.resolveLookupTimeoutMs(policy.trafficClass),
                ...(policy.sourceTag ? { sourceTag: policy.sourceTag } : {}),
                ...(botId ? { botId } : {}),
              },
            ),
          {
            chatId,
            userIds: normalizedUserIds,
            policyName,
            trafficClass: policy.trafficClass,
          },
        );
        const checkedAtMs = Date.now();
        const results = new Map<string, boolean | null>();
        this.clearChatBackoff(chatId, policyName);
        this.clearHotChannelMode(chatId, policyName);
        this.clearLookupIssue(chatId, policyName);

        for (const userId of normalizedUserIds) {
          const cacheKey = this.buildCacheKey(chatId, userId);
          const isMember = accessByUserId.has(userId);
          const snapshot: MembershipCacheSnapshot = {
            isMember,
            checkedAtMs,
          };
          if (this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
            this.storeSnapshot(cacheKey, snapshot);
            this.backoffUntilMs.delete(cacheKey);
          }
          results.set(userId, isMember);
        }

        return results;
      } catch (error: unknown) {
        const transient = this.isTransientLookupError(error);
        const terminalBackoffMs = this.resolveTerminalChatBackoffMs(policyName);
        const terminal = terminalBackoffMs > 0 && this.isTerminalChatAccessError(error);
        let appliedBackoffMs = 0;
        if (terminal) {
          const appliedBackoff = this.applyTerminalChatBackoff(
            chatId,
            policyName,
            terminalBackoffMs,
          );
          appliedBackoffMs = appliedBackoff.backoffMs;
        } else if (transient) {
          const appliedBackoff = this.applyChatBackoff(chatId, policyName, policy);
          appliedBackoffMs = appliedBackoff.backoffMs;
          this.recordHotChannelFailure(chatId, policyName);
          for (const userId of normalizedUserIds) {
            const cacheKey = this.buildCacheKey(chatId, userId);
            if (this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
              this.backoffUntilMs.set(cacheKey, appliedBackoff.backoffUntilMs);
            }
          }
        }
        if (terminal || transient) {
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

        const results = new Map<string, boolean | null>();
        for (const userId of normalizedUserIds) {
          results.set(
            userId,
            this.resolveLookupFallback(
              chatId,
              policyName,
              this.buildCacheKey(chatId, userId),
              allowStaleOnError,
            ),
          );
        }
        return results;
      }
    })();

    const promises = new Map<string, Promise<boolean | null>>();
    for (const userId of normalizedUserIds) {
      const cacheKey = this.buildCacheKey(chatId, userId);
      let trackedPromise!: Promise<boolean | null>;
      trackedPromise = batchLookupPromise
        .then((results) => results.get(userId) ?? null)
        .finally(() => {
          if (this.inFlight.get(cacheKey) === trackedPromise) {
            this.inFlight.delete(cacheKey);
          }
        });
      this.inFlight.set(cacheKey, trackedPromise);
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

  private async resolveLookupBotId(
    chatId: string,
  ): Promise<string | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    return (
      await this.maxBotLinkService.resolveBotId({
        chatId,
      })
    ) ?? null;
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
    for (const userId of userIds) {
      const cacheKey = this.buildCacheKey(chatId, userId);
      this.memoryCache.delete(cacheKey);
      this.inFlight.delete(cacheKey);
      this.backoffUntilMs.delete(cacheKey);
      this.bumpCacheEpoch(cacheKey, now);
    }
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

  private storeSnapshot(cacheKey: string, snapshot: MembershipCacheSnapshot) {
    this.memoryCache.set(cacheKey, snapshot);
    void this.writeRedisSnapshot(cacheKey, snapshot).catch((error: unknown) => {
      this.logRedisWriteFailure(cacheKey, error);
    });
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

  private bumpCacheEpoch(cacheKey: string, now = Date.now()): number {
    const nextEpoch = this.readCacheEpoch(cacheKey, now) + 1;
    this.cacheEpochs.set(cacheKey, {
      epoch: nextEpoch,
      expiresAtMs: now + MEMBERSHIP_INVALIDATION_GUARD_TTL_MS,
    });
    return nextEpoch;
  }

  private async readRedisSnapshot(cacheKey: string): Promise<MembershipCacheSnapshot | null> {
    const snapshots = await this.readRedisSnapshots([cacheKey]);
    return snapshots.get(cacheKey) ?? null;
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
      this.redis
        .mget(...normalizedCacheKeys)
        .catch(() => normalizedCacheKeys.map(() => null)),
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
    snapshot: MembershipCacheSnapshot,
  ): Promise<void> {
    await this.redis.set(
      cacheKey,
      JSON.stringify(snapshot),
      'EX',
      snapshot.isMember
        ? this.membershipRetentionPositiveTtlSec
        : this.membershipRetentionNegativeTtlSec,
    );
  }

  private async runRedisReadWithin<T>(
    operation: Promise<T>,
    maxWaitMs: number,
  ): Promise<T | null> {
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
      (isMember
        ? this.membershipRetentionPositiveTtlSec
        : this.membershipRetentionNegativeTtlSec) * 1_000
    );
  }

  private buildCacheKey(chatId: string, userId: string): string {
    return `max:membership:v1:${chatId}:${userId}`;
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
    return message.includes('rate limit exceeded') || message.includes('circuit breaker');
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

  private isTransientLookupError(error: unknown): boolean {
    return this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error);
  }
}
