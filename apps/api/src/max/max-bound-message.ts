import type { Prisma } from '../prisma/prisma-client';

export type MaxBoundObjectReference = { kind: 'poll' | 'send'; id: string };
export type MaxBoundMessageTarget = {
  chatId: string;
  messageId: string;
  botId: string;
  purpose: 'edit_message' | 'delete_message';
  object?: MaxBoundObjectReference;
};

type BindingReader = Pick<
  Prisma.TransactionClient,
  | 'managedPoll'
  | 'managedGiveaway'
  | 'chatRules'
  | 'channelSettings'
  | 'channelAutoPostAttachMarker'
  | 'chatAutoCommentAttachMarker'
  | 'chatReportCase'
  | 'moderationDeleteIntent'
  | 'maxActionLedgerEntry'
>;

/** FLAG: This proves only the original executor of an existing object. All current
 * membership, activation, capability, feature and uncertain-effect guards still apply.
 * Every lookup uses a primary/unique key or an existing exact-message index. */
export async function hasPersistedBoundMessage(
  db: BindingReader,
  target: MaxBoundMessageTarget,
): Promise<boolean> {
  const { chatId, messageId, botId, purpose } = target;
  if (!chatId || !messageId || !botId) return false;
  if (target.object?.kind === 'send') {
    if (purpose !== 'delete_message') return false;
    const send = await db.maxActionLedgerEntry.findUnique({
      where: { jobId: target.object.id },
      select: {
        chatId: true,
        actionType: true,
        status: true,
        remoteMessageId: true,
        dispatchBotId: true,
      },
    });
    return (
      send?.actionType === 'SEND_MESSAGE' &&
      send.status === 'SUCCEEDED' &&
      send.chatId === chatId &&
      send.remoteMessageId === messageId &&
      send.dispatchBotId === botId
    );
  }
  if (target.object?.kind === 'poll') {
    const poll = await db.managedPoll.findUnique({
      where: { id: target.object.id },
      select: { chatId: true, publicationMessageId: true, publicationBotId: true },
    });
    return (
      poll?.chatId === chatId &&
      poll.publicationMessageId === messageId &&
      poll.publicationBotId === botId
    );
  }

  const rules = await db.chatRules.findUnique({
    where: { chatId },
    select: {
      publishedMessageId: true,
      publishedBotId: true,
      pendingCleanupMessageId: true,
      pendingCleanupBotId: true,
    },
  });
  if (rules?.publishedMessageId === messageId && rules.publishedBotId === botId) return true;
  if (
    purpose === 'delete_message' &&
    rules?.pendingCleanupMessageId === messageId &&
    rules.pendingCleanupBotId === botId
  )
    return true;

  const publication = await db.managedGiveaway.findFirst({
    where: { sourceChatId: chatId, publicationMessageId: messageId },
    select: { publicationBotId: true },
  });
  if (publication?.publicationBotId === botId) return true;
  const results = await db.managedGiveaway.findFirst({
    where: { sourceChatId: chatId, resultsMessageId: messageId },
    select: { resultsBotId: true },
  });
  if (results?.resultsBotId === botId) return true;

  const channel = await db.channelSettings.findUnique({
    where: { chatId },
    select: { engagementPublishedMessageId: true, engagementPublishedBotId: true },
  });
  if (
    channel?.engagementPublishedMessageId === messageId &&
    channel.engagementPublishedBotId === botId
  )
    return true;

  const report = await db.chatReportCase.findFirst({
    where: { chatId, counterMessageId: messageId },
    select: { originBotId: true },
  });
  if (report?.originBotId === botId) return true;

  if (purpose === 'edit_message') {
    const channelMarker = await db.channelAutoPostAttachMarker.findUnique({
      where: { chatId_messageId: { chatId, messageId } },
      select: { botId: true, deliveryMode: true },
    });
    if (channelMarker?.botId === botId && channelMarker.deliveryMode === 'edit_message')
      return true;
    const chatMarker = await db.chatAutoCommentAttachMarker.findUnique({
      where: { chatId_messageId: { chatId, messageId } },
      select: { botId: true, deliveryMode: true },
    });
    return chatMarker?.botId === botId && chatMarker.deliveryMode === 'edit_message';
  }

  const intent = await db.moderationDeleteIntent.findUnique({
    where: { chatId_messageId: { chatId, messageId } },
    select: { originBotId: true, messageAuthorKind: true, routingPolicy: true },
  });
  return (
    intent?.originBotId === botId &&
    intent.messageAuthorKind === 'bot' &&
    intent.routingPolicy === 'origin_only'
  );
}
