import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { MessageRetentionStore } from './message-retention-store.service';
import { MessageRetentionGuardError } from './message-retention-delete-guard.service';
import {
  MESSAGE_RETENTION_QUEUE,
  MESSAGE_RETENTION_QUEUE_LIMIT,
  MESSAGE_RETENTION_SLOT_IDS,
  MESSAGE_RETENTION_TIMER_MS,
  MESSAGE_RETENTION_IDLE_MS,
  MESSAGE_RETENTION_VISIT_MS,
  retentionGuardOutcome,
  type RetentionOutcomeCode,
} from './message-retention.policy';
import type { ModerationDeleteIntent } from '../prisma/prisma-client';

export type MessageRetentionJob = { chatId: string };

const receiptSelect = {
  retentionOwned: true,
  status: true,
  lastErrorCode: true,
  nextAttemptAt: true,
  deleteDispatchStartedAt: true,
  deleteDispatchStartedBotId: true,
  remoteDeleteSucceededAt: true,
  remoteDeleteSucceededBotId: true,
} as const;

function hasMutationEvidence(
  receipt: Pick<
    ModerationDeleteIntent,
    | 'deleteDispatchStartedAt'
    | 'deleteDispatchStartedBotId'
    | 'remoteDeleteSucceededAt'
    | 'remoteDeleteSucceededBotId'
  >,
): boolean {
  return Boolean(
    receipt.deleteDispatchStartedAt ||
    receipt.deleteDispatchStartedBotId ||
    receipt.remoteDeleteSucceededAt ||
    receipt.remoteDeleteSucceededBotId,
  );
}

@Injectable()
export class MessageRetentionRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageRetentionRuntime.name);
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;
  private nextAdmissionAt = 0;
  private nextMaintenanceAt = Date.now() + MESSAGE_RETENTION_IDLE_MS;
  private nextPurgeAt = Date.now() + 3_600_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: MessageRetentionStore,
    private readonly deletes: ModerationDeleteIntentService,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly locks: RedisCounterService,
    @InjectQueue(MESSAGE_RETENTION_QUEUE) private readonly queue: Queue<MessageRetentionJob>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.setGlobalConcurrency(1);
    // FLAG: Startup does not run cleanup or synthesize an immediate catch-up.
    this.nextAdmissionAt = Date.now() + MESSAGE_RETENTION_IDLE_MS;
    this.timer = setInterval(() => void this.tick(), MESSAGE_RETENTION_TIMER_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // FLAG: Drain scheduling before its clients close; the shared runtime owns the hard deadline.
    await this.activeTick;
  }

  tick(): Promise<void> {
    if (
      this.activeTick ||
      this.stopping ||
      Date.now() < Math.min(this.nextAdmissionAt, this.nextMaintenanceAt, this.nextPurgeAt)
    )
      return Promise.resolve();
    this.activeTick = this.runTick().finally(() => {
      this.activeTick = null;
    });
    return this.activeTick;
  }

  private async runTick(): Promise<void> {
    let token: string | null = null;
    try {
      token = await this.locks.acquireLock('message-retention:scheduler:v1', 25_000);
      if (!token) {
        this.nextAdmissionAt = Date.now() + 5_000;
        return;
      }
      if (!this.stopping && Date.now() >= this.nextMaintenanceAt) {
        await this.store.discoverLegacyReceipts();
        this.nextMaintenanceAt = Date.now() + 60_000;
      }
      if (!this.stopping && Date.now() >= this.nextPurgeAt) {
        await this.store.purge();
        this.nextPurgeAt = Date.now() + 60_000;
      }
      if (this.stopping || Date.now() < this.nextAdmissionAt) return;
      this.nextAdmissionAt = Date.now() + MESSAGE_RETENTION_IDLE_MS;
      const counts = await this.queue.getJobCounts('wait', 'active', 'delayed', 'prioritized');
      const available = Math.max(
        0,
        MESSAGE_RETENTION_QUEUE_LIMIT - Object.values(counts).reduce((a, b) => a + b, 0),
      );
      if (!available) {
        this.nextAdmissionAt = Date.now() + 5_000;
        return;
      }
      const jobs = await this.queue.getJobs(
        ['wait', 'active', 'delayed', 'prioritized'],
        0,
        MESSAGE_RETENTION_QUEUE_LIMIT - 1,
      );
      // FLAG: Fixed IDs enforce the ceiling even when a producer loses its lease.
      if (jobs.some((job) => !MESSAGE_RETENTION_SLOT_IDS.includes(job.id ?? ''))) return;
      const occupied = new Set(jobs.map((job) => job.id));
      const queuedChats = jobs
        .map((job) => job.data?.chatId)
        .filter((id): id is string => typeof id === 'string');
      const freeSlots = MESSAGE_RETENTION_SLOT_IDS.filter((id) => !occupied.has(id)).slice(
        0,
        available,
      );
      const policies = await this.prisma.messageRetentionPolicy.findMany({
        where: {
          nextRunAt: { lte: new Date() },
          AND: [this.store.workSchedulingFilter(), { chatId: { notIn: queuedChats } }],
        },
        orderBy: [{ nextRunAt: 'asc' }, { chatId: 'asc' }],
        take: freeSlots.length,
        select: { chatId: true, nextRunAt: true, revision: true },
      });
      if (!policies.length) return;
      const deadline = Date.now() + 15_000;
      for (const [index, policy] of policies.entries()) {
        const slot = freeSlots[index];
        if (!slot || this.stopping || Date.now() >= deadline) break;
        if (!(await this.locks.renewLock('message-retention:scheduler:v1', token, 25_000))) break;
        // Receipt jobs use the same single worker and are permitted to finalize DB-only
        // success while DELETE is off. Dispatch authority is rechecked in process().
        await this.queue.add(
          'chat',
          { chatId: policy.chatId },
          {
            jobId: slot,
            deduplication: { id: createHash('sha256').update(policy.chatId).digest('hex') },
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          },
        );
        await this.prisma.messageRetentionPolicy.updateMany({
          where: { chatId: policy.chatId, nextRunAt: policy.nextRunAt, revision: policy.revision },
          data: { nextRunAt: new Date(Date.now() + 60_000) },
        });
      }
      this.nextAdmissionAt =
        Date.now() +
        (jobs.length || policies.length >= freeSlots.length ? 5_000 : MESSAGE_RETENTION_IDLE_MS);
    } catch (error: unknown) {
      this.nextAdmissionAt = Date.now() + MESSAGE_RETENTION_IDLE_MS;
      this.logger.warn(
        { errorType: error instanceof Error ? error.name : 'unknown' },
        'Message retention scheduler deferred',
      );
    } finally {
      if (token) {
        try {
          await this.locks.releaseLock('message-retention:scheduler:v1', token);
        } catch {
          /* The bounded lease expires without an unsafe unconditional release. */
        }
      }
    }
  }

  async process(chatId: string): Promise<void> {
    if (this.stopping) return;
    const policy = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
    if (!policy) return;
    const decision = this.store.allows(chatId, true)
      ? await this.governor.decide({
          component: MESSAGE_RETENTION_QUEUE,
          sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
        })
      : { action: 'pause' as const, retryAfterMs: 60_000 };
    const deadline = Date.now() + MESSAGE_RETENTION_VISIT_MS;
    await this.reconcileReceipts(
      chatId,
      decision.action !== 'pause' && this.store.allows(chatId, true),
      deadline,
    );
    if (!this.store.allows(chatId)) {
      await this.store.updateRunStatus(chatId, policy.revision, 'running');
      await this.store.scheduleNext(chatId);
      this.nextAdmissionAt = Date.now();
      return;
    }
    if (decision.action === 'pause' && policy.enabled && this.store.mode !== 'shadow') {
      await this.store.updateRunStatus(chatId, policy.revision, 'paused');
      await this.prisma.messageRetentionPolicy.updateMany({
        where: { chatId, revision: policy.revision },
        data: { nextRunAt: new Date(Date.now() + decision.retryAfterMs) },
      });
      return;
    }
    if (decision.action === 'slow')
      await this.locks.setStringWithTtl('maxapi:message-retention:slow:v1', '1', 60);
    await this.store.resumeAdmission(chatId);
    const candidates = await this.store.dueCandidates(policy);
    const inactive = candidates.filter(
      (candidate) => !policy.enabled || candidate.activationId !== policy.activationId,
    );
    await this.store.cancelInactive(inactive);
    const limit = decision.action === 'slow' ? 2 : 5;
    let processed = 0;
    let runStatus = 'running';
    for (const candidate of candidates) {
      if (this.stopping || Date.now() >= deadline) break;
      if (!policy.enabled || candidate.activationId !== policy.activationId) continue;
      if (candidate.shadowOnly) {
        await this.store.finish(candidate, 'skipped', { outcomeCode: 'shadow' });
        continue;
      }
      if (candidate.sourceAt.getTime() + policy.hours * 3_600_000 > Date.now()) {
        await this.prisma.messageRetentionCandidate.updateMany({
          where: {
            chatId,
            messageId: candidate.messageId,
            activationId: candidate.activationId,
            status: { in: ['pending', 'retry'] },
          },
          data: { status: 'pending', outcomeCode: null },
        });
        continue;
      }
      if (this.store.mode === 'shadow' || processed >= limit) break;
      processed++;
      let delayMs = decision.action === 'slow' ? 120_000 : 60_000;
      let outcomeCode: RetentionOutcomeCode = 'deferred';
      try {
        let intentId = candidate.intentId ?? (await this.deletes.ensureRetentionIntent(candidate));
        let intent = await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: intentId },
          select: receiptSelect,
        });
        if (!intent) {
          intentId = await this.deletes.ensureRetentionIntent(candidate);
          intent = await this.prisma.moderationDeleteIntent.findUniqueOrThrow({
            where: { id: intentId },
            select: receiptSelect,
          });
        }
        // FLAG: An independent intent is observed, never executed in the retention lane.
        let result = intent.retentionOwned
          ? await this.deletes.attemptRetentionIntent(intentId)
          : intent;
        if (result.status === 'SUCCEEDED' || result.status === 'ALREADY_ABSENT') {
          await this.store.finish(candidate, 'deleted');
          continue;
        }
        if (['FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'].includes(result.status)) {
          const receipt = await this.prisma.moderationDeleteIntent.findUnique({
            where: { id: intentId },
            select: receiptSelect,
          });
          if (receipt) result = receipt;
          if (result.status === 'SUCCEEDED' || result.status === 'ALREADY_ABSENT') {
            await this.store.finish(candidate, 'deleted');
            continue;
          }
          // FLAG: A legacy terminal label cannot discard a dispatched mutation receipt.
          // Release active credit while independent read-only reconciliation owns its evidence.
          if (receipt?.retentionOwned && hasMutationEvidence(receipt)) {
            await this.store.finish(candidate, 'skipped', {
              outcomeCode: 'reconciliation',
              reconcile: true,
            });
            continue;
          }
          if (['FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'].includes(result.status)) {
            const protectedSkip =
              result.retentionOwned &&
              (result.lastErrorCode === 'message_retention_guard_rejected' ||
                result.lastErrorCode?.startsWith('message_retention_guard:'));
            const reason =
              'reasonCode' in result && typeof result.reasonCode === 'string'
                ? result.reasonCode
                : result.lastErrorCode?.split(':')[1];
            await this.store.finish(candidate, 'skipped', {
              outcomeCode: protectedSkip ? retentionGuardOutcome(reason) : 'terminal_review',
            });
            continue;
          }
        }
        delayMs = Math.max(delayMs, result.nextAttemptAt.getTime() - Date.now());
        outcomeCode = result.status === 'WAITING_CAPABILITY' ? 'waiting_access' : 'deferred';
      } catch (error: unknown) {
        if (error instanceof MessageRetentionGuardError) {
          if (error.disposition === 'skip') {
            const outcome = retentionGuardOutcome(error.reasonCode);
            await this.store.finish(candidate, outcome === 'cancelled' ? 'cancelled' : 'skipped', {
              outcomeCode: outcome,
              ...(outcome === 'cancelled' && candidate.intentId ? { reconcile: true } : {}),
            });
            continue;
          }
          outcomeCode = 'deferred';
        } else {
          outcomeCode = 'worker_error';
          delayMs = 5 * 60_000;
        }
      }
      await this.prisma.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          messageId: candidate.messageId,
          activationId: candidate.activationId,
          status: { in: ['pending', 'retry'] },
        },
        data: { status: 'retry', nextAttemptAt: new Date(Date.now() + delayMs), outcomeCode },
      });
      if (outcomeCode === 'worker_error') runStatus = 'error';
      else if (runStatus !== 'error' && outcomeCode === 'waiting_access') runStatus = 'no_access';
      else if (runStatus === 'running') runStatus = 'delayed';
    }
    await this.store.updateRunStatus(chatId, policy.revision, runStatus);
    await this.store.scheduleNext(chatId, { continueInactive: inactive.length === 100 });
    this.nextAdmissionAt = Date.now();
  }

  private async reconcileReceipts(
    chatId: string,
    allowRead: boolean,
    deadline: number,
  ): Promise<void> {
    const candidates = await this.store.dueReconciliations(chatId, 2);
    for (const candidate of candidates) {
      if (this.stopping || Date.now() >= deadline) break;
      try {
        if (!candidate.intentId) {
          await this.store.settleReconciliation(candidate, 'cancelled');
          continue;
        }
        const intent = await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: candidate.intentId },
          select: receiptSelect,
        });
        if (!intent || !intent.retentionOwned) {
          await this.store.settleReconciliation(
            candidate,
            intent?.status === 'SUCCEEDED' || intent?.status === 'ALREADY_ABSENT'
              ? 'deleted'
              : 'cancelled',
          );
          continue;
        }
        const result = await this.deletes.reconcileRetentionIntent(candidate.intentId, {
          allowRead,
          canRead: async () => {
            if (!this.store.allows(chatId, true)) return false;
            const fresh = await this.governor.decide({
              component: MESSAGE_RETENTION_QUEUE,
              sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
            });
            return fresh.action !== 'pause' && this.store.allows(chatId, true);
          },
        });
        if (result?.status === 'SUCCEEDED' || result?.status === 'ALREADY_ABSENT') {
          await this.store.settleReconciliation(candidate, 'deleted');
          continue;
        }
        if (
          result?.status === 'FAILED_TERMINAL' ||
          result?.status === 'EXPIRED' ||
          result?.status === 'OBSERVED'
        ) {
          const current = await this.prisma.moderationDeleteIntent.findUnique({
            where: { id: candidate.intentId },
            select: receiptSelect,
          });
          if (!current || current.status === 'SUCCEEDED' || current.status === 'ALREADY_ABSENT') {
            await this.store.settleReconciliation(candidate, current ? 'deleted' : 'cancelled');
            continue;
          }
          // FLAG: Failed recovery claims and mode-off returns may retain a legacy terminal
          // status. Only a fresh receipt without mutation evidence can end reconciliation.
          if (
            hasMutationEvidence(current) ||
            !['FAILED_TERMINAL', 'EXPIRED', 'OBSERVED'].includes(current.status)
          ) {
            await this.store.deferReconciliation(candidate);
            continue;
          }
          await this.store.settleReconciliation(
            candidate,
            current.lastErrorCode?.startsWith('message_retention_guard:') ||
              current.lastErrorCode === 'message_retention_guard_rejected'
              ? retentionGuardOutcome(current.lastErrorCode?.split(':')[1])
              : 'terminal_review',
          );
          continue;
        }
        if (!result) {
          const current = await this.prisma.moderationDeleteIntent.findUnique({
            where: { id: candidate.intentId },
            select: receiptSelect,
          });
          if (current?.status === 'SUCCEEDED' || current?.status === 'ALREADY_ABSENT') {
            await this.store.settleReconciliation(candidate, 'deleted');
            continue;
          }
          if (current && hasMutationEvidence(current)) {
            await this.store.deferReconciliation(candidate);
            continue;
          }
          // FLAG: Retention has always persisted a dispatch marker before DELETE and
          // replaced it atomically with success evidence. Marker-free AMBIGUOUS can be
          // a pre-dispatch persistence failure; cancellation makes no claim of absence.
          const errorCode = current?.lastErrorCode;
          await this.store.settleReconciliation(
            candidate,
            errorCode === 'message_retention_guard_rejected' ||
              errorCode?.startsWith('message_retention_guard:')
              ? retentionGuardOutcome(errorCode?.split(':')[1])
              : current?.status === 'FAILED_TERMINAL'
                ? 'terminal_review'
                : 'cancelled',
          );
          continue;
        }
      } catch {
        /* Recovery preserves evidence and retries without a destructive call. */
      }
      await this.store.deferReconciliation(candidate);
    }
  }
}
