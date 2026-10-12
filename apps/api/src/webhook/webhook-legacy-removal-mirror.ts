import { Prisma, type WebhookEvent } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';

const marker =
  'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required';
const deferred =
  'Webhook preparation deferred: Legacy semantic execution requires exact proof recovery';

function untouchedReceipt(event: WebhookEvent): boolean {
  return (
    event.processedAt === null &&
    event.queueName === null &&
    event.queuedAt === null &&
    event.enqueueAttempts === 0 &&
    event.timeoutQuarantineExpiresAt === null &&
    event.legacyDispositionId === null &&
    event.legacyDispositionReceiptId === null &&
    event.sourceDispositionId === null &&
    event.sourceDispositionReceiptId === null
  );
}

function removal(event: WebhookEvent, semanticKey: string): boolean {
  const payload = event.normalizedPayload as { type?: unknown } | null;
  return (
    (payload?.type === 'user_removed' || payload?.type === 'message_removed') &&
    event.semanticKey === semanticKey &&
    buildWebhookSemanticEventKey(event.normalizedPayload) === semanticKey
  );
}

// FLAG: Propagate the existing *pending* no-replay quarantine to one never-enqueued
// removal mirror. This is neither completion nor abandonment: preserve both payloads,
// the canonical claim, every effect receipt, and the marker that prevents retention/replay.
// Only nonordered user/message removals qualify. Prepared/started claims and
// independently owned mirrors retain their original fences.
export async function quarantineLegacyRemovalMirror(
  prisma: PrismaService,
  input: { mirrorId: string; ownerId: string; claimId: string; semanticKey: string },
): Promise<boolean> {
  if (input.mirrorId === input.ownerId) return false;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '250ms'`);
      await tx.$executeRaw(Prisma.sql`SET LOCAL statement_timeout = '1000ms'`);
      // FLAG: Match completion's claim-before-receipt lock order. Receipt locks prevent
      // concurrent FK-linked admission; re-read every authority field after locking.
      await tx.$queryRaw(Prisma.sql`SELECT id FROM webhook_execution_claims
      WHERE id = ${input.claimId} FOR UPDATE`);
      const claim = await tx.webhookExecutionClaim.findUnique({ where: { id: input.claimId } });
      if (
        !claim ||
        claim.kind !== 'EXECUTION' ||
        claim.semanticKey !== input.semanticKey ||
        claim.webhookEventId !== input.ownerId ||
        !claim.enforced ||
        claim.status !== 'PENDING' ||
        claim.preparedAt !== null ||
        claim.businessStartedAt !== null ||
        claim.completedAt !== null ||
        claim.leaseToken !== null ||
        claim.leaseExpiresAt !== null ||
        claim.commandResult !== null
      )
        return false;
      await tx.$queryRaw(Prisma.sql`SELECT id FROM webhook_events
      WHERE id IN (${input.ownerId}, ${input.mirrorId}) ORDER BY id FOR UPDATE`);
      const owner = await tx.webhookEvent.findUnique({ where: { id: input.ownerId } });
      const mirror = await tx.webhookEvent.findUnique({ where: { id: input.mirrorId } });
      if (
        !owner ||
        !mirror ||
        !untouchedReceipt(owner) ||
        !untouchedReceipt(mirror) ||
        !removal(owner, input.semanticKey) ||
        !removal(mirror, input.semanticKey) ||
        owner.status !== 'FAILED' ||
        owner.errorMessage !== marker ||
        owner.nextEnqueueAt !== null ||
        mirror.status !== 'RECEIVED' ||
        (mirror.errorMessage !== null && mirror.errorMessage !== deferred) ||
        owner.createdAt.getTime() > mirror.createdAt.getTime()
      )
        return false;
      const independentClaim = await tx.webhookExecutionClaim.findFirst({
        where: { webhookEventId: mirror.id },
        select: { id: true },
      });
      if (independentClaim) return false;
      const dispositions = await Promise.all([
        tx.webhookLegacyReceiptDisposition.findUnique({
          where: { receiptId: mirror.id },
          select: { receiptId: true },
        }),
        tx.webhookSourceReceiptDisposition.findUnique({
          where: { receiptId: mirror.id },
          select: { receiptId: true },
        }),
      ]);
      if (dispositions.some(Boolean)) return false;
      const changed = await tx.webhookEvent.updateMany({
        where: {
          id: mirror.id,
          status: 'RECEIVED',
          errorMessage: mirror.errorMessage,
          nextEnqueueAt: mirror.nextEnqueueAt,
          processedAt: null,
        },
        data: { status: 'FAILED', nextEnqueueAt: null, errorMessage: marker },
      });
      return changed.count === 1;
    },
    { maxWait: 1000, timeout: 3000 },
  );
}
