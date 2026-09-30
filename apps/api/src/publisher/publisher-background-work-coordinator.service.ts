import { Injectable, type OnModuleDestroy } from '@nestjs/common';

export type PublisherBackgroundWorkLane =
  | 'suggestion_subscriptions'
  | 'binding_refresh'
  | 'publication_access_preflight'
  | 'chat_comment_recovery'
  | 'comment_notification_recovery'
  | 'auto_reply_recovery'
  | 'auto_reply_authoring_recovery'
  | 'publication_deadline'
  | 'publication_post_actions'
  | 'suggestion_recovery'
  | 'post_import_recovery'
  | 'start_recovery';

export class PublisherBackgroundWorkCoordinatorClosedError extends Error {
  constructor() {
    super('Publisher background work coordinator is closed');
    this.name = 'PublisherBackgroundWorkCoordinatorClosedError';
  }
}

type PublisherBackgroundWaiter = {
  lane: PublisherBackgroundWorkLane;
  queuedAt: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

const RECOVERY_AGING_MS = 15_000;

@Injectable()
export class PublisherBackgroundWorkCoordinatorService implements OnModuleDestroy {
  private activeLane: PublisherBackgroundWorkLane | null = null;
  private readonly laneRuns = new Map<PublisherBackgroundWorkLane, Promise<unknown>>();
  private readonly waiters: PublisherBackgroundWaiter[] = [];
  private closed = false;

  runExclusive<T>(lane: PublisherBackgroundWorkLane, operation: () => Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(new PublisherBackgroundWorkCoordinatorClosedError());
    }
    const existing = this.laneRuns.get(lane);
    if (existing) {
      return existing as Promise<T>;
    }

    const run = this.runQueued(lane, operation);
    this.laneRuns.set(lane, run);
    const clear = () => {
      if (this.laneRuns.get(lane) === run) {
        this.laneRuns.delete(lane);
      }
    };
    void run.then(clear, clear);
    return run;
  }

  onModuleDestroy(): void {
    this.closed = true;
    this.rejectWaiters();
  }

  private async runQueued<T>(
    lane: PublisherBackgroundWorkLane,
    operation: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(lane);
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(lane: PublisherBackgroundWorkLane): Promise<void> {
    if (this.closed) {
      throw new PublisherBackgroundWorkCoordinatorClosedError();
    }
    if (!this.activeLane) {
      this.activeLane = lane;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.waiters.push({ lane, queuedAt: Date.now(), resolve, reject });
    });
  }

  private release(): void {
    if (this.closed) {
      this.activeLane = null;
      this.rejectWaiters();
      return;
    }
    // FLAG: Keep deadline priority without starving access refresh or recovery. Service the
    // oldest recovery after 15 seconds; active work is never interrupted. Lane coalescing
    // already prevents consecutive deadline runs from overtaking the same queued recovery.
    const deadlineIndex = this.waiters.findIndex(
      (waiter) => waiter.lane === 'publication_deadline',
    );
    const recoveryIndex = this.waiters.findIndex(
      (waiter) => waiter.lane !== 'publication_deadline',
    );
    const oldestRecovery = this.waiters[recoveryIndex];
    const recoveryDue = oldestRecovery && Date.now() - oldestRecovery.queuedAt >= RECOVERY_AGING_MS;
    const next = recoveryDue
      ? this.waiters.splice(recoveryIndex, 1)[0]
      : deadlineIndex >= 0
        ? this.waiters.splice(deadlineIndex, 1)[0]
        : this.waiters.shift();
    if (next) {
      this.activeLane = next.lane;
      next.resolve();
      return;
    }
    this.activeLane = null;
  }

  private rejectWaiters(): void {
    const error = new PublisherBackgroundWorkCoordinatorClosedError();
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }
}
