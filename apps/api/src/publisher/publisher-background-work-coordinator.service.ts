import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

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

@Injectable()
export class PublisherBackgroundWorkCoordinatorService implements OnModuleDestroy {
  private activeLane: PublisherBackgroundWorkLane | null = null;
  private readonly laneRuns = new Map<PublisherBackgroundWorkLane, Promise<unknown>>();
  private readonly waiters: PublisherBackgroundWaiter[] = [];
  private closed = false;
  private readonly logger = new Logger(PublisherBackgroundWorkCoordinatorService.name);

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
    // FLAG: Deadline and access nomination each have one coalesced slot, independent
    // of the single recovery slot. The shared MAX limiter and durable claims still
    // govern effects; an in-flight recovery mutation is never interrupted.
    const isolated = lane === 'publication_deadline' || lane === 'publication_access_preflight';
    const queuedAt = Date.now();
    if (!isolated) await this.acquire(lane);
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      if (!isolated) this.release();
      const runMs = Date.now() - startedAt;
      const waitMs = startedAt - queuedAt;
      if (runMs > 5_000 || waitMs > 5_000)
        this.logger.warn(
          { metric: 'publisher_background_budget_v1', lane, runMs, waitMs },
          'Publisher background work exceeded its time budget',
        );
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
    const next = this.waiters.shift();
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
