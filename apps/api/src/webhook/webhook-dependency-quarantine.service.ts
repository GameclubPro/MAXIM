import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { Prisma, WebhookStatus, type WebhookEvent } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import { hasWebhookReplayFence } from './webhook-execution-deadline';
import { buildGroupCommandKey } from '../common/group-command-key';
import { readLegacyReceiptClaims } from './webhook-legacy-claims';
import {
  isPendingWebhookTimeoutQuarantineMessage,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from './webhook-timeout-quarantine';

// FLAG: Writers require compatible readers. Deploy under the mandatory stopped-worker
// queue fence, with enqueue recreated last; retain the compatible writer-disabled image.
export const WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED = true;

export const WEBHOOK_QUARANTINE_BATCH_SIZE = 16;
export const WEBHOOK_QUARANTINE_RECHECK_MS = 60_000;

function orderedChat(event: WebhookEvent): string | null {
  if (
    !event.normalizedPayload ||
    typeof event.normalizedPayload !== 'object' ||
    Array.isArray(event.normalizedPayload)
  )
    return null;
  const payload = event.normalizedPayload as { type?: unknown; message?: { chatId?: unknown } };
  if (payload.type !== 'message_created' && payload.type !== 'message_edited') return null;
  const chatId = payload.message?.chatId;
  return typeof chatId === 'string' && chatId.trim() === chatId && chatId.length > 0
    ? chatId
    : null;
}

function precedes(blocker: WebhookEvent, receipt: WebhookEvent): boolean {
  return (
    blocker.createdAt.getTime() < receipt.createdAt.getTime() ||
    (blocker.createdAt.getTime() === receipt.createdAt.getTime() && blocker.id < receipt.id)
  );
}

@Injectable()
export class WebhookDependencyQuarantineService {
  private mirrorHeadOffset = 0;
  private readonly logger = new Logger(WebhookDependencyQuarantineService.name);
  private readonly writesEnabled = WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED;
  private readonly publisherBotId: string;
  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: config.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
  }

  // FLAG: This is scheduling isolation only. The uncertain source/claim/remote journals
  // remain untouched, and its ordering fence continues to deny dependent business starts.
  async parkSuccessors(
    blockerId: string,
    receiptIds: readonly string[],
    anchorId = blockerId,
  ): Promise<number> {
    if (!this.writesEnabled) return 0;
    let parked = 0;
    const dispatchDeadline = performance.now() + 500;
    for (const receiptId of [...new Set(receiptIds)].slice(0, WEBHOOK_QUARANTINE_BATCH_SIZE)) {
      if (performance.now() >= dispatchDeadline) break;
      if (receiptId === blockerId) continue;
      parked += Number(await this.parkOne(blockerId, receiptId, anchorId));
    }
    return parked;
  }

  async findQuarantinedMirrorOwners(headIds: readonly string[]): Promise<Map<string, string>> {
    if (!this.writesEnabled || !headIds.length) return new Map();
    const offset = this.mirrorHeadOffset % headIds.length;
    const selected = [...headIds.slice(offset), ...headIds.slice(0, offset)].slice(0, 64);
    this.mirrorHeadOffset = (offset + selected.length) % headIds.length;
    // FLAG: Exact indexed claim/owner probes follow a bounded physical-head selection.
    // An earlier receiving bot can be the order anchor while another bot owns the failure.
    const rows = await this.prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL statement_timeout = '500ms'`;
          return tx.$queryRaw<Array<{ headId: string; ownerId: string }>>(Prisma.sql`
      SELECT head.id AS "headId", owner.id AS "ownerId"
      FROM (VALUES ${Prisma.join(selected.map((id) => Prisma.sql`(${id})`))}) selected(id)
      JOIN webhook_events head ON head.id = selected.id
      JOIN webhook_execution_claims claim ON claim.kind = 'EXECUTION'
        AND claim.semantic_key = head.semantic_key AND claim.enforced
        AND claim.webhook_event_id <> head.id
      JOIN webhook_events owner ON owner.id = claim.webhook_event_id
      WHERE owner.status = 'FAILED' AND owner.next_enqueue_at IS NULL
        AND (starts_with(COALESCE(owner.error_message, ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX + ':'})
          OR (claim.business_started_at IS NOT NULL AND claim.completed_at IS NULL
              AND claim.status <> 'COMPLETED'))
      `);
        },
        { maxWait: 250, timeout: 1_000 },
      )
      .catch(() => {
        this.logger.warn('Dependency quarantine mirror discovery unavailable');
        return [];
      });
    return new Map(rows.map((row) => [row.headId, row.ownerId]));
  }

  private async lockUnstartedReceipt(
    tx: Prisma.TransactionClient,
    receiptId: string,
    mirrorOwnerId?: string,
  ) {
    const snapshot = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
    if (!snapshot?.semanticKey) return null;
    // FLAG: Match business-start's claim-before-receipt order. An absent claim may be
    // inserted concurrently, but its final start must lock and reread this receipt.
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_execution_claims"
      WHERE "kind" = 'EXECUTION' AND "semantic_key" = ${snapshot.semanticKey} FOR UPDATE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "webhook_events" WHERE "id" = ${receiptId} FOR UPDATE
    `);
    const receipt = await tx.webhookEvent.findUnique({ where: { id: receiptId } });
    if (
      !receipt ||
      receipt.semanticKey !== snapshot.semanticKey ||
      receipt.semanticKey !==
        buildWebhookReceiptSemanticKey(
          receipt.normalizedPayload as MaxUpdate,
          this.publisherBotId,
        ) ||
      receipt.processedAt !== null ||
      receipt.timeoutQuarantineExpiresAt !== null ||
      hasWebhookReplayFence(receipt)
    )
      return null;
    const claim = await tx.webhookExecutionClaim.findUnique({
      where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: receipt.semanticKey } },
    });
    // FLAG: Publisher observations retain their own receipt namespace. Parking is only
    // scheduling isolation: mismatched receiving identity or any execution claim stays
    // fenced, and no moderation claim is created, completed or borrowed for observation.
    const publisherObservation =
      (receipt.normalizedPayload as MaxUpdate).botId?.trim() === this.publisherBotId;
    if (publisherObservation && (receipt.botId !== this.publisherBotId || claim)) return null;
    // FLAG: A pristine physical mirror is not the started semantic owner. Retain that
    // owner's claim unchanged; require no activation and no independent/legacy claim.
    const pristineMirror = Boolean(
      claim?.enforced &&
      claim.webhookEventId === mirrorOwnerId &&
      claim.webhookEventId !== receipt.id &&
      receipt.queueName === null &&
      receipt.queuedAt === null &&
      receipt.enqueueAttempts === 0 &&
      receipt.legacyDispositionId === null &&
      receipt.sourceDispositionId === null,
    );
    if (pristineMirror) {
      const message = (
        receipt.normalizedPayload as { message?: { chatId?: string; messageId?: string } }
      ).message;
      if (!message?.chatId || !message.messageId) return null;
      const evidence = await readLegacyReceiptClaims(
        tx,
        receipt.id,
        receipt.semanticKey,
        buildGroupCommandKey(message.chatId, message.messageId),
      );
      if (!evidence || evidence.some((row) => row.id !== claim!.id)) return null;
    }
    if (
      claim &&
      !pristineMirror &&
      (!claim.enforced ||
        claim.businessStartedAt !== null ||
        claim.completedAt !== null ||
        claim.status === 'COMPLETED' ||
        claim.leaseToken !== null ||
        claim.leaseExpiresAt !== null)
    )
      return null;
    // FLAG: Independent command/legacy claims are evidence too; do not infer their absence from
    // the canonical semantic claim. This is an indexed exact-receipt probe, not a history scan.
    const otherClaim = await tx.webhookExecutionClaim.findFirst({
      where: { webhookEventId: receipt.id, ...(claim ? { id: { not: claim.id } } : {}) },
      select: { id: true },
    });
    if (otherClaim) return null;
    return receipt;
  }

  private async parkOne(blockerId: string, receiptId: string, anchorId: string): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        const receipt = await this.lockUnstartedReceipt(tx, receiptId, blockerId);
        if (!receipt || (receipt.status !== 'RECEIVED' && receipt.status !== 'QUEUED'))
          return false;
        const chatId = orderedChat(receipt);
        if (!chatId || !receipt.executionDeadlineAt) return false;
        const blocker = await tx.webhookEvent.findUnique({ where: { id: blockerId } });
        const anchor =
          anchorId === blockerId
            ? blocker
            : await tx.webhookEvent.findUnique({ where: { id: anchorId } });
        if (
          !blocker ||
          blocker.status !== 'FAILED' ||
          blocker.nextEnqueueAt !== null ||
          orderedChat(blocker) !== chatId ||
          !anchor ||
          orderedChat(anchor) !== chatId ||
          anchor.semanticKey !== blocker.semanticKey ||
          buildWebhookSemanticEventKey(anchor.normalizedPayload) !== blocker.semanticKey ||
          (blocker.semanticKey !== receipt.semanticKey && !precedes(anchor, receipt)) ||
          blocker.processedAt !== null ||
          blocker.legacyDispositionId !== null ||
          blocker.sourceDispositionId !== null
        )
          return false;
        if (!isPendingWebhookTimeoutQuarantineMessage(blocker.errorMessage)) {
          // FLAG: A failed started owner can have an arbitrary persistence/transport error.
          // Its exact unfinished authority, never error text alone, fences pristine copies.
          // Ordinary terminal FAILED owners are not chat-order heads. Isolate only their
          // semantic mirrors; do not invent a dependency for neighboring messages.
          if (blocker.semanticKey !== receipt.semanticKey) return false;
          const ownerClaim = await tx.webhookExecutionClaim.findUnique({
            where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: blocker.semanticKey! } },
          });
          if (
            !ownerClaim?.enforced ||
            ownerClaim.webhookEventId !== blocker.id ||
            ownerClaim.businessStartedAt === null ||
            ownerClaim.completedAt !== null ||
            ownerClaim.status === 'COMPLETED'
          )
            return false;
        }
        const existing = await tx.webhookDependencyQuarantine.findUnique({
          where: { receiptId_blockerId: { receiptId, blockerId } },
        });
        // FLAG: A released receipt may encounter another unknown predecessor. Each pair has
        // its own immutable attribution, so a second incident never erases the first.
        if (existing) return false;
        await tx.webhookDependencyQuarantine.create({
          data: {
            receiptId,
            blockerId,
            anchorId,
            chatId,
            originalStatus: receipt.status,
            deadlineAt: receipt.executionDeadlineAt,
            nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS),
          },
        });
        const changed = await tx.webhookEvent.updateMany({
          where: { id: receipt.id, status: receipt.status, semanticKey: receipt.semanticKey },
          data: { status: WebhookStatus.QUARANTINED },
        });
        if (changed.count !== 1) throw new Error('Dependency quarantine receipt CAS changed');
        return true;
      },
      { timeout: 2_000, maxWait: 1_000 },
    );
  }

  async reconcileDue(): Promise<{ inspected: number; released: number; expired: number }> {
    // FLAG: Rotate unresolved work by a persisted due index. Old unknown outcomes must
    // neither monopolize every pass nor generate a BullMQ retry per dependent message.
    const due = await this.prisma.webhookDependencyQuarantine.findMany({
      where: { state: 'WAITING', nextCheckAt: { lte: new Date() } },
      orderBy: [{ nextCheckAt: 'asc' }, { receiptId: 'asc' }, { blockerId: 'asc' }],
      take: WEBHOOK_QUARANTINE_BATCH_SIZE,
      select: { receiptId: true, blockerId: true, nextCheckAt: true },
    });
    const result = { inspected: due.length, released: 0, expired: 0 };
    for (const item of due) {
      const outcome = await this.prisma
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
            const owned = await tx.webhookDependencyQuarantine.updateMany({
              where: {
                receiptId: item.receiptId,
                blockerId: item.blockerId,
                state: 'WAITING',
                nextCheckAt: item.nextCheckAt,
              },
              data: { nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS) },
            });
            if (owned.count !== 1) return 'waiting';
            const entry = await tx.webhookDependencyQuarantine.findUniqueOrThrow({
              where: {
                receiptId_blockerId: { receiptId: item.receiptId, blockerId: item.blockerId },
              },
            });
            const receipt = await this.lockUnstartedReceipt(tx, item.receiptId, entry.blockerId);
            if (!receipt || receipt.status !== WebhookStatus.QUARANTINED) return 'waiting';
            const anchor = await tx.webhookEvent.findUnique({ where: { id: entry.anchorId } });
            const now = new Date();
            if (
              entry.deadlineAt <= now ||
              (receipt.executionDeadlineAt && receipt.executionDeadlineAt <= now)
            ) {
              await tx.webhookDependencyQuarantine.update({
                where: {
                  receiptId_blockerId: { receiptId: receipt.id, blockerId: entry.blockerId },
                },
                data: { state: 'EXPIRED', resolvedAt: now },
              });
              return 'expired';
            }
            const blocker = await tx.webhookEvent.findUnique({ where: { id: entry.blockerId } });
            if (
              !blocker ||
              blocker.status !== 'PROCESSED' ||
              !blocker.processedAt ||
              blocker.errorMessage !== null ||
              blocker.nextEnqueueAt !== null ||
              blocker.timeoutQuarantineExpiresAt !== null ||
              !blocker.semanticKey ||
              blocker.semanticKey !== buildWebhookSemanticEventKey(blocker.normalizedPayload) ||
              orderedChat(blocker) !== entry.chatId ||
              orderedChat(receipt) !== entry.chatId ||
              !anchor ||
              orderedChat(anchor) !== entry.chatId ||
              anchor.semanticKey !== blocker.semanticKey ||
              buildWebhookSemanticEventKey(anchor.normalizedPayload) !== blocker.semanticKey ||
              (receipt.semanticKey !== blocker.semanticKey && !precedes(anchor, receipt)) ||
              !receipt.executionDeadlineAt ||
              receipt.executionDeadlineAt.getTime() !== entry.deadlineAt.getTime()
            )
              return 'waiting';
            const completed = await tx.webhookExecutionClaim.findUnique({
              where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: blocker.semanticKey } },
            });
            if (
              !completed ||
              !completed.enforced ||
              completed.webhookEventId !== blocker.id ||
              completed.status !== 'COMPLETED' ||
              !completed.preparedAt ||
              !completed.completedAt ||
              completed.leaseToken !== null ||
              completed.leaseExpiresAt !== null
            )
              return 'waiting';
            await tx.webhookEvent.update({
              where: { id: receipt.id },
              data: {
                status: WebhookStatus.RECEIVED,
                queueName: null,
                nextEnqueueAt: now,
              },
            });
            await tx.webhookDependencyQuarantine.update({
              where: { receiptId_blockerId: { receiptId: receipt.id, blockerId: entry.blockerId } },
              data: {
                state: 'RELEASED',
                resolvedAt: now,
              },
            });
            return 'released';
          },
          { timeout: 2_000, maxWait: 1_000 },
        )
        .catch(async () => {
          await this.prisma.webhookDependencyQuarantine
            .updateMany({
              where: {
                receiptId: item.receiptId,
                blockerId: item.blockerId,
                state: 'WAITING',
                nextCheckAt: item.nextCheckAt,
              },
              data: { nextCheckAt: new Date(Date.now() + WEBHOOK_QUARANTINE_RECHECK_MS) },
            })
            .catch(() => {
              // FLAG: A failed scheduling hint retains the original due row. It cannot
              // abort this bounded batch or certify that the receipt was recovered.
              this.logger.warn('Dependency quarantine retry hint unavailable');
            });
          this.logger.warn('Dependency quarantine item deferred after persistence failure');
          return 'waiting';
        });
      if (outcome === 'released') result.released += 1;
      if (outcome === 'expired') result.expired += 1;
    }
    return result;
  }
}
