import { Injectable, type OnModuleDestroy } from '@nestjs/common';

export type PublisherBackgroundWorkLane =
  | 'binding_refresh'
  | 'chat_comment_recovery'
  | 'publication_deadline'
  | 'suggestion_recovery';

export class PublisherBackgroundWorkCoordinatorClosedError extends Error {
  constructor() {
    super('Publisher background work coordinator is closed');
    this.name = 'PublisherBackgroundWorkCoordinatorClosedError';
  }
}

type PublisherBackgroundWaiter = {
  lane: PublisherBackgroundWorkLane;
  resolve: () => void;
  reject: (error: Error) => void;
};

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
      this.waiters.push({ lane, resolve, reject });
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
