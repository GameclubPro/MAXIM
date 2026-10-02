import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';

type WorkClass = 'ordinary' | 'interactive' | 'lifecycle';
const DURATION_BOUNDS_MS = [5, 25, 100, 1_000, 5_000, 15_000, 30_000];

export class WebhookPreparationAdmission {
  readonly maxInFlight: number;
  private readonly byBot = new Map<string, Record<WorkClass, number>>();
  private readonly active = new Set<Promise<void>>();
  private readonly byClass = { ordinary: 0, interactive: 0, lifecycle: 0 };
  private closed = false;
  private reserveLifecycleUntil = 0;
  private windowStartedAt = Date.now();
  private metrics = this.emptyMetrics();

  constructor(
    poolMax: number,
    private readonly report: (metric: Record<string, unknown>) => void,
  ) {
    if (!Number.isSafeInteger(poolMax) || poolMax < 1)
      throw new Error('Invalid webhook preparation pool budget');
    this.maxInFlight = Math.max(1, Math.min(8, Math.floor(poolMax / 2)));
  }

  run<T>(botId: string, workClass: WorkClass, task: () => Promise<T>): Promise<T> {
    // FLAG: No waiting promises are retained on overload. The existing receipt/outbox
    // remains the queue, with a typed non-exhausting retry instead of RAM-only work.
    const botCounts = this.byBot.get(botId) ?? { ordinary: 0, interactive: 0, lifecycle: 0 };
    const botActive = botCounts[workClass];
    const reserved =
      workClass !== 'lifecycle' &&
      this.maxInFlight > 1 &&
      this.reserveLifecycleUntil > Date.now() &&
      this.active.size >= this.maxInFlight - 1;
    const limited =
      this.closed ||
      this.active.size >= this.maxInFlight ||
      reserved ||
      botActive >= Math.max(1, Math.floor(this.maxInFlight / 2)) ||
      (workClass === 'interactive' && this.byClass.interactive >= 1);
    if (limited) {
      if (workClass === 'lifecycle') this.reserveLifecycleUntil = Date.now() + 5_000;
      this.metrics.deferred[workClass] += 1;
      this.flushIfDue();
      return Promise.reject(
        new WebhookPreparationDeferredError('Webhook preparation capacity unavailable', 1_000),
      );
    }
    botCounts[workClass] += 1;
    this.byBot.set(botId, botCounts);
    this.byClass[workClass] += 1;
    const startedAt = performance.now();
    const finish = () => {
      this.active.delete(tracked);
      botCounts[workClass] -= 1;
      if (Object.values(botCounts).every((count) => count === 0)) this.byBot.delete(botId);
      this.byClass[workClass] -= 1;
      const duration = Math.max(0, performance.now() - startedAt);
      const bucket = DURATION_BOUNDS_MS.findIndex((limit) => duration <= limit);
      this.metrics.durationHistogram[bucket < 0 ? DURATION_BOUNDS_MS.length : bucket] += 1;
      this.flushIfDue();
    };
    const operation = Promise.resolve()
      .then(task)
      .then(
        (value) => {
          finish();
          return value;
        },
        (error: unknown) => {
          finish();
          throw error;
        },
      );
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(tracked);
    this.metrics.peakInFlight = Math.max(this.metrics.peakInFlight, this.active.size);
    this.metrics.admitted[workClass] += 1;
    return operation;
  }

  stop(): void {
    this.closed = true;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
  snapshot() {
    return { inFlight: this.active.size, pending: 0, botScopes: this.byBot.size, ...this.byClass };
  }

  flush(): void {
    try {
      this.report({
        metric: 'webhook_preparation_admission_v1',
        ...this.metrics,
        ...this.snapshot(),
        maxInFlight: this.maxInFlight,
        durationUpperBoundsMs: [...DURATION_BOUNDS_MS, null],
        windowMs: Date.now() - this.windowStartedAt,
      });
    } catch {
      /* FLAG: Metrics do not change durable preparation outcomes. */
    }
    this.metrics = this.emptyMetrics();
    this.windowStartedAt = Date.now();
  }
  private flushIfDue(): void {
    if (Date.now() - this.windowStartedAt >= 60_000) this.flush();
  }
  private emptyMetrics() {
    return {
      admitted: { ordinary: 0, interactive: 0, lifecycle: 0 },
      deferred: { ordinary: 0, interactive: 0, lifecycle: 0 },
      peakInFlight: 0,
      durationHistogram: Array<number>(DURATION_BOUNDS_MS.length + 1).fill(0),
    };
  }
}
