import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import type { MessageRetentionSummary } from '@maxim/contracts/settings';
import {
  Prisma,
  type MessageRetentionCandidate,
  type MessageRetentionPolicy,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { captureRetentionMessage } from './message-retention-capture';
import { purgeRetentionPage, type RetentionPurgeCursor } from './message-retention-purge';
import { discoverRetentionReceipts } from './message-retention-recovery';
import { retentionStatus } from './message-retention-status';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_RESUME_MS,
  MESSAGE_RETENTION_SHARD_LIMIT,
  MESSAGE_RETENTION_RECOVERY_RETRY_MS,
  MESSAGE_RETENTION_RULE,
  retentionBlockerStatus,
  readRetentionCapture,
  retentionModeAllows,
  type RetentionCapture,
  type RetentionOutcomeCode,
  type RetentionBlockerStatus,
} from './message-retention.policy';

export type RetentionDiagnostics = {
  hasTerminalReview: boolean;
  hasUnresolvedReceipt: boolean;
  oldestDueAt: Date | null;
  blockerStatus: RetentionBlockerStatus;
};

@Injectable()
export class MessageRetentionStore {
  private readonly logger = new Logger(MessageRetentionStore.name);
  private purgeCursor: RetentionPurgeCursor | null = null;
  private discoveryCursor: RetentionPurgeCursor | null = null;
  private readonly discoveryBefore = new Date();
  private discoveryComplete = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get mode(): string {
    return this.config.get<string>('MESSAGE_RETENTION_MODE', 'off');
  }
  allows(chatId: string, mutation = false): boolean {
    return retentionModeAllows(
      this.mode,
      this.config.get('MESSAGE_RETENTION_CANARY_CHAT_IDS'),
      chatId,
      mutation,
    );
  }

  schedulingFilter(): Prisma.MessageRetentionPolicyWhereInput {
    if (this.mode === 'canary') {
      const ids = this.config
        .get<string>('MESSAGE_RETENTION_CANARY_CHAT_IDS', '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => /^-[1-9]\d*$/.test(id));
      return { chatId: { in: [...new Set(ids)] } };
    }
    return this.mode === 'off' ? { chatId: { in: [] } } : {};
  }

  workSchedulingFilter(): Prisma.MessageRetentionPolicyWhereInput {
    return {
      OR: [
        this.schedulingFilter(),
        {
          candidates: {
            some: { outcomeCode: 'reconciliation', reconcileAfter: { lte: new Date() } },
          },
        },
      ],
    };
  }

  async summary(chatId: string): Promise<MessageRetentionSummary> {
    const policy = await this.prisma.messageRetentionPolicy.findUnique({
      where: { chatId },
      select: {
        enabled: true,
        hours: true,
        revision: true,
        pausedAt: true,
        pendingCount: true,
        lastStatus: true,
      },
    });
    const diagnostics = policy?.enabled ? await this.diagnostics(chatId) : null;
    return {
      enabled: policy?.enabled ?? false,
      hours: policy?.hours === 24 ? 24 : 48,
      revision: policy?.revision ?? 0,
      status: retentionStatus(
        policy ? { ...policy, lastStatus: diagnostics?.blockerStatus ?? policy.lastStatus } : null,
        this.mode,
        this.allows(chatId),
        diagnostics?.oldestDueAt?.getTime(),
        diagnostics?.blockerStatus,
      ),
    };
  }

  captureInput(update: MaxUpdate): RetentionCapture | null {
    if (!update.message || !this.allows(update.message.chatId)) return null;
    const publisher = buildPublisherBotDescriptor({
      id: this.config.get('MAX_PUBLISHER_BOT_ID'),
    }).id;
    if (update.botId === publisher) return null;
    return readRetentionCapture(update);
  }

  async capture(tx: Prisma.TransactionClient, input: RetentionCapture): Promise<void> {
    if (await captureRetentionMessage(tx, input, this.mode === 'shadow'))
      this.logger.warn('Message retention intake paused by capacity guard');
  }

  async finish(
    candidate: MessageRetentionCandidate,
    status: 'deleted' | 'skipped' | 'cancelled',
    options: { outcomeCode?: RetentionOutcomeCode; reconcile?: boolean } = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: candidate.chatId },
      });
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${policy.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${candidate.chatId} FOR UPDATE`;
      const current = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: candidate.chatId },
      });
      // FLAG: A stale disabled/old-generation worker cannot cancel the current activation.
      if (
        status === 'cancelled' &&
        current.enabled &&
        current.activationId === candidate.activationId
      )
        return false;
      const changed = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          activationId: candidate.activationId,
          status: { in: ['pending', 'retry'] },
        },
        data: {
          status,
          completedAt: new Date(),
          outcomeCode: options.reconcile
            ? 'reconciliation'
            : (options.outcomeCode ??
              (status === 'deleted'
                ? 'deleted'
                : status === 'cancelled'
                  ? 'cancelled'
                  : 'protected')),
          reconcileAfter: options.reconcile ? new Date() : null,
        },
      });
      if (!changed.count) return false;
      await tx.messageRetentionPolicy.update({
        where: { chatId: candidate.chatId },
        data: {
          pendingCount: { decrement: 1 },
          ...(status === 'deleted'
            ? { deletedCount: { increment: 1 } }
            : { skippedCount: { increment: 1 } }),
        },
      });
      await tx.messageRetentionQuota.update({
        where: { shard: policy.quotaShard },
        data: { pendingCount: { decrement: 1 } },
      });
      return true;
    });
  }

  async resumeAdmission(chatId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      if (!initial.enabled || !initial.pausedAt) return;
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const quota = await tx.messageRetentionQuota.findUniqueOrThrow({
        where: { shard: initial.quotaShard },
      });
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      if (!policy.enabled) return;
      const now = new Date();
      const shardHealthy = quota.pendingCount < MESSAGE_RETENTION_SHARD_LIMIT * 0.6;
      const resumeShard = Boolean(
        shardHealthy &&
        quota.healthySince &&
        now.getTime() - quota.healthySince.getTime() >= MESSAGE_RETENTION_RESUME_MS,
      );
      if (quota.pausedAt) {
        await tx.messageRetentionQuota.update({
          where: { shard: quota.shard },
          data: resumeShard
            ? { pausedAt: null, healthySince: null }
            : { healthySince: shardHealthy ? (quota.healthySince ?? now) : null },
        });
      }
      if (!policy.pausedAt) return;
      const healthy = shardHealthy && policy.pendingCount < MESSAGE_RETENTION_CHAT_LIMIT * 0.6;
      const resume = Boolean(
        (!quota.pausedAt || resumeShard) &&
        healthy &&
        policy.healthySince &&
        now.getTime() - policy.healthySince.getTime() >= MESSAGE_RETENTION_RESUME_MS,
      );
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: resume
          ? { pausedAt: null, healthySince: null, captureAfter: now, lastStatus: 'running' }
          : { healthySince: healthy ? (policy.healthySince ?? now) : null },
      });
      if (resume)
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: 'system:message-retention',
            action: 'MESSAGE_RETENTION_INTAKE_RESUMED',
            payload: { startedAt: policy.pausedAt.toISOString(), endedAt: now.toISOString() },
          },
        });
    });
  }

  async cancelInactive(candidates: MessageRetentionCandidate[]): Promise<void> {
    if (!candidates.length) return;
    const chatId = candidates[0]!.chatId;
    if (candidates.length > 100 || candidates.some((candidate) => candidate.chatId !== chatId))
      throw new Error('Retention cancellation must be a bounded single-chat batch');
    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const current = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      const completedAt = new Date();
      const { count } = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          status: { in: ['pending', 'retry'] },
          messageId: { in: candidates.map((candidate) => candidate.messageId) },
          ...(current.enabled ? { activationId: { not: current.activationId } } : {}),
        },
        data: { status: 'cancelled', completedAt, outcomeCode: 'cancelled', reconcileAfter: null },
      });
      if (!count) return;
      // FLAG: Receipt recovery survives cancellation and owns no active admission credit.
      await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          messageId: { in: candidates.map((candidate) => candidate.messageId) },
          status: 'cancelled',
          completedAt,
          intentId: { not: null },
        },
        data: { reconcileAfter: completedAt, outcomeCode: 'reconciliation' },
      });
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: {
          pendingCount: { decrement: count },
          skippedCount: { increment: count },
        },
      });
      await tx.messageRetentionQuota.update({
        where: { shard: current.quotaShard },
        data: { pendingCount: { decrement: count } },
      });
    });
  }

  async dueCandidates(policy: MessageRetentionPolicy): Promise<MessageRetentionCandidate[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - policy.hours * 3_600_000);
    if (!policy.enabled)
      return this.prisma.messageRetentionCandidate.findMany({
        where: { chatId: policy.chatId, status: { in: ['pending', 'retry'] } },
        take: 100,
      });
    for (const status of ['pending', 'retry']) {
      for (const activationId of [{ lt: policy.activationId }, { gt: policy.activationId }]) {
        const stale = await this.prisma.messageRetentionCandidate.findMany({
          where: { chatId: policy.chatId, status, activationId },
          orderBy: [{ activationId: 'asc' }, { messageId: 'asc' }],
          take: 100,
        });
        if (stale.length) return stale;
      }
    }
    if (this.mode === 'shadow')
      return this.prisma.messageRetentionCandidate.findMany({
        where: {
          chatId: policy.chatId,
          status: 'pending',
          shadowOnly: true,
          sourceAt: { lte: cutoff },
        },
        orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
        take: 5,
      });
    const pending = await this.prisma.messageRetentionCandidate.findMany({
      where: { chatId: policy.chatId, status: 'pending', sourceAt: { lte: cutoff } },
      orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
      take: 5,
    });
    const retry = await this.prisma.messageRetentionCandidate.findMany({
      where: { chatId: policy.chatId, status: 'retry', nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: 'asc' }, { messageId: 'asc' }],
      take: 5,
    });
    return [
      ...retry.slice(0, 2),
      ...pending.slice(0, 3),
      ...retry.slice(2),
      ...pending.slice(3),
    ].slice(0, 5);
  }

  async scheduleNext(chatId: string, options: { continueInactive?: boolean } = {}): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      const shadowFilter = this.mode === 'shadow' ? { shadowOnly: true } : {};
      const pending = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, status: 'pending', ...shadowFilter },
        orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
        select: { sourceAt: true },
      });
      const retry = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, status: 'retry', ...shadowFilter },
        orderBy: [{ nextAttemptAt: 'asc' }, { messageId: 'asc' }],
        select: { nextAttemptAt: true },
      });
      const receipt = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, reconcileAfter: { not: null } },
        orderBy: [{ reconcileAfter: 'asc' }, { messageId: 'asc' }],
        select: { reconcileAfter: true },
      });
      const times = [
        pending ? pending.sourceAt.getTime() + policy.hours * 3_600_000 : Infinity,
        retry?.nextAttemptAt.getTime() ?? Infinity,
        policy.pausedAt ? Date.now() + 60_000 : Infinity,
        receipt?.reconcileAfter?.getTime() ?? Infinity,
      ];
      if (!policy.enabled && policy.pendingCount > 0) times.push(Date.now());
      if (options.continueInactive) times.push(Date.now());
      const next = Math.min(...times);
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: {
          // FLAG: Move a visited chat behind already-ready peers without sleeping through
          // an available transport budget. SQL remains the durable recovery schedule.
          nextRunAt: Number.isFinite(next) ? new Date(Math.max(Date.now(), next)) : null,
        },
      });
    });
  }

  async dueReconciliations(chatId?: string, take = 5): Promise<MessageRetentionCandidate[]> {
    return this.prisma.messageRetentionCandidate.findMany({
      where: { ...(chatId ? { chatId } : {}), reconcileAfter: { lte: new Date() } },
      orderBy: [{ reconcileAfter: 'asc' }, { chatId: 'asc' }, { messageId: 'asc' }],
      take: Math.min(100, Math.max(1, take)),
    });
  }

  async deferReconciliation(candidate: MessageRetentionCandidate): Promise<void> {
    await this.prisma.messageRetentionCandidate.updateMany({
      where: {
        chatId: candidate.chatId,
        messageId: candidate.messageId,
        intentId: candidate.intentId,
        reconcileAfter: { not: null },
      },
      data: { reconcileAfter: new Date(Date.now() + MESSAGE_RETENTION_RECOVERY_RETRY_MS) },
    });
  }

  async reopenTerminalCandidate(input: {
    chatId: string;
    messageId: string;
    activationId: string;
    expectedRevision: number;
    intentId: string;
    expectedIntentUpdatedAt: Date;
    expectedAttemptCount: number;
    actorUserId: string;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // FLAG: Producers and GC lock the intent first. Never hold the policy while
      // waiting for that intent; admission credit still locks quota before policy.
      await tx.$queryRaw`SELECT "id" FROM "moderation_delete_intents" WHERE "id" = ${input.intentId} FOR UPDATE`;
      const initial = await tx.messageRetentionPolicy.findUnique({
        where: { chatId: input.chatId },
      });
      if (!initial) return false;
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${input.chatId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "message_id" FROM "message_retention_candidates" WHERE "chat_id" = ${input.chatId} AND "message_id" = ${input.messageId} FOR UPDATE`;
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: input.chatId },
      });
      const quota = await tx.messageRetentionQuota.findUniqueOrThrow({
        where: { shard: policy.quotaShard },
      });
      const candidate = await tx.messageRetentionCandidate.findUnique({
        where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
      });
      const intent = await tx.moderationDeleteIntent.findUnique({
        where: { id: input.intentId },
        include: { reasons: { select: { ruleCode: true } } },
      });
      if (
        !this.allows(input.chatId, true) ||
        !policy.enabled ||
        policy.revision !== input.expectedRevision ||
        policy.activationId !== input.activationId ||
        policy.pausedAt ||
        quota.pausedAt ||
        policy.pendingCount >= MESSAGE_RETENTION_CHAT_LIMIT * 0.8 ||
        quota.pendingCount >= MESSAGE_RETENTION_SHARD_LIMIT * 0.8 ||
        !candidate ||
        candidate.shadowOnly ||
        candidate.activationId !== input.activationId ||
        candidate.intentId !== input.intentId ||
        candidate.outcomeCode !== 'terminal_review' ||
        !['skipped', 'cancelled'].includes(candidate.status) ||
        !intent?.retentionOwned ||
        intent.chatId !== input.chatId ||
        intent.messageId !== input.messageId ||
        intent.subjectUserId !== candidate.authorId ||
        !['FAILED_TERMINAL', 'EXPIRED'].includes(intent.status) ||
        intent.updatedAt.getTime() !== input.expectedIntentUpdatedAt.getTime() ||
        intent.attemptCount !== input.expectedAttemptCount ||
        intent.reasons.length !== 1 ||
        intent.reasons[0]?.ruleCode !== MESSAGE_RETENTION_RULE ||
        intent.deleteDispatchStartedAt ||
        intent.deleteDispatchStartedBotId ||
        intent.remoteDeleteSucceededAt ||
        intent.remoteDeleteSucceededBotId
      )
        return false;
      const now = new Date();
      await tx.moderationDeleteIntent.update({
        where: { id: intent.id },
        data: {
          status: 'PENDING',
          nextAttemptAt: now,
          executeAt: now,
          completedAt: null,
          retryUntilAt: new Date('9999-01-01T00:00:00.000Z'),
          leaseToken: null,
          leaseExpiresAt: null,
          leasedFromStatus: null,
          lastErrorCode: null,
          lastError: null,
          lastStatusCode: null,
        },
      });
      await tx.messageRetentionCandidate.update({
        where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
        data: {
          status: 'pending',
          completedAt: null,
          outcomeCode: null,
          reconcileAfter: null,
          nextAttemptAt: now,
        },
      });
      await tx.messageRetentionPolicy.update({
        where: { chatId: input.chatId },
        data: {
          pendingCount: { increment: 1 },
          skippedCount: { decrement: 1 },
          nextRunAt: now,
          lastStatus: 'running',
        },
      });
      await tx.messageRetentionQuota.update({
        where: { shard: policy.quotaShard },
        data: { pendingCount: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          chatId: input.chatId,
          actorUserId: input.actorUserId,
          action: 'SAFETY_DESK_RETRY_MESSAGE_RETENTION',
          payload: {
            messageId: input.messageId,
            intentId: input.intentId,
            activationId: input.activationId,
            revision: input.expectedRevision,
            previousStatus: intent.status,
            previousErrorCode: intent.lastErrorCode,
            expectedIntentUpdatedAt: input.expectedIntentUpdatedAt.toISOString(),
            expectedAttemptCount: input.expectedAttemptCount,
          },
        },
      });
      return true;
    });
  }

  async settleRemovedMessage(
    tx: Prisma.TransactionClient,
    input: { chatId: string; messageId: string },
  ): Promise<boolean> {
    if (!/^-[1-9]\d*$/.test(input.chatId) || !input.messageId) return false;
    const initial = await tx.messageRetentionCandidate.findUnique({
      where: { chatId_messageId: input },
    });
    if (!initial || initial.status === 'deleted') return false;
    if (initial.intentId)
      await tx.$queryRaw`SELECT "id" FROM "moderation_delete_intents" WHERE "id" = ${initial.intentId} FOR UPDATE`;
    const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: input.chatId },
    });
    await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${policy.quotaShard} FOR UPDATE`;
    await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${input.chatId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "message_id" FROM "message_retention_candidates" WHERE "chat_id" = ${input.chatId} AND "message_id" = ${input.messageId} FOR UPDATE`;
    const current = await tx.messageRetentionCandidate.findUnique({
      where: { chatId_messageId: input },
    });
    if (!current || current.status === 'deleted') return false;
    // FLAG: Retry the authenticated receipt transaction if a producer attached a
    // different intent while locks were acquired; never invert intent/policy locks.
    if (current.intentId !== initial.intentId) throw new Error('Retention receipt binding changed');
    const now = new Date();
    const active = ['pending', 'retry'].includes(current.status);
    await tx.messageRetentionCandidate.update({
      where: { chatId_messageId: input },
      data: {
        status: 'deleted',
        completedAt: now,
        outcomeCode: 'deleted',
        reconcileAfter: null,
      },
    });
    await tx.messageRetentionPolicy.update({
      where: { chatId: input.chatId },
      data: {
        ...(active ? { pendingCount: { decrement: 1 } } : { skippedCount: { decrement: 1 } }),
        deletedCount: { increment: 1 },
      },
    });
    if (active)
      await tx.messageRetentionQuota.update({
        where: { shard: policy.quotaShard },
        data: { pendingCount: { decrement: 1 } },
      });
    if (current.intentId)
      await tx.moderationDeleteIntent.updateMany({
        where: {
          id: current.intentId,
          retentionOwned: true,
          chatId: input.chatId,
          messageId: input.messageId,
          status: { notIn: ['SUCCEEDED', 'ALREADY_ABSENT'] },
        },
        data: {
          status: 'ALREADY_ABSENT',
          completedAt: now,
          leaseToken: null,
          leaseExpiresAt: null,
          leasedFromStatus: null,
          lastErrorCode: 'retention_message_removed',
          lastError: null,
        },
      });
    return true;
  }

  async settleReconciliation(
    candidate: MessageRetentionCandidate,
    outcome: 'deleted' | 'protected' | 'terminal_review' | 'cancelled',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // FLAG: The receipt proof and settlement share one transaction. An execution
      // claim cannot add a dispatch marker between a read and clearing reconciliation.
      if (candidate.intentId)
        await tx.$queryRaw`SELECT "id" FROM "moderation_delete_intents" WHERE "id" = ${candidate.intentId} FOR UPDATE`;
      const initial = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: candidate.chatId },
      });
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${candidate.chatId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "message_id" FROM "message_retention_candidates" WHERE "chat_id" = ${candidate.chatId} AND "message_id" = ${candidate.messageId} FOR UPDATE`;
      const current = await tx.messageRetentionCandidate.findUnique({
        where: { chatId_messageId: { chatId: candidate.chatId, messageId: candidate.messageId } },
      });
      if (!current || current.intentId !== candidate.intentId || !current.reconcileAfter) return;
      const receipt = candidate.intentId
        ? await tx.moderationDeleteIntent.findUnique({
            where: { id: candidate.intentId },
            select: {
              retentionOwned: true,
              status: true,
              leaseExpiresAt: true,
              deleteDispatchStartedAt: true,
              deleteDispatchStartedBotId: true,
              remoteDeleteSucceededAt: true,
              remoteDeleteSucceededBotId: true,
            },
          })
        : null;
      const settledOutcome =
        receipt?.status === 'SUCCEEDED' || receipt?.status === 'ALREADY_ABSENT'
          ? 'deleted'
          : outcome;
      const now = new Date();
      const active = ['pending', 'retry'].includes(current.status);
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: candidate.chatId },
      });
      const hasMutationEvidence = Boolean(
        receipt?.deleteDispatchStartedAt ||
        receipt?.deleteDispatchStartedBotId ||
        receipt?.remoteDeleteSucceededAt ||
        receipt?.remoteDeleteSucceededBotId,
      );
      const hasLiveLease =
        receipt?.status === 'IN_PROGRESS' &&
        (!receipt.leaseExpiresAt || receipt.leaseExpiresAt > now);
      if (
        settledOutcome !== 'deleted' &&
        ((receipt?.retentionOwned && (hasMutationEvidence || hasLiveLease)) ||
          (active &&
            settledOutcome === 'cancelled' &&
            policy.enabled &&
            policy.activationId === current.activationId))
      ) {
        await tx.messageRetentionCandidate.updateMany({
          where: {
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            intentId: candidate.intentId,
            activationId: current.activationId,
            status: current.status,
            reconcileAfter: { not: null },
          },
          data: { reconcileAfter: new Date(now.getTime() + MESSAGE_RETENTION_RECOVERY_RETRY_MS) },
        });
        return;
      }
      const changed = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          intentId: candidate.intentId,
          activationId: current.activationId,
          status: current.status,
          reconcileAfter: { not: null },
        },
        data: {
          status:
            settledOutcome === 'deleted'
              ? 'deleted'
              : active
                ? settledOutcome === 'cancelled'
                  ? 'cancelled'
                  : 'skipped'
                : current.status,
          outcomeCode: settledOutcome,
          reconcileAfter: null,
          completedAt: now,
        },
      });
      if (!changed.count) return;
      if (active) {
        await tx.messageRetentionPolicy.update({
          where: { chatId: candidate.chatId },
          data: {
            pendingCount: { decrement: 1 },
            ...(settledOutcome === 'deleted'
              ? { deletedCount: { increment: 1 } }
              : { skippedCount: { increment: 1 } }),
          },
        });
        await tx.messageRetentionQuota.update({
          where: { shard: policy.quotaShard },
          data: { pendingCount: { decrement: 1 } },
        });
      } else if (settledOutcome === 'deleted' && current.status !== 'deleted')
        await tx.messageRetentionPolicy.update({
          where: { chatId: candidate.chatId },
          data: { deletedCount: { increment: 1 }, skippedCount: { decrement: 1 } },
        });
    });
  }

  async diagnostics(chatId: string): Promise<RetentionDiagnostics> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        enabled: boolean;
        hours: number;
        pendingSource: Date | null;
        retrySource: Date | null;
        hasTerminalReview: boolean;
        hasWorkerError: boolean;
        hasWaitingAccess: boolean;
        hasUnresolvedReceipt: boolean;
        hasDeferred: boolean;
        hasLegacyRetry: boolean;
        lastStatus: string;
      }>
    >(Prisma.sql`
      SELECT p."enabled", p."hours", p."last_status" AS "lastStatus",
        (SELECT c."source_at" FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."status" = 'pending'
            AND c."activation_id" = p."activation_id"
          ORDER BY c."source_at", c."message_id" LIMIT 1) AS "pendingSource",
        (SELECT c."source_at" FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."status" = 'retry'
            AND c."activation_id" = p."activation_id"
          ORDER BY c."source_at", c."message_id" LIMIT 1) AS "retrySource",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" = 'terminal_review') AS "hasTerminalReview",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" = 'worker_error') AS "hasWorkerError",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" = 'waiting_access') AS "hasWaitingAccess",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" = 'reconciliation') AS "hasUnresolvedReceipt",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" = 'deferred') AS "hasDeferred",
        EXISTS (SELECT 1 FROM "message_retention_candidates" c
          WHERE c."chat_id" = p."chat_id" AND c."outcome_code" IS NULL AND c."status" = 'retry') AS "hasLegacyRetry"
      FROM "message_retention_policies" p WHERE p."chat_id" = ${chatId}
    `);
    const row = rows[0];
    const outcomes = [
      row?.hasTerminalReview ? 'terminal_review' : '',
      row?.hasWorkerError ? 'worker_error' : '',
      row?.hasWaitingAccess ? 'waiting_access' : '',
      row?.hasUnresolvedReceipt ? 'reconciliation' : '',
      row?.hasDeferred ? 'deferred' : '',
    ];
    const source = Math.min(
      row?.pendingSource?.getTime() ?? Infinity,
      row?.retrySource?.getTime() ?? Infinity,
    );
    return {
      hasTerminalReview: row?.hasTerminalReview ?? false,
      hasUnresolvedReceipt: row?.hasUnresolvedReceipt ?? false,
      oldestDueAt:
        row?.enabled && Number.isFinite(source) ? new Date(source + row.hours * 3_600_000) : null,
      blockerStatus:
        retentionBlockerStatus(outcomes) ??
        (row?.hasLegacyRetry && ['error', 'no_access', 'delayed'].includes(row.lastStatus)
          ? (row.lastStatus as Exclude<RetentionBlockerStatus, null>)
          : null),
    };
  }

  async updateRunStatus(chatId: string, revision: number, status: string): Promise<void> {
    const diagnostics = await this.diagnostics(chatId);
    await this.prisma.messageRetentionPolicy.updateMany({
      where: { chatId, revision },
      data: { lastStatus: diagnostics.blockerStatus ?? status },
    });
  }

  async discoverLegacyReceipts(): Promise<void> {
    if (this.discoveryComplete) return;
    this.discoveryCursor = await this.prisma.$transaction((tx) =>
      discoverRetentionReceipts(tx, this.discoveryCursor, this.discoveryBefore),
    );
    this.discoveryComplete = this.discoveryCursor === null;
  }

  async purge(): Promise<void> {
    // FLAG: Bound maintenance by both time and rows. A full page grows the budget
    // gradually, while unresolved receipts never cause a busy loop at the first page.
    const deadline = Date.now() + 2_000;
    for (let page = 0; page < 8 && Date.now() < deadline; page++) {
      this.purgeCursor = await this.prisma.$transaction((tx) =>
        purgeRetentionPage(tx, this.purgeCursor),
      );
      if (!this.purgeCursor) break;
    }
  }
}
