import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { MaxClientService, type MaxApiTrafficClass } from './max-client.service';

export type MaxMembershipLookupPolicy =
  | 'moderation_required_subscription'
  | 'giveaway_interactive'
  | 'giveaway_strict'
  | 'giveaway_draw_interactive'
  | 'giveaway_draw_background';

type MaxMembershipLookupOptions = {
  forceRefresh?: boolean;
  allowStaleOnError?: boolean;
};

type MembershipCacheSnapshot = {
  isMember: boolean;
  checkedAtMs: number;
};

type CacheEpochState = {
  epoch: number;
  expiresAtMs: number;
};

type MembershipLookupPolicyConfig = {
  positiveFreshTtlSec: number;
  negativeFreshTtlSec: number;
  backoffMs: number;
  trafficClass: MaxApiTrafficClass;
  allowStaleOnError: boolean;
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
  lookups: Map<string, PendingSingleLookup>;
  scheduled: boolean;
  timeout: NodeJS.Timeout | null;
};

const MEMBERSHIP_LOOKUP_POLICIES: Record<MaxMembershipLookupPolicy, MembershipLookupPolicyConfig> =
  {
    moderation_required_subscription: {
      positiveFreshTtlSec: 30,
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
    },
  };

const MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.positiveFreshTtlSec),
);
const MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC = Math.max(
  ...Object.values(MEMBERSHIP_LOOKUP_POLICIES).map((policy) => policy.negativeFreshTtlSec),
);
const MEMBERSHIP_INVALIDATION_CHANNEL = 'max:membership:invalidate:v1';
const MEMBERSHIP_INVALIDATION_GUARD_TTL_MS = 120_000;
const MEMBERSHIP_CACHE_WRITE_LOG_INTERVAL_MS = 10_000;

@Injectable()
export class MaxMembershipLookupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaxMembershipLookupService.name);
  private readonly redis: Redis;
  private readonly subscriber: Redis;
  private readonly membershipLookupBatchWindowMs: number;
  private readonly lookupTimeoutMsByTrafficClass: Record<MaxApiTrafficClass, number>;
  private readonly memoryCache = new Map<string, MembershipCacheSnapshot>();
  private readonly inFlight = new Map<string, Promise<boolean | null>>();
  private readonly backoffUntilMs = new Map<string, number>();
  private readonly chatBackoffUntilMs = new Map<string, number>();
  private readonly cacheEpochs = new Map<string, CacheEpochState>();
  private readonly pendingSingleLookupBatches = new Map<string, PendingSingleLookupBatch>();
  private lastRedisWriteFailureLogAtMs = 0;

  constructor(
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.subscriber = this.redis.duplicate();
    this.membershipLookupBatchWindowMs = this.readConfigInt(
      configService.get('MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS'),
      12,
      0,
    );
    this.lookupTimeoutMsByTrafficClass = {
      critical: this.readConfigInt(
        configService.get('MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL'),
        2_000,
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

    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const allowStaleOnError = options.allowStaleOnError ?? policy.allowStaleOnError;
    const chatBackoffKey = this.buildChatPolicyKey(normalizedChatId, policyName);
    const now = Date.now();
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
        const staleSnapshot = allowStaleOnError
          ? this.readRetainedMemorySnapshot(cacheKey, now)
          : null;
        results.set(userId, staleSnapshot?.isMember ?? null);
        continue;
      }

      const inFlight = this.inFlight.get(cacheKey);
      if (inFlight) {
        pendingPromises.set(userId, inFlight);
        continue;
      }

      const chatBackoffUntilMs = this.chatBackoffUntilMs.get(chatBackoffKey) ?? 0;
      if (chatBackoffUntilMs > now) {
        results.set(userId, this.resolveLookupFallback(cacheKey, allowStaleOnError));
        continue;
      }

      usersToLookup.push(userId);
    }

    if (usersToLookup.length === 1) {
      const [userId] = usersToLookup;
      pendingPromises.set(
        userId,
        this.enqueueSingleLookupBatch(normalizedChatId, userId, policyName, allowStaleOnError),
      );
    } else if (usersToLookup.length > 1) {
      const batchPromises = this.createBatchLookupPromises(
        normalizedChatId,
        usersToLookup,
        policyName,
        allowStaleOnError,
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

  private enqueueSingleLookupBatch(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
  ): Promise<boolean | null> {
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const batchKey = this.buildChatPolicyKey(chatId, policyName);
    let batch = this.pendingSingleLookupBatches.get(batchKey);
    if (!batch) {
      batch = {
        chatId,
        policy,
        policyName,
        lookups: new Map(),
        scheduled: false,
        timeout: null,
      };
      this.pendingSingleLookupBatches.set(batchKey, batch);
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
      const batchWindowMs = this.resolveSingleLookupBatchWindowMs(policyName);
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
      const accessByUserId = await this.maxClient.getChatMembersAccess(batch.chatId, userIds, {
        trafficClass: batch.policy.trafficClass,
        timeoutMs: this.resolveLookupTimeoutMs(batch.policy.trafficClass),
      });
      const checkedAtMs = Date.now();
      this.clearChatBackoff(batch.chatId, batch.policyName);

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
      if (transient) {
        const backoffUntilMs = Date.now() + batch.policy.backoffMs;
        this.chatBackoffUntilMs.set(batchKey, backoffUntilMs);
        for (const lookup of batch.lookups.values()) {
          if (this.hasSameCacheEpoch(lookup.cacheKey, lookup.cacheEpoch)) {
            this.backoffUntilMs.set(lookup.cacheKey, backoffUntilMs);
          }
        }
      }

      this.logLookupError(batch.policy, error, {
        chatId: batch.chatId,
        userIds,
        policyName: batch.policyName,
        transient,
      });

      for (const lookup of batch.lookups.values()) {
        lookup.resolve(this.resolveLookupFallback(lookup.cacheKey, lookup.allowStaleOnError));
      }
    }
  }

  private createBatchLookupPromises(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
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
        const accessByUserId = await this.maxClient.getChatMembersAccess(
          chatId,
          normalizedUserIds,
          {
            trafficClass: policy.trafficClass,
            timeoutMs: this.resolveLookupTimeoutMs(policy.trafficClass),
          },
        );
        const checkedAtMs = Date.now();
        const results = new Map<string, boolean | null>();
        this.clearChatBackoff(chatId, policyName);

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
        if (transient) {
          this.applyChatBackoff(chatId, policyName, policy.backoffMs);
          for (const userId of normalizedUserIds) {
            const cacheKey = this.buildCacheKey(chatId, userId);
            if (this.hasSameCacheEpoch(cacheKey, cacheEpochByKey.get(cacheKey) ?? 0)) {
              this.backoffUntilMs.set(cacheKey, Date.now() + policy.backoffMs);
            }
          }
        }
        this.logLookupError(policy, error, {
          chatId,
          userIds: normalizedUserIds,
          policyName,
          transient,
        });

        const results = new Map<string, boolean | null>();
        for (const userId of normalizedUserIds) {
          results.set(
            userId,
            this.resolveLookupFallback(this.buildCacheKey(chatId, userId), allowStaleOnError),
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
    policy: MembershipLookupPolicyConfig,
    error: unknown,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
      transient: boolean;
    },
  ) {
    this.logger.warn(
      {
        chatId: context.chatId,
        userIds: context.userIds,
        policyName: context.policyName,
        backoffMs: context.transient ? policy.backoffMs : 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      'Failed to resolve MAX membership',
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
    for (const userId of userIds) {
      const cacheKey = this.buildCacheKey(chatId, userId);
      this.memoryCache.delete(cacheKey);
      this.inFlight.delete(cacheKey);
      this.backoffUntilMs.delete(cacheKey);
      this.bumpCacheEpoch(cacheKey, now);
    }
  }

  private resolveLookupFallback(cacheKey: string, allowStaleOnError: boolean): boolean | null {
    if (!allowStaleOnError) {
      return null;
    }

    return this.readRetainedMemorySnapshot(cacheKey)?.isMember ?? null;
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

    const rawValues = await this.redis.mget(...normalizedCacheKeys);
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
        ? MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC
        : MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC,
    );
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
      (isMember ? MEMBERSHIP_RETENTION_POSITIVE_TTL_SEC : MEMBERSHIP_RETENTION_NEGATIVE_TTL_SEC) *
      1_000
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
    backoffMs: number,
  ) {
    this.chatBackoffUntilMs.set(
      this.buildChatPolicyKey(chatId, policyName),
      Date.now() + backoffMs,
    );
  }

  private clearChatBackoff(chatId: string, policyName: MaxMembershipLookupPolicy) {
    this.chatBackoffUntilMs.delete(this.buildChatPolicyKey(chatId, policyName));
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

  private resolveSingleLookupBatchWindowMs(policyName: MaxMembershipLookupPolicy): number {
    return policyName === 'moderation_required_subscription'
      ? this.membershipLookupBatchWindowMs
      : 0;
  }

  private resolveLookupTimeoutMs(trafficClass: MaxApiTrafficClass): number {
    return this.lookupTimeoutMsByTrafficClass[trafficClass];
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

  private isTransientLookupError(error: unknown): boolean {
    return this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error);
  }
}
