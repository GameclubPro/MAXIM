import { Injectable, Logger, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { RedisCounterService } from './redis-counter.service';

export const MODERATION_SANCTION_STATE_LOCK_TTL_MS = 60_000;
export const MODERATION_SANCTION_STATE_LOCK_WAIT_TIMEOUT_MS = 1_000;

const MODERATION_SANCTION_STATE_LOCK_RETRY_DELAY_MS = 25;
const MODERATION_SANCTION_STATE_LOCK_HEARTBEAT_MS = Math.trunc(
  MODERATION_SANCTION_STATE_LOCK_TTL_MS / 3,
);
const MODERATION_SANCTION_STATE_LOCK_HEARTBEAT_RETRY_MS = 1_000;
const MODERATION_SANCTION_STATE_LOCK_KEY_PREFIX = 'moderation-sanction-state:v1:';

export type ModerationSanctionStateLockSubject = {
  chatId: string;
  userId: string;
};

export type ModerationSanctionStateLockOptions = {
  waitTimeoutMs?: number;
};

export interface ModerationSanctionStateLeaseGuard {
  assertOwned(): Promise<void>;
}

export type ModerationSanctionStateChangedDetails = {
  subject?: ModerationSanctionStateLockSubject;
  expectedSanctionEventId?: string;
};

export class ModerationSanctionStateChangedError extends Error {
  readonly code = 'moderation_sanction_state_changed' as const;
  readonly subject?: ModerationSanctionStateLockSubject;
  readonly expectedSanctionEventId?: string;

  constructor(details: ModerationSanctionStateChangedDetails = {}, options?: ErrorOptions) {
    super('Moderation sanction state changed', options);
    this.name = ModerationSanctionStateChangedError.name;
    this.subject = details.subject;
    this.expectedSanctionEventId = details.expectedSanctionEventId;
  }
}

export abstract class ModerationSanctionStateLockError extends Error {
  abstract readonly code:
    | 'moderation_sanction_state_lock_busy'
    | 'moderation_sanction_state_lock_unavailable'
    | 'moderation_sanction_state_lock_lease_lost';

  protected constructor(
    message: string,
    readonly subject: ModerationSanctionStateLockSubject,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ModerationSanctionStateLockBusyError extends ModerationSanctionStateLockError {
  readonly code = 'moderation_sanction_state_lock_busy' as const;

  constructor(subject: ModerationSanctionStateLockSubject) {
    super('Moderation sanction state is busy', subject);
    this.name = ModerationSanctionStateLockBusyError.name;
  }
}

export class ModerationSanctionStateLockUnavailableError extends ModerationSanctionStateLockError {
  readonly code = 'moderation_sanction_state_lock_unavailable' as const;

  constructor(subject: ModerationSanctionStateLockSubject, options?: ErrorOptions) {
    super('Moderation sanction state lock is unavailable', subject, options);
    this.name = ModerationSanctionStateLockUnavailableError.name;
  }
}

export class ModerationSanctionStateLockLeaseLostError extends ModerationSanctionStateLockError {
  readonly code = 'moderation_sanction_state_lock_lease_lost' as const;

  constructor(subject: ModerationSanctionStateLockSubject, options?: ErrorOptions) {
    super('Moderation sanction state lock lease was lost', subject, options);
    this.name = ModerationSanctionStateLockLeaseLostError.name;
  }
}

type RedisLockApi = {
  acquireLockBeforeDeadline: RedisCounterService['acquireLockBeforeDeadline'];
  renewLock: RedisCounterService['renewLock'];
  releaseLock: RedisCounterService['releaseLock'];
};

type LockLease = {
  key: string;
  token: string;
  conservativeExpiresAtMs: number;
};

type Heartbeat = {
  guard: ModerationSanctionStateLeaseGuard;
  stop: () => Promise<ModerationSanctionStateLockLeaseLostError | null>;
};

const testMemoryLocks = new Map<string, string>();

@Injectable()
export class ModerationSanctionStateLockService {
  private readonly logger = new Logger(ModerationSanctionStateLockService.name);

  constructor(@Optional() private readonly redisCounter?: RedisCounterService) {}

  async runExclusive<T>(
    subjectInput: ModerationSanctionStateLockSubject,
    operation: (guard: ModerationSanctionStateLeaseGuard) => Promise<T> | T,
    options: ModerationSanctionStateLockOptions = {},
  ): Promise<T> {
    const subject = this.normalizeSubject(subjectInput);
    const key = this.buildKey(subject);
    const waitTimeoutMs = this.normalizeWaitTimeoutMs(options.waitTimeoutMs);
    const redis = this.resolveRedisLockApi();

    if (!redis) {
      if (process.env.NODE_ENV === 'test') {
        return this.runWithTestMemoryLock(subject, key, waitTimeoutMs, operation);
      }
      throw new ModerationSanctionStateLockUnavailableError(subject);
    }

    const lease = await this.acquireRedisLock(subject, key, waitTimeoutMs, redis);
    const heartbeat = this.startHeartbeat(subject, lease, redis);
    let operationFailed = false;
    let operationError: unknown;
    let result!: T;

    try {
      result = await operation(heartbeat.guard);
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }

    const leaseLostError = await heartbeat.stop();
    try {
      await redis.releaseLock(lease.key, lease.token);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: subject.chatId,
          userId: subject.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to release moderation sanction state lock; waiting for lease expiry',
      );
    }

    if (operationFailed) {
      throw operationError;
    }
    if (leaseLostError) {
      throw leaseLostError;
    }
    return result;
  }

  private normalizeSubject(
    subject: ModerationSanctionStateLockSubject,
  ): ModerationSanctionStateLockSubject {
    const chatId = subject.chatId.trim();
    const userId = subject.userId.trim();
    if (!chatId || !userId) {
      throw new TypeError('Moderation sanction state lock requires chatId and userId');
    }
    return { chatId, userId };
  }

  private normalizeWaitTimeoutMs(value: number | undefined): number {
    if (value === undefined) {
      return MODERATION_SANCTION_STATE_LOCK_WAIT_TIMEOUT_MS;
    }
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('Moderation sanction state lock wait timeout must be non-negative');
    }
    return Math.trunc(value);
  }

  private buildKey(subject: ModerationSanctionStateLockSubject): string {
    const digest = createHash('sha256')
      .update(subject.chatId)
      .update('\u0000')
      .update(subject.userId)
      .digest('hex');
    return `${MODERATION_SANCTION_STATE_LOCK_KEY_PREFIX}${digest}`;
  }

  private resolveRedisLockApi(): RedisLockApi | null {
    const redis = this.redisCounter as Partial<RedisCounterService> | undefined;
    if (
      !redis ||
      typeof redis.acquireLockBeforeDeadline !== 'function' ||
      typeof redis.renewLock !== 'function' ||
      typeof redis.releaseLock !== 'function'
    ) {
      return null;
    }
    return {
      acquireLockBeforeDeadline: redis.acquireLockBeforeDeadline.bind(redis),
      renewLock: redis.renewLock.bind(redis),
      releaseLock: redis.releaseLock.bind(redis),
    };
  }

  private async acquireRedisLock(
    subject: ModerationSanctionStateLockSubject,
    key: string,
    waitTimeoutMs: number,
    redis: RedisLockApi,
  ): Promise<LockLease> {
    const token = randomUUID();
    const deadlineAtMs = Date.now() + Math.max(1, waitTimeoutMs);

    while (true) {
      let acquisition: Awaited<ReturnType<RedisLockApi['acquireLockBeforeDeadline']>>;
      const acquisitionStartedAtMs = Date.now();
      try {
        acquisition = await redis.acquireLockBeforeDeadline(
          key,
          token,
          MODERATION_SANCTION_STATE_LOCK_TTL_MS,
          deadlineAtMs,
        );
      } catch (error: unknown) {
        throw new ModerationSanctionStateLockUnavailableError(subject, { cause: error });
      }

      if (acquisition.kind === 'acquired') {
        return {
          key,
          token,
          conservativeExpiresAtMs: acquisitionStartedAtMs + MODERATION_SANCTION_STATE_LOCK_TTL_MS,
        };
      }
      if (acquisition.kind === 'deadline_exceeded' || Date.now() >= deadlineAtMs) {
        throw new ModerationSanctionStateLockBusyError(subject);
      }

      await this.wait(
        Math.min(MODERATION_SANCTION_STATE_LOCK_RETRY_DELAY_MS, deadlineAtMs - Date.now()),
      );
    }
  }

  private startHeartbeat(
    subject: ModerationSanctionStateLockSubject,
    lease: LockLease,
    redis: RedisLockApi,
  ): Heartbeat {
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let renewal: Promise<void> | null = null;
    let leaseLostError: ModerationSanctionStateLockLeaseLostError | null = null;
    let lastHeartbeatTransportError: unknown;

    const markLeaseLost = (cause?: unknown) => {
      leaseLostError ??= new ModerationSanctionStateLockLeaseLostError(
        subject,
        cause === undefined ? undefined : { cause },
      );
      return leaseLostError;
    };

    const recordSuccessfulRenewal = (renewalStartedAtMs: number): boolean => {
      const renewedUntilMs = renewalStartedAtMs + MODERATION_SANCTION_STATE_LOCK_TTL_MS;
      if (Date.now() >= renewedUntilMs) {
        markLeaseLost();
        return false;
      }
      lease.conservativeExpiresAtMs = Math.max(lease.conservativeExpiresAtMs, renewedUntilMs);
      lastHeartbeatTransportError = undefined;
      return true;
    };

    const assertNotExpired = (): void => {
      if (leaseLostError) {
        throw leaseLostError;
      }
      if (Date.now() >= lease.conservativeExpiresAtMs) {
        throw markLeaseLost(lastHeartbeatTransportError);
      }
    };

    const schedule = (requestedDelayMs: number) => {
      if (stopped || leaseLostError) {
        return;
      }
      const remainingLeaseMs = lease.conservativeExpiresAtMs - Date.now();
      if (remainingLeaseMs <= 0) {
        markLeaseLost(lastHeartbeatTransportError);
        return;
      }
      timer = setTimeout(
        () => {
          timer = null;
          if (stopped || leaseLostError) {
            return;
          }
          renewal = (async () => {
            if (Date.now() >= lease.conservativeExpiresAtMs) {
              markLeaseLost(lastHeartbeatTransportError);
              return;
            }

            const renewalStartedAtMs = Date.now();
            try {
              const renewed = await redis.renewLock(
                lease.key,
                lease.token,
                MODERATION_SANCTION_STATE_LOCK_TTL_MS,
              );
              if (!renewed) {
                markLeaseLost();
                return;
              }
              if (recordSuccessfulRenewal(renewalStartedAtMs)) {
                schedule(MODERATION_SANCTION_STATE_LOCK_HEARTBEAT_MS);
              }
            } catch (error: unknown) {
              lastHeartbeatTransportError = error;
              if (Date.now() >= lease.conservativeExpiresAtMs) {
                markLeaseLost(error);
                return;
              }
              schedule(MODERATION_SANCTION_STATE_LOCK_HEARTBEAT_RETRY_MS);
            }
          })().finally(() => {
            renewal = null;
          });
        },
        Math.max(1, Math.min(requestedDelayMs, remainingLeaseMs)),
      );
      timer.unref?.();
    };

    schedule(MODERATION_SANCTION_STATE_LOCK_HEARTBEAT_MS);
    return {
      guard: {
        assertOwned: async () => {
          assertNotExpired();
          const renewalStartedAtMs = Date.now();
          let renewed: boolean;
          try {
            renewed = await redis.renewLock(
              lease.key,
              lease.token,
              MODERATION_SANCTION_STATE_LOCK_TTL_MS,
            );
          } catch (error: unknown) {
            throw new ModerationSanctionStateLockUnavailableError(subject, { cause: error });
          }
          if (!renewed) {
            throw markLeaseLost();
          }
          if (!recordSuccessfulRenewal(renewalStartedAtMs)) {
            throw leaseLostError;
          }
          assertNotExpired();
        },
      },
      stop: async () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await renewal;
        if (!leaseLostError && Date.now() >= lease.conservativeExpiresAtMs) {
          markLeaseLost(lastHeartbeatTransportError);
        }
        return leaseLostError;
      },
    };
  }

  private async runWithTestMemoryLock<T>(
    subject: ModerationSanctionStateLockSubject,
    key: string,
    waitTimeoutMs: number,
    operation: (guard: ModerationSanctionStateLeaseGuard) => Promise<T> | T,
  ): Promise<T> {
    const token = randomUUID();
    const deadlineAtMs = Date.now() + waitTimeoutMs;

    while (testMemoryLocks.has(key)) {
      if (Date.now() >= deadlineAtMs) {
        throw new ModerationSanctionStateLockBusyError(subject);
      }
      await this.wait(
        Math.min(MODERATION_SANCTION_STATE_LOCK_RETRY_DELAY_MS, deadlineAtMs - Date.now()),
      );
    }

    testMemoryLocks.set(key, token);
    try {
      return await operation({
        assertOwned: async () => {
          if (testMemoryLocks.get(key) !== token) {
            throw new ModerationSanctionStateLockLeaseLostError(subject);
          }
        },
      });
    } finally {
      if (testMemoryLocks.get(key) === token) {
        testMemoryLocks.delete(key);
      }
    }
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(1, delayMs)));
  }
}
