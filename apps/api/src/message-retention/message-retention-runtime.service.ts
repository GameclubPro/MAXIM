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
import { MESSAGE_RETENTION_QUEUE, MESSAGE_RETENTION_QUEUE_LIMIT } from './message-retention.policy';

export type MessageRetentionJob = { chatId: string };

@Injectable()
export class MessageRetentionRuntime implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageRetentionRuntime.name);
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
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

  onModuleInit(): void {
    if (this.store.mode === 'off') return;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopping || this.store.mode === 'off') return;
    this.busy = true;
    let token: string | null = null;
    try {
      token = await this.locks.acquireLock('message-retention:scheduler:v1', 25_000);
      if (!token) return;
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
        const policies = await this.prisma.messageRetentionPolicy.findMany({
          where: { nextRunAt: { lte: new Date() } },
          orderBy: [{ nextRunAt: 'asc' }, { chatId: 'asc' }],
          take: available,
          select: { chatId: true, nextRunAt: true, revision: true },
        });
        for (const policy of policies) {
          if (this.stopping) break;
          if ((await this.locks.getString('message-retention:scheduler:v1')) !== token) break;
          if (this.store.allows(policy.chatId))
            await this.queue.add(
              'chat',
              { chatId: policy.chatId },
              {
                jobId: createHash('sha256').update(policy.chatId).digest('hex'),
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
      if (Date.now() >= this.nextPurgeAt) {
        await this.store.purge();
        this.nextPurgeAt = Date.now() + 60_000;
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : 'unknown' },
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
      this.busy = false;
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
      await this.prisma.messageRetentionPolicy.update({
        where: { chatId },
        data: { lastStatus: 'paused', nextRunAt: new Date(Date.now() + decision.retryAfterMs) },
      });
      return;
    }
    if (decision.action === 'slow')
      await this.locks.setStringWithTtl('maxapi:message-retention:slow:v1', '1', 60);
    await this.store.resumeAdmission(chatId);
    const candidates = await this.store.dueCandidates(policy);
    const limit = decision.action === 'slow' ? 2 : 5;
    let processed = 0;
    for (const candidate of candidates) {
      if (this.stopping) break;
      if (!policy.enabled || candidate.activationId !== policy.activationId) {
        await this.store.finish(candidate, 'cancelled');
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
            status: { in: ['pending', 'retry'] },
          },
          data: { status: 'retry', nextAttemptAt: new Date(currentDueAt) },
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
      } catch {
        status = 'error';
        delayMs = 5 * 60_000;
      }
      await this.prisma.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          messageId: candidate.messageId,
          status: { in: ['pending', 'retry'] },
        },
        data: { status: 'retry', nextAttemptAt: new Date(Date.now() + delayMs) },
      });
      await this.prisma.messageRetentionPolicy.update({
        where: { chatId },
        data: { lastStatus: status },
      });
    }
    await this.store.scheduleNext(chatId);
  }
}
