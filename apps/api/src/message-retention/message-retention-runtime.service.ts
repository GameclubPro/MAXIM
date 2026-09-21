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
} from './message-retention.policy';

export type MessageRetentionJob = { chatId: string };

@Injectable()
export class MessageRetentionRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageRetentionRuntime.name);
  private timer: NodeJS.Timeout | null = null;
  private activeTick: Promise<void> | null = null;
  private stopping = false;
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
    this.timer = setInterval(() => void this.tick(), 30_000);
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
      (this.store.mode === 'off' && Date.now() < this.nextPurgeAt)
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
      if (!token) return;
      if (!this.stopping && Date.now() >= this.nextPurgeAt) {
        await this.store.purge();
        this.nextPurgeAt = Date.now() + 60_000;
      }
      if (this.stopping || this.store.mode === 'off') return;
      const decision = await this.governor.decide({
        component: MESSAGE_RETENTION_QUEUE,
        sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
      });
      if (decision.action === 'pause') return;
      const counts = await this.queue.getJobCounts('wait', 'active', 'delayed', 'prioritized');
      const available = Math.max(
        0,
        MESSAGE_RETENTION_QUEUE_LIMIT - Object.values(counts).reduce((a, b) => a + b, 0),
      );
      if (available) {
        const jobs = await this.queue.getJobs(
          ['wait', 'active', 'delayed', 'prioritized'],
          0,
          MESSAGE_RETENTION_QUEUE_LIMIT - 1,
        );
        const occupied = new Set(jobs.map((job) => job.id));
        // FLAG: Fixed job IDs enforce the queue ceiling even if a producer loses its lease.
        // Drain legacy chat-keyed jobs before switching to slot admission.
        if (jobs.some((job) => !MESSAGE_RETENTION_SLOT_IDS.includes(job.id ?? ''))) return;
        const freeSlots = MESSAGE_RETENTION_SLOT_IDS.filter((id) => !occupied.has(id)).slice(
          0,
          available,
        );
        const policies = await this.prisma.messageRetentionPolicy.findMany({
          where: { ...this.store.schedulingFilter(), nextRunAt: { lte: new Date() } },
          orderBy: [{ nextRunAt: 'asc' }, { chatId: 'asc' }],
          take: freeSlots.length,
          select: { chatId: true, nextRunAt: true, revision: true },
        });
        const deadline = Date.now() + 15_000;
        for (const [index, policy] of policies.entries()) {
          const slot = freeSlots[index];
          if (!slot) break;
          if (this.stopping || Date.now() >= deadline) break;
          if (!(await this.locks.renewLock('message-retention:scheduler:v1', token, 25_000))) break;
          if (this.store.allows(policy.chatId))
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
            where: {
              chatId: policy.chatId,
              nextRunAt: policy.nextRunAt,
              revision: policy.revision,
            },
            data: { nextRunAt: new Date(Date.now() + 60_000) },
          });
        }
      }
    } catch (error: unknown) {
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
    if (this.stopping || !this.store.allows(chatId)) return;
    const policy = await this.prisma.messageRetentionPolicy.findUnique({ where: { chatId } });
    if (!policy) return;
    const decision = await this.governor.decide({
      component: MESSAGE_RETENTION_QUEUE,
      sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
    });
    if (decision.action === 'pause') {
      await this.prisma.messageRetentionPolicy.updateMany({
        where: { chatId, revision: policy.revision },
        data: { lastStatus: 'paused', nextRunAt: new Date(Date.now() + decision.retryAfterMs) },
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
      if (this.stopping) break;
      if (!policy.enabled || candidate.activationId !== policy.activationId) {
        continue;
      }
      if (candidate.shadowOnly) {
        await this.store.finish(candidate, 'skipped');
        continue;
      }
      const currentDueAt = candidate.sourceAt.getTime() + policy.hours * 3_600_000;
      if (currentDueAt > Date.now()) {
        await this.prisma.messageRetentionCandidate.updateMany({
          where: {
            chatId,
            messageId: candidate.messageId,
            activationId: candidate.activationId,
            status: { in: ['pending', 'retry'] },
          },
          data: { status: 'pending' },
        });
        continue;
      }
      if (this.store.mode === 'shadow' || processed >= limit) break;
      processed++;
      let delayMs = decision.action === 'slow' ? 120_000 : 60_000;
      let status = 'running';
      try {
        let intentId = candidate.intentId ?? (await this.deletes.ensureRetentionIntent(candidate));
        let intent = await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: intentId },
          select: { retentionOwned: true, status: true, lastErrorCode: true, nextAttemptAt: true },
        });
        if (!intent) {
          intentId = await this.deletes.ensureRetentionIntent(candidate);
          intent = await this.prisma.moderationDeleteIntent.findUniqueOrThrow({
            where: { id: intentId },
            select: {
              retentionOwned: true,
              status: true,
              lastErrorCode: true,
              nextAttemptAt: true,
            },
          });
        }
        // FLAG: Independently owned moderation intents never execute in this background lane.
        const result = intent?.retentionOwned ? await this.deletes.attemptIntent(intentId) : null;
        const outcome = result?.status ?? intent?.status;
        if (outcome === 'SUCCEEDED' || outcome === 'ALREADY_ABSENT') {
          await this.store.finish(candidate, 'deleted');
          continue;
        }
        const latest = await this.prisma.moderationDeleteIntent.findUnique({
          where: { id: intentId },
          select: { status: true, lastErrorCode: true, nextAttemptAt: true, retentionOwned: true },
        });
        if (
          latest?.retentionOwned &&
          latest.status === 'FAILED_TERMINAL' &&
          latest.lastErrorCode === 'message_retention_guard_rejected'
        ) {
          await this.store.finish(candidate, 'skipped');
          continue;
        }
        if (latest) delayMs = Math.max(delayMs, latest.nextAttemptAt.getTime() - Date.now());
        status =
          outcome === 'WAITING_CAPABILITY'
            ? 'no_access'
            : outcome === 'FAILED_TERMINAL'
              ? 'error'
              : 'delayed';
      } catch (error) {
        const deferred =
          error instanceof MessageRetentionGuardError && error.disposition === 'retry';
        status = deferred ? 'delayed' : 'error';
        delayMs = deferred ? delayMs : 5 * 60_000;
      }
      await this.prisma.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          messageId: candidate.messageId,
          activationId: candidate.activationId,
          status: { in: ['pending', 'retry'] },
        },
        data: { status: 'retry', nextAttemptAt: new Date(Date.now() + delayMs) },
      });
      const severity = ['running', 'delayed', 'no_access', 'error'];
      if (severity.indexOf(status) > severity.indexOf(runStatus)) runStatus = status;
    }
    await this.prisma.messageRetentionPolicy.updateMany({
      where: { chatId, revision: policy.revision },
      data: { lastStatus: runStatus },
    });
    await this.store.scheduleNext(chatId);
  }
}
