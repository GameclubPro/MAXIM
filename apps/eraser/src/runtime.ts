import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import type { Config } from './config.js';
import { MaxError, type MaxTransport } from './max.js';
import { Store, CHAT_BUFFER, HOUSEKEEPING_INTERVAL_MS } from './store.js';
import { ServiceError, type Lane } from './types.js';

export const MAX_WAKEUPS = 64;
export type Wakeup = { chatId: string; leaseToken: string };
export class CleanupRuntime {
  private queue: Queue<Wakeup, void, 'visit'> | null = null;
  private worker: Worker<Wakeup, void, 'visit'> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private lastMaintenance = Date.now();
  private lastSchedulerAt: number | null = null;
  constructor(
    private readonly store: Store,
    private readonly max: MaxTransport,
    private readonly config: Pick<Config, 'redisUrl' | 'enabled'>,
    private readonly prefix = 'eraser',
  ) {}
  async start(): Promise<void> {
    if (!this.config.enabled) return;
    this.queue = new Queue<Wakeup, void, 'visit'>('cleanup', {
      connection: { url: this.config.redisUrl, maxRetriesPerRequest: 1 },
      prefix: this.prefix,
    });
    await this.queue.setGlobalConcurrency(8);
    this.worker = new Worker<Wakeup, void, 'visit'>(
      'cleanup',
      async (job: Job<Wakeup>) => this.visit(job.data),
      {
        connection: { url: this.config.redisUrl, maxRetriesPerRequest: null },
        prefix: this.prefix,
        concurrency: 8,
        lockDuration: 60_000,
      },
    );
    this.worker.on('error', () => {
      /* FLAG: Health exposes the stale scheduler; no credentials or message bodies in logs. */
    });
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
  }
  async tick(): Promise<void> {
    if (this.running || this.stopping || !this.queue) return;
    this.running = true;
    try {
      // FLAG: Fixed slot IDs bound queued work across scheduler replicas, not just one process.
      const slots = await Promise.all(
        Array.from({ length: MAX_WAKEUPS }, async (_, index) => ({
          id: `slot-${index}`,
          occupied: Boolean(await this.queue!.getJob(`slot-${index}`)),
        })),
      );
      const available = slots.filter((slot) => !slot.occupied);
      if (available.length) {
        const reserved = await this.store.reserve(available.length);
        for (const [index, wakeup] of reserved.entries()) {
          const jobId = available[index]!.id;
          try {
            await this.queue.add('visit', wakeup, {
              jobId,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 1,
            });
            const persisted = await this.queue.getJob(jobId);
            if (persisted && persisted.data.leaseToken !== wakeup.leaseToken)
              await this.store.finishVisit(wakeup.chatId, wakeup.leaseToken, null, 1000);
          } catch {
            await this.store.finishVisit(
              wakeup.chatId,
              wakeup.leaseToken,
              'queue_unavailable',
              5000,
            );
          }
        }
      }
      if (Date.now() - this.lastMaintenance >= HOUSEKEEPING_INTERVAL_MS) {
        await this.store.housekeeping();
        this.lastMaintenance = Date.now();
      }
      this.lastSchedulerAt = Date.now();
    } finally {
      this.running = false;
    }
  }
  async visit(wakeup: Wakeup): Promise<void> {
    const { chatId, leaseToken } = wakeup;
    let error: string | null = null,
      wait = 1000;
    try {
      let policy = await this.store.active(chatId, leaseToken);
      if (!policy || this.stopping || !this.config.enabled) return;
      const reconcile = await this.store.reconciliation(chatId);
      if (reconcile) {
        const presence = await this.max.presence(chatId, reconcile.message_id);
        if (presence === 'absent')
          await this.store.settle(reconcile, 'deleted', 'confirmed_absence');
        else await this.store.settle(reconcile, 'uncertain', 'reconciliation', 300_000);
      }
      let candidates = await this.store.nextCandidates(chatId);
      if (
        candidates.every((candidate) => candidate.lane !== 'live') &&
        (await this.store.bufferSize(chatId)) <= CHAT_BUFFER - 100
      ) {
        // FLAG: Current expiry wins admission. History uses only the visit's spare capacity.
        for (const lane of ['live', 'history'] as const satisfies readonly Lane[]) {
          policy = await this.store.active(chatId, leaseToken);
          if (!policy || this.stopping) return;
          const window = await this.store.openScan(policy, lane);
          if (!window) continue;
          await this.max.rights(chatId);
          await this.store.connection(chatId, 'connected');
          const page = await this.max.page(chatId, window.upper, window.lower);
          await this.store.savePage(policy, lane, page);
          candidates = await this.store.nextCandidates(chatId);
          if (candidates.length) break;
        }
      }
      let rightsAt = 0,
        pinAt = 0;
      let pin: string | null = null;
      for (const candidate of candidates) {
        policy = await this.store.active(chatId, leaseToken);
        if (!policy || this.stopping) break;
        const due = Number(candidate.source_ms) + policy.hours * 3_600_000;
        if (due > Date.now()) {
          await this.store.defer(candidate, 'not_due', Math.min(due - Date.now(), 3_600_000));
          continue;
        }
        if (Date.now() - rightsAt >= 30_000) {
          rightsAt = Date.now();
          await this.max.rights(chatId);
          await this.store.connection(chatId, 'connected');
        }
        if (Date.now() - pinAt >= 5000) {
          pinAt = Date.now();
          pin = await this.max.pin(chatId);
        }
        if (pin === candidate.message_id) {
          await this.store.defer(candidate, 'pinned', 60_000);
          continue;
        }
        let dispatched = false;
        try {
          await this.max.remove(chatId, candidate.message_id, async () => {
            await this.store.assertAndMarkDispatch(candidate, leaseToken, rightsAt, pinAt);
            dispatched = true;
          });
          await this.store.settle(candidate, 'deleted', 'deleted');
        } catch (failure) {
          if (failure instanceof ServiceError) {
            if (failure.code === 'ERASER_PROTECTED')
              await this.store.settle(candidate, 'protected', 'protected');
            else if (failure.code === 'ERASER_PROTECTION_PENDING')
              await this.store.deferProtection(candidate);
            else await this.store.defer(candidate, 'policy_changed', 1000);
          } else if (failure instanceof MaxError && failure.status === 429 && !failure.attempted) {
            await this.store.settle(candidate, 'pending', 'rate_limited', failure.retryAfterMs);
          } else if (
            failure instanceof MaxError &&
            failure.status === 404 &&
            failure.code === 'message.not.found'
          ) {
            await this.store.settle(candidate, 'deleted', 'exact_delete_absence');
          } else if (dispatched) {
            // FLAG: Timeout, malformed acknowledgement and generic errors retain mutation uncertainty.
            await this.store.settle(candidate, 'uncertain', 'reconciliation', 10_000);
          } else throw failure;
        }
      }
      if (!candidates.length) wait = 30_000;
    } catch (failure) {
      if (failure instanceof MaxError) {
        error = failure.code;
        wait =
          failure.status === 429 ? failure.retryAfterMs : failure.status === 403 ? 300_000 : 5000;
        if (failure.code === 'eraser_rights_missing')
          await this.store.connection(chatId, 'no_access');
      } else {
        error = 'worker_error';
        wait = 5000;
      }
    } finally {
      await this.store.finishVisit(chatId, leaseToken, error, wait);
    }
  }
  health(): { schedulerLastSuccessfulAt: string | null; schedulerHealthy: boolean } {
    return {
      schedulerLastSuccessfulAt: this.lastSchedulerAt
        ? new Date(this.lastSchedulerAt).toISOString()
        : null,
      schedulerHealthy:
        !this.config.enabled ||
        (this.lastSchedulerAt !== null && Date.now() - this.lastSchedulerAt < 10_000),
    };
  }
  async close(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    while (this.running) await delay(10);
    await this.worker?.pause();
    await this.worker?.close();
    await this.queue?.close();
  }
}
