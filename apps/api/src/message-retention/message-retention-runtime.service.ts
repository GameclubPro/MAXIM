import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationDeleteIntentService } from '../moderation/moderation-delete-intent.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { MessageRetentionStore } from './message-retention-store.service';
import {
  MESSAGE_RETENTION_QUEUE,
  MESSAGE_RETENTION_QUEUE_LIMIT,
  MESSAGE_RETENTION_SLOT_IDS,
  MESSAGE_RETENTION_TIMER_MS,
  MESSAGE_RETENTION_IDLE_MS,
  MESSAGE_RETENTION_VISIT_MS,
  retentionGuardOutcome,
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
        await this.store.retireTransferredCandidates();
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
        // FLAG: This retained queue owns database-only legacy receipt maintenance.
        // Its jobs cannot create intents, read MAX or dispatch another DELETE.
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
    const deadline = Date.now() + MESSAGE_RETENTION_VISIT_MS;
    // FLAG: Lastik is the sole age-based executor. Retained jobs only settle saved
    // receipts or release ended-generation credit, regardless of old rollout flags.
    await this.reconcileReceipts(chatId, deadline);
    if (this.stopping || Date.now() >= deadline) return;
    const inactive = await this.store.dueInactiveCandidates(policy);
    await this.store.cancelInactive(inactive);
    await this.store.scheduleNext(chatId, { continueInactive: inactive.length > 0 });
    this.nextAdmissionAt = Date.now();
  }

  private async reconcileReceipts(chatId: string, deadline: number): Promise<void> {
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
        const result = await this.deletes.reconcileRetentionIntent(candidate.intentId);
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
