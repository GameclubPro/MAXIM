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
import { retentionStatus } from './message-retention-status';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_RESUME_MS,
  MESSAGE_RETENTION_SHARD_LIMIT,
  readRetentionCapture,
  retentionModeAllows,
  type RetentionCapture,
} from './message-retention.policy';

@Injectable()
export class MessageRetentionStore {
  private readonly logger = new Logger(MessageRetentionStore.name);
  private purgeCursor: RetentionPurgeCursor | null = null;
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
    return {
      enabled: policy?.enabled ?? false,
      hours: policy?.hours === 24 ? 24 : 48,
      revision: policy?.revision ?? 0,
      status: retentionStatus(policy, this.mode, this.allows(chatId)),
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
        data: { status, completedAt: new Date() },
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
      const { count } = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId,
          status: { in: ['pending', 'retry'] },
          messageId: { in: candidates.map((candidate) => candidate.messageId) },
          ...(current.enabled ? { activationId: { not: current.activationId } } : {}),
        },
        data: { status: 'cancelled', completedAt: new Date() },
      });
      if (!count) return;
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

  async scheduleNext(chatId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      const pending = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, status: 'pending' },
        orderBy: [{ sourceAt: 'asc' }, { messageId: 'asc' }],
        select: { sourceAt: true },
      });
      const retry = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, status: 'retry' },
        orderBy: [{ nextAttemptAt: 'asc' }, { messageId: 'asc' }],
        select: { nextAttemptAt: true },
      });
      const times = [
        pending ? pending.sourceAt.getTime() + policy.hours * 3_600_000 : Infinity,
        retry?.nextAttemptAt.getTime() ?? Infinity,
        policy.pausedAt ? Date.now() + 60_000 : Infinity,
      ];
      if (!policy.enabled && policy.pendingCount > 0) times.push(Date.now());
      const next = Math.min(...times);
      await tx.messageRetentionPolicy.update({
        where: { chatId },
        data: {
          nextRunAt: Number.isFinite(next) ? new Date(Math.max(Date.now() + 30_000, next)) : null,
        },
      });
    });
  }

  async purge(): Promise<void> {
    this.purgeCursor = await this.prisma.$transaction((tx) =>
      purgeRetentionPage(tx, this.purgeCursor),
    );
  }
}
