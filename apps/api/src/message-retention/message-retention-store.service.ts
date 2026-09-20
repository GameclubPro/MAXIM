import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import {
  Prisma,
  type MessageRetentionCandidate,
  type MessageRetentionPolicy,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import {
  MESSAGE_RETENTION_CHAT_LIMIT,
  MESSAGE_RETENTION_DAY_MS,
  MESSAGE_RETENTION_RESUME_MS,
  MESSAGE_RETENTION_SHARD_LIMIT,
  readRetentionCapture,
  retentionModeAllows,
  type RetentionCapture,
} from './message-retention.policy';

@Injectable()
export class MessageRetentionStore {
  private readonly logger = new Logger(MessageRetentionStore.name);
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

  captureInput(update: MaxUpdate): RetentionCapture | null {
    if (!update.message || !this.allows(update.message.chatId)) return null;
    const publisher = buildPublisherBotDescriptor({
      id: this.config.get('MAX_PUBLISHER_BOT_ID'),
    }).id;
    if (update.botId === publisher) return null;
    return readRetentionCapture(update);
  }

  async capture(tx: Prisma.TransactionClient, input: RetentionCapture): Promise<void> {
    const initial = await tx.messageRetentionPolicy.findUnique({ where: { chatId: input.chatId } });
    if (!initial?.enabled || !initial.captureAfter || input.sourceAt < initial.captureAfter) return;
    const knownAdmin = await tx.managedEntityAdminMember.findFirst({
      where: {
        chatId: input.chatId,
        userId: input.authorId,
        entityType: 'CHAT',
        role: { in: ['ADMIN', 'OWNER'] },
        expiresAt: { gt: new Date() },
      },
      select: { userId: true },
    });
    if (knownAdmin) return;
    // FLAG: Every admission/settlement locks quota before policy. Duplicate receipts consume no credit.
    await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
    await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${input.chatId} FOR UPDATE`;
    const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
      where: { chatId: input.chatId },
    });
    if (!policy.enabled || !policy.captureAfter || input.sourceAt < policy.captureAfter) return;
    const existing = await tx.messageRetentionCandidate.findUnique({
      where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
      select: { messageId: true },
    });
    if (existing) return;
    const quota = await tx.messageRetentionQuota.findUniqueOrThrow({
      where: { shard: policy.quotaShard },
    });
    const now = new Date();
    if (
      quota.pausedAt ||
      policy.pausedAt ||
      quota.pendingCount >= MESSAGE_RETENTION_SHARD_LIMIT * 0.8 ||
      policy.pendingCount >= MESSAGE_RETENTION_CHAT_LIMIT * 0.8
    ) {
      if (!quota.pausedAt && quota.pendingCount >= MESSAGE_RETENTION_SHARD_LIMIT * 0.8)
        await tx.messageRetentionQuota.update({
          where: { shard: quota.shard },
          data: { pausedAt: now, healthySince: null },
        });
      await tx.messageRetentionPolicy.update({
        where: { chatId: input.chatId },
        data: {
          pausedAt: policy.pausedAt ?? now,
          healthySince: policy.pausedAt ? policy.healthySince : null,
          lastStatus: 'capacity_paused',
          skippedCount: { increment: 1 },
          nextRunAt: now,
        },
      });
      if (!policy.pausedAt) {
        await tx.auditLog.create({
          data: {
            chatId: input.chatId,
            actorUserId: 'system:message-retention',
            action: 'MESSAGE_RETENTION_INTAKE_PAUSED',
            payload: { startedAt: now.toISOString() },
          },
        });
        this.logger.warn(
          { quotaShard: policy.quotaShard },
          'Message retention intake paused by capacity guard',
        );
      }
      return;
    }
    await tx.messageRetentionCandidate.create({
      data: { ...input, activationId: policy.activationId, shadowOnly: this.mode === 'shadow' },
    });
    const dueAt = new Date(input.sourceAt.getTime() + policy.hours * 3_600_000);
    await tx.messageRetentionPolicy.update({
      where: { chatId: input.chatId },
      data: {
        pendingCount: { increment: 1 },
        nextRunAt: !policy.nextRunAt || dueAt < policy.nextRunAt ? dueAt : policy.nextRunAt,
      },
    });
    await tx.messageRetentionQuota.update({
      where: { shard: quota.shard },
      data: { pendingCount: { increment: 1 } },
    });
  }

  async finish(
    candidate: MessageRetentionCandidate,
    status: 'deleted' | 'skipped' | 'cancelled',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({
        where: { chatId: candidate.chatId },
      });
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${policy.quotaShard} FOR UPDATE`;
      const changed = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          status: { in: ['pending', 'retry'] },
        },
        data: { status, completedAt: new Date() },
      });
      if (!changed.count) return;
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
    });
  }

  async resumeAdmission(chatId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const initial = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      await tx.$queryRaw`SELECT "shard" FROM "message_retention_quotas" WHERE "shard" = ${initial.quotaShard} FOR UPDATE`;
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const quota = await tx.messageRetentionQuota.findUniqueOrThrow({
        where: { shard: initial.quotaShard },
      });
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
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
    const cutoff = new Date(Date.now() - 7 * MESSAGE_RETENTION_DAY_MS);
    await this.prisma.$executeRaw(Prisma.sql`
      WITH expired AS (
        SELECT "chat_id", "message_id", "intent_id" FROM "message_retention_candidates"
        WHERE "completed_at" < ${cutoff}
        ORDER BY "completed_at", "chat_id", "message_id" LIMIT 500 FOR UPDATE SKIP LOCKED
      ), deleted_intents AS (
        DELETE FROM "moderation_delete_intents" intent USING expired e
        WHERE intent."id" = e."intent_id" AND intent."retention_owned" = TRUE
          AND (
            intent."status" IN ('SUCCEEDED', 'ALREADY_ABSENT')
            OR (
              intent."delete_dispatch_started_at" IS NULL
              AND intent."delete_dispatch_started_bot_id" IS NULL
              AND intent."remote_delete_succeeded_at" IS NULL
              AND intent."remote_delete_succeeded_bot_id" IS NULL
              AND (intent."status" <> 'IN_PROGRESS' OR intent."lease_expires_at" < CURRENT_TIMESTAMP)
            )
          )
        RETURNING intent."id"
      ) DELETE FROM "message_retention_candidates" c USING expired e
      WHERE c."chat_id" = e."chat_id" AND c."message_id" = e."message_id"
    `);
  }
}
