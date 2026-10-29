import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MessageRetentionSummary } from '@maxim/contracts/settings';
import {
  Prisma,
  type MessageRetentionCandidate,
  type MessageRetentionPolicy,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { purgeRetentionPage, type RetentionPurgeCursor } from './message-retention-purge';
import { discoverRetentionReceipts } from './message-retention-recovery';
import { retireTransferredChat } from './eraser-legacy-retirement';
import {
  MESSAGE_RETENTION_RECOVERY_RETRY_MS,
  retentionBlockerStatus,
  type RetentionBlockerStatus,
} from './message-retention.policy';

// FLAG: Legacy records remain readable, but Major never acquires age-based DELETE authority.
export const LEGACY_RETENTION_EXECUTION_RETIRED = true;

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
  private transferCursor = '';
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get mode(): string {
    return this.config.get<string>('MESSAGE_RETENTION_MODE', 'off');
  }
  allows(_chatId: string, _mutation = false): boolean {
    return false;
  }

  workSchedulingFilter(): Prisma.MessageRetentionPolicyWhereInput {
    return {
      OR: [
        { enabled: false, pendingCount: { gt: 0 } },
        // FLAG: This admits one DB-only visit so ended generations can release credit.
        // A current enabled generation cannot be processed or rescheduled by age.
        { enabled: true, candidates: { some: { status: { in: ['pending', 'retry'] } } } },
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
      status: policy?.enabled ? (diagnostics?.blockerStatus ?? 'paused') : 'off',
    };
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

  async dueInactiveCandidates(
    policy: MessageRetentionPolicy,
  ): Promise<MessageRetentionCandidate[]> {
    if (!policy.enabled)
      return this.prisma.messageRetentionCandidate.findMany({
        where: { chatId: policy.chatId, status: { in: ['pending', 'retry'] } },
        orderBy: [{ messageId: 'asc' }],
        take: 100,
      });
    // FLAG: Maintenance visits ended activations only; current enabled history stays untouched.
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
    return [];
  }

  async scheduleNext(chatId: string, options: { continueInactive?: boolean } = {}): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE`;
      const policy = await tx.messageRetentionPolicy.findUniqueOrThrow({ where: { chatId } });
      const receipt = await tx.messageRetentionCandidate.findFirst({
        where: { chatId, reconcileAfter: { not: null } },
        orderBy: [{ reconcileAfter: 'asc' }, { messageId: 'asc' }],
        select: { reconcileAfter: true },
      });
      const times = [receipt?.reconcileAfter?.getTime() ?? Infinity];
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

  async discoverLegacyReceipts(): Promise<void> {
    if (this.discoveryComplete) return;
    this.discoveryCursor = await this.prisma.$transaction((tx) =>
      discoverRetentionReceipts(tx, this.discoveryCursor, this.discoveryBefore),
    );
    this.discoveryComplete = this.discoveryCursor === null;
  }

  async retireTransferredCandidates(): Promise<void> {
    const bindings = await this.prisma.$queryRaw<{ chatId: string }[]>`
      SELECT chat_id AS "chatId" FROM eraser_chat_bindings WHERE chat_id > ${this.transferCursor}
      ORDER BY chat_id LIMIT 100`;
    if (bindings.length)
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO eraser_legacy_retirement(chat_id) VALUES ${Prisma.join(bindings.map((row) => Prisma.sql`(${row.chatId})`))}
        ON CONFLICT DO NOTHING`);
    this.transferCursor = bindings.length === 100 ? bindings.at(-1)!.chatId : '';
    const due = await this.prisma.$queryRaw<{ chatId: string }[]>`
      SELECT chat_id AS "chatId" FROM eraser_legacy_retirement
      WHERE completed_at IS NULL AND next_attempt_at<=CURRENT_TIMESTAMP
      ORDER BY next_attempt_at,chat_id LIMIT 5`;
    const deadline = Date.now() + 2_000;
    for (const row of due) {
      if (Date.now() >= deadline) break;
      try {
        await this.prisma.$transaction((tx) => retireTransferredChat(tx, row.chatId), {
          timeout: 3_000,
        });
      } catch {
        // FLAG: A locked or inconsistent chat cannot starve independent transferred generations.
        await this.prisma.$executeRaw`
          WITH page AS (SELECT chat_id FROM eraser_legacy_retirement WHERE chat_id=${row.chatId} FOR UPDATE SKIP LOCKED)
          UPDATE eraser_legacy_retirement progress SET next_attempt_at=CURRENT_TIMESTAMP+INTERVAL '1 minute'
          FROM page WHERE progress.chat_id=page.chat_id`;
        this.logger.warn(
          { code: 'ERASER_LEGACY_RETIREMENT_DEFERRED' },
          'Transferred retention awaits review or retry',
        );
      }
    }
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
