import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { RuntimeWorkerOwner, type RuntimeWorker } from '../runtime/runtime-worker-shutdown';
import { ModerationExecutionService } from './moderation-execution.service';
import { RequiredSubscriptionCandidateStore } from './required-subscription-candidate.store';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';

@Injectable()
export class RequiredSubscriptionCandidateService
  extends RuntimeWorkerOwner
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RequiredSubscriptionCandidateService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepTask: Promise<number> | null = null;
  private stopping = false;
  private forcedClosed = false;
  private readonly active = new Set<Promise<unknown>>();

  constructor(
    private readonly store: RequiredSubscriptionCandidateStore,
    private readonly moduleRef: ModuleRef,
  ) {
    super();
  }

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {
        this.logger.warn('Required subscription candidate discovery unavailable');
      });
    }, 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopAdmission();
    if (this.forcedClosed) return;
    let deadline: NodeJS.Timeout | undefined;
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 5_000);
      }),
    ]);
    if (deadline) clearTimeout(deadline);
  }

  private stopAdmission(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }

  stopWorkerAdmission(): readonly RuntimeWorker[] {
    // FLAG: Stop SQL discovery synchronously before shutdown closes stores. A forced
    // exit retains the original lease, decision and effect receipts for the next owner.
    this.stopAdmission();
    return [
      {
        name: 'required-subscription-candidate',
        pause: async () => this.drain(),
        close: async (force?: boolean) => {
          this.forcedClosed = force === true;
          if (!force) await this.drain();
        },
      },
    ];
  }

  async sweep(): Promise<number> {
    if (this.stopping) return 0;
    if (this.sweepTask) return this.sweepTask;
    const task = this.runSweep();
    this.sweepTask = task;
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
      this.sweepTask = null;
    }
  }

  private async runSweep(): Promise<number> {
    const ids = await this.store.listDueIds();
    let handled = 0;
    // FLAG: SQL is the recovery source; no wake-up or queue job can renew a source
    // deadline. Four bounded candidates cannot create an unbounded in-memory backlog.
    for (let offset = 0; offset < ids.length && !this.stopping; offset += 4) {
      const results = await Promise.allSettled(
        ids.slice(offset, offset + 4).map((id) => this.attempt(id)),
      );
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected')
          this.logger.warn(
            { id: ids[offset + index] },
            'Required subscription candidate claim unavailable',
          );
      }
      handled += results.filter((result) => result.status === 'fulfilled' && result.value).length;
    }
    return handled;
  }

  async attempt(id: string): Promise<boolean> {
    if (this.stopping) return false;
    const task = this.executeAttempt(id);
    this.active.add(task);
    try {
      return await task;
    } finally {
      this.active.delete(task);
    }
  }

  private async executeAttempt(id: string): Promise<boolean> {
    const row = await this.store.claim(id);
    if (!row) return false;
    const token = row.leaseToken;
    if (!token) throw new Error('Required subscription candidate lease missing');
    let leaseLost = false;
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || leaseLost) return;
      renewing = true;
      void this.store
        .renewLease(id, token)
        .catch(() => {
          leaseLost = true;
        })
        .finally(() => {
          renewing = false;
        });
    }, 5_000);
    heartbeat.unref();
    const journal = this.store.journal(id, token, Date.now() >= row.deadlineAt.getTime());
    try {
      const executor = this.moduleRef.get(ModerationExecutionService, { strict: false });
      await executor.executeRequiredSubscriptionCandidate({ row, store: this.store, journal });
    } catch (error: unknown) {
      // FLAG: A store or lease loss grants no authority to finish another owner's row.
      // Started/ambiguous effects remain fenced; read-only failures retain a bounded retry.
      if (leaseLost) return true;
      try {
        await this.store.assertLease(id, token);
        const state = await journal.readState();
        const unknown =
          ['BAN_STARTED', 'UNKNOWN'].includes(state.phase) || isAmbiguousMaxSendError(error);
        await this.store.finish(
          id,
          token,
          unknown ? 'UNKNOWN' : 'WAITING_CHECK',
          unknown ? 'REQUIRED_SUBSCRIPTION_EFFECT_UNKNOWN' : 'REQUIRED_SUBSCRIPTION_READ_RETRY',
          unknown ? 60_000 : 1_000,
        );
      } catch {
        this.logger.warn({ id }, 'Required subscription candidate retained after lease/store loss');
      }
    } finally {
      clearInterval(heartbeat);
    }
    return true;
  }
}
