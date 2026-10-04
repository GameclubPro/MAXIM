import { Prisma } from '../../prisma/prisma-client';
import type { ModerationMessageActionClaimData } from '../moderation-message-action-claim';
import { duplicateRevocationKey } from './message-duplicate-authorization.service';
import type { MessageDuplicateBinding } from './message-duplicate-state';

export type DuplicateCleanupBinding = Pick<
  MessageDuplicateBinding,
  'messageId' | 'senderId' | 'eventTimestampMs' | 'authorization'
>;

export type DuplicateClaimRelease = {
  claim: ModerationMessageActionClaimData;
  owner?: { id: string; createdAt: Date };
  binding: DuplicateCleanupBinding;
};

export function assertDuplicateCleanupBinding(
  claim: ModerationMessageActionClaimData,
  binding: DuplicateCleanupBinding,
): void {
  const authority = binding.authorization;
  if (
    claim.ruleCode !== 'DUPLICATE_MESSAGE_ACTION' ||
    claim.updateType !== 'message_action' ||
    claim.messageId !== binding.messageId ||
    claim.userId !== binding.senderId ||
    !authority ||
    ![binding.eventTimestampMs, authority.eventTimestampMs, authority.deadlineAtMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    authority.deadlineAtMs > authority.eventTimestampMs + 600_000 ||
    authority.deadlineAtMs <= authority.eventTimestampMs
  )
    throw new Error('Invalid duplicate cleanup binding');
}

// FLAG: Called inside the same serializable transaction as the preclaim. A retry
// never moves this obligation to a later deadline or another authorization.
export async function registerDuplicateClaimCleanup(
  tx: Prisma.TransactionClient,
  claim: ModerationMessageActionClaimData,
  binding: DuplicateCleanupBinding,
): Promise<boolean> {
  assertDuplicateCleanupBinding(claim, binding);
  const owner = await tx.moderationViolationMessageClaim.findUniqueOrThrow({
    where: { messageActionKey: claim.messageActionKey },
    select: { id: true, createdAt: true },
  });
  const deadlineAt = new Date(binding.authorization!.deadlineAtMs);
  if (owner.createdAt > deadlineAt) return false;
  const data = {
    claimId: owner.id,
    claimCreatedAt: owner.createdAt,
    eventTimestampMs: BigInt(binding.eventTimestampMs),
    authorizationTimestampMs: BigInt(binding.authorization!.eventTimestampMs),
    deadlineAt,
  };
  await tx.messageDuplicateClaimCleanup.createMany({ data: [data], skipDuplicates: true });
  const existing = await tx.messageDuplicateClaimCleanup.findUniqueOrThrow({
    where: { claimId: owner.id },
  });
  return (
    existing.claimCreatedAt.getTime() === data.claimCreatedAt.getTime() &&
    existing.eventTimestampMs === data.eventTimestampMs &&
    existing.authorizationTimestampMs === data.authorizationTimestampMs &&
    existing.deadlineAt.getTime() === data.deadlineAt.getTime()
  );
}

// FLAG: The caller must use a serializable transaction with retry, shared with
// intent handoff. Reads followed by a plain transaction can race materialization.
export async function releaseUnusedDuplicateClaim(
  tx: Prisma.TransactionClient,
  params: DuplicateClaimRelease,
): Promise<boolean> {
  const { claim, binding } = params;
  const intent = await tx.moderationDeleteIntent.findUnique({
    where: { chatId_messageId: { chatId: claim.chatId, messageId: claim.messageId } },
    select: { id: true },
  });
  const event = await tx.moderationEvent.findFirst({
    where: { chatId: claim.chatId, messageId: claim.messageId },
    select: { id: true },
  });
  // The existing exact chat/action/message index also protects a surviving receipt
  // if its older intent/event has already been retained away.
  const receipt = await tx.maxActionLedgerEntry.findFirst({
    where: { chatId: claim.chatId, actionType: 'DELETE_MESSAGE', messageId: claim.messageId },
    select: { id: true },
  });
  if (intent || event || receipt) return false;
  const released = await tx.moderationViolationMessageClaim.updateMany({
    where: {
      ...claim,
      ...(params.owner ? { id: params.owner.id } : {}),
      createdAt: {
        lte: new Date(binding.authorization!.deadlineAtMs),
        ...(params.owner ? { equals: params.owner.createdAt } : {}),
      },
    },
    data: { messageActionKey: null },
  });
  if (!released.count) return false;
  // FLAG: Keep the owner tombstone and atomically revoke both exact events. An
  // interrupted old worker must never regain positive action authority.
  await tx.moderationViolationMessageClaim.createMany({
    data: [...new Set([binding.eventTimestampMs, binding.authorization!.eventTimestampMs])].map(
      (eventTimestampMs) => ({
        dedupeKey: duplicateRevocationKey(claim.chatId, claim.messageId, eventTimestampMs),
        messageActionKey: null,
        chatId: claim.chatId,
        userId: claim.userId,
        messageId: claim.messageId,
        ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED',
        updateType: 'message_duplicate_authorization',
      }),
    ),
    skipDuplicates: true,
  });
  await tx.messageDuplicateClaimCleanup.deleteMany({
    where: { claim: { dedupeKey: claim.dedupeKey, messageActionKey: null } },
  });
  return true;
}

export async function reconcileDuplicateClaimCleanup(
  tx: Prisma.TransactionClient,
  claimId: string,
  dueAt: Date,
): Promise<boolean> {
  const locked = await tx.$queryRaw<Array<{ claimId: string }>>(Prisma.sql`
    SELECT "claim_id" AS "claimId" FROM "message_duplicate_claim_cleanup"
    WHERE "claim_id" = ${claimId} AND "deadline_at" <= ${dueAt}
    FOR UPDATE SKIP LOCKED
  `);
  if (!locked.length) return false;
  const obligation = await tx.messageDuplicateClaimCleanup.findUniqueOrThrow({
    where: { claimId },
    include: { claim: true },
  });
  const { claim } = obligation;
  let released = false;
  if (
    claim.messageActionKey &&
    claim.ruleCode === 'DUPLICATE_MESSAGE_ACTION' &&
    claim.updateType === 'message_action' &&
    claim.createdAt.getTime() === obligation.claimCreatedAt.getTime()
  ) {
    released = await releaseUnusedDuplicateClaim(tx, {
      claim: { ...claim, messageActionKey: claim.messageActionKey, updateType: 'message_action' },
      owner: { id: claim.id, createdAt: claim.createdAt },
      binding: {
        messageId: claim.messageId,
        senderId: claim.userId,
        eventTimestampMs: Number(obligation.eventTimestampMs),
        authorization: {
          eventTimestampMs: Number(obligation.authorizationTimestampMs),
          deadlineAtMs: obligation.deadlineAt.getTime(),
        },
      },
    });
  }
  // A materialized owner is now owned by intent/receipt recovery. Removing only
  // the obligation keeps its claim intact and prevents a retained-history scan.
  await tx.messageDuplicateClaimCleanup.deleteMany({ where: { claimId } });
  return released;
}
