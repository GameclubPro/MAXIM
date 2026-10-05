import { UnrecoverableError } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';

const MANUAL_COMMAND_NOTICE_TTL_MS = 5 * 60 * 1_000;

export type ManualGroupCommandNoticeAuthorityInput = {
  operationKey: string;
  lockToken: string;
  jobId: string;
  rootIntentKey?: string | null;
  chatId: string;
  actorUserId: string;
  targetUserId: string;
  commandMessageId: string;
  action: 'BAN' | 'MUTE';
  textHash: string;
  issuedAtMs?: number;
};

export class ManualGroupCommandNoticeAuthorityRejectedError extends UnrecoverableError {
  readonly code = 'manual_group_command_notice_authority_rejected';
}

function reject(): never {
  throw new ManualGroupCommandNoticeAuthorityRejectedError();
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function assertManualGroupCommandSuccessNoticeAuthority(
  prisma: PrismaService,
  maxClient: Pick<MaxClientService, 'getCurrentChatMemberAccess' | 'getChatMemberAccess'>,
  input: ManualGroupCommandNoticeAuthorityInput,
): Promise<void> {
  const request = { bypassCache: true, trafficClass: 'interactive' as const };
  // FLAG: Omit a receiver bot id: MaxClient invokes this hook in the actual selected
  // execution context. Cached or other-peer admin access cannot authorize this SEND.
  const bot = await maxClient.getCurrentChatMemberAccess(input.chatId, request);
  if (!bot.userId || (!bot.isAdmin && !bot.isOwner)) reject();
  const actor = await maxClient.getChatMemberAccess(input.chatId, input.actorUserId, request);
  if (!actor || actor.userId !== input.actorUserId || (!actor.isAdmin && !actor.isOwner)) reject();

  const notice = await prisma.manualModerationFanoutLedgerEntry.findUnique({
    where: { operationKey: input.operationKey },
  });
  const metadata = object(notice?.metadata);
  if (
    !notice ||
    notice.lockToken !== input.lockToken ||
    notice.status !== 'AMBIGUOUS' ||
    notice.jobId !== input.jobId ||
    notice.rootIntentKey !== (input.rootIntentKey ?? null) ||
    notice.sourceKind !== 'manual_group_moderation_command' ||
    notice.operation !== 'COMMAND_NOTICE_OUTCOME' ||
    notice.sourceChatId !== input.chatId ||
    notice.targetChatId !== input.chatId ||
    notice.targetUserId !== input.targetUserId ||
    notice.actorUserId !== input.actorUserId ||
    notice.logicalAction !== 'NOTICE' ||
    metadata?.outcome !== 'SUCCESS' ||
    metadata.action !== input.action ||
    metadata.commandMessageId !== input.commandMessageId ||
    metadata.textHash !== input.textHash ||
    metadata.issuedAtMs !== input.issuedAtMs
  )
    reject();

  const source = await prisma.manualModerationFanoutLedgerEntry.findFirst({
    where: {
      rootIntentKey: input.rootIntentKey ?? input.jobId,
      operation: input.action === 'BAN' ? 'COMMAND_SOURCE_BAN' : 'COMMAND_SOURCE_MUTE',
      sourceKind: 'group_command',
      sourceChatId: input.chatId,
      targetChatId: input.chatId,
      targetUserId: input.targetUserId,
      actorUserId: input.actorUserId,
      logicalAction: input.action,
      status: 'SUCCEEDED',
      moderationEventId: { not: null },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!source?.moderationEventId) reject();
  const event = await prisma.moderationEvent.findUnique({
    where: { id: source.moderationEventId },
  });
  if (
    !event ||
    event.chatId !== input.chatId ||
    event.userId !== input.targetUserId ||
    event.action !== input.action ||
    event.ruleCode !== (input.action === 'BAN' ? 'MANUAL_BAN' : 'MANUAL_MUTE') ||
    event.operator !== 'ADMIN' ||
    object(event.metadata)?.source !== 'group_command'
  )
    reject();

  const release = await prisma.moderationEvent.findFirst({
    where: {
      chatId: input.chatId,
      userId: input.targetUserId,
      ruleCode: input.action === 'BAN' ? 'MANUAL_UNBAN' : 'MANUAL_UNMUTE',
      createdAt: { gte: event.createdAt },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  // FLAG: The durable creation times and original queue issuance bound retries;
  // final SQL/route waits never create a fresh notice lifetime.
  const issuedAtMs = Math.min(
    notice.createdAt.getTime(),
    source.createdAt.getTime(),
    input.issuedAtMs ?? Number.POSITIVE_INFINITY,
  );
  if (
    release ||
    !Number.isFinite(issuedAtMs) ||
    issuedAtMs <= 0 ||
    issuedAtMs > Date.now() ||
    Date.now() >= issuedAtMs + MANUAL_COMMAND_NOTICE_TTL_MS
  )
    reject();
}
