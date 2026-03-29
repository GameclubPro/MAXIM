import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
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

type MembershipLookupPolicyConfig = {
  positiveFreshTtlSec: number;
  negativeFreshTtlSec: number;
  backoffMs: number;
  trafficClass: MaxApiTrafficClass;
  allowStaleOnError: boolean;
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

@Injectable()
export class MaxMembershipLookupService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxMembershipLookupService.name);
  private readonly redis: Redis;
  private readonly memoryCache = new Map<string, MembershipCacheSnapshot>();
  private readonly inFlight = new Map<string, Promise<boolean | null>>();
  private readonly backoffUntilMs = new Map<string, number>();

  constructor(
    private readonly maxClient: MaxClientService,
    configService: ConfigService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async getMembership(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    options: MaxMembershipLookupOptions = {},
  ): Promise<boolean | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }

    const membershipByUserId = await this.getMemberships(
      chatId,
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
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    const results = new Map<string, boolean | null>();
    if (normalizedUserIds.length === 0) {
      return results;
    }

    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const allowStaleOnError = options.allowStaleOnError ?? policy.allowStaleOnError;
    const now = Date.now();
    const pendingPromises = new Map<string, Promise<boolean | null>>();
    const usersToLookup: string[] = [];

    for (const userId of normalizedUserIds) {
      const cacheKey = this.buildCacheKey(chatId, userId);
      const freshMemorySnapshot = !options.forceRefresh
        ? this.readFreshMemorySnapshot(cacheKey, policy, now)
        : null;
      if (freshMemorySnapshot) {
        results.set(userId, freshMemorySnapshot.isMember);
        continue;
      }

      if (!options.forceRefresh) {
        const redisSnapshot = await this.readRedisSnapshot(cacheKey);
        if (redisSnapshot) {
          this.memoryCache.set(cacheKey, redisSnapshot);
          if (this.isSnapshotFresh(redisSnapshot, policy, now)) {
            results.set(userId, redisSnapshot.isMember);
            continue;
          }
        }
      }

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

      usersToLookup.push(userId);
    }

    if (usersToLookup.length === 1) {
      const [userId] = usersToLookup;
      pendingPromises.set(
        userId,
        this.createSingleLookupPromise(chatId, userId, policyName, allowStaleOnError),
      );
    } else if (usersToLookup.length > 1) {
      const batchPromises = this.createBatchLookupPromises(
        chatId,
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

  private createSingleLookupPromise(
    chatId: string,
    userId: string,
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
  ): Promise<boolean | null> {
    const cacheKey = this.buildCacheKey(chatId, userId);
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const lookupPromise = (async () => {
      try {
        const isMember = await this.maxClient.hasChatMember(chatId, userId, {
          trafficClass: policy.trafficClass,
        });
        const snapshot = this.buildSnapshot(isMember);
        this.storeSnapshot(cacheKey, snapshot);
        this.backoffUntilMs.delete(cacheKey);
        return isMember;
      } catch (error: unknown) {
        this.handleLookupError(cacheKey, policy, error, {
          chatId,
          userIds: [userId],
          policyName,
        });
        return this.resolveLookupFallback(cacheKey, allowStaleOnError);
      }
    })();

    let trackedPromise!: Promise<boolean | null>;
    trackedPromise = lookupPromise.finally(() => {
      if (this.inFlight.get(cacheKey) === trackedPromise) {
        this.inFlight.delete(cacheKey);
      }
    });

    this.inFlight.set(cacheKey, trackedPromise);
    return trackedPromise;
  }

  private createBatchLookupPromises(
    chatId: string,
    userIds: readonly string[],
    policyName: MaxMembershipLookupPolicy,
    allowStaleOnError: boolean,
  ): Map<string, Promise<boolean | null>> {
    const normalizedUserIds = Array.from(new Set(userIds));
    const policy = MEMBERSHIP_LOOKUP_POLICIES[policyName];
    const batchLookupPromise = (async () => {
      try {
        const accessByUserId = await this.maxClient.getChatMembersAccess(
          chatId,
          normalizedUserIds,
          {
            trafficClass: policy.trafficClass,
          },
        );
        const checkedAtMs = Date.now();
        const results = new Map<string, boolean | null>();

        for (const userId of normalizedUserIds) {
          const isMember = accessByUserId.has(userId);
          const snapshot: MembershipCacheSnapshot = {
            isMember,
            checkedAtMs,
          };
          this.storeSnapshot(this.buildCacheKey(chatId, userId), snapshot);
          this.backoffUntilMs.delete(this.buildCacheKey(chatId, userId));
          results.set(userId, isMember);
        }

        return results;
      } catch (error: unknown) {
        const transient = this.isTransientLookupError(error);
        if (transient) {
          for (const userId of normalizedUserIds) {
            this.backoffUntilMs.set(
              this.buildCacheKey(chatId, userId),
              Date.now() + policy.backoffMs,
            );
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

  private handleLookupError(
    cacheKey: string,
    policy: MembershipLookupPolicyConfig,
    error: unknown,
    context: {
      chatId: string;
      userIds: readonly string[];
      policyName: MaxMembershipLookupPolicy;
    },
  ) {
    const transient = this.isTransientLookupError(error);
    if (transient) {
      this.backoffUntilMs.set(cacheKey, Date.now() + policy.backoffMs);
    }

    this.logLookupError(policy, error, {
      ...context,
      transient,
    });
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

  private resolveLookupFallback(cacheKey: string, allowStaleOnError: boolean): boolean | null {
    if (!allowStaleOnError) {
      return null;
    }

    return this.readRetainedMemorySnapshot(cacheKey)?.isMember ?? null;
  }

  private buildSnapshot(isMember: boolean): MembershipCacheSnapshot {
    return {
      isMember,
      checkedAtMs: Date.now(),
    };
  }

  private storeSnapshot(cacheKey: string, snapshot: MembershipCacheSnapshot) {
    this.memoryCache.set(cacheKey, snapshot);
    void this.writeRedisSnapshot(cacheKey, snapshot);
  }

  private async readRedisSnapshot(cacheKey: string): Promise<MembershipCacheSnapshot | null> {
    const raw = await this.redis.get(cacheKey);
    if (!raw) {
      return null;
    }

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
