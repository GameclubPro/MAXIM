import type { MaxUpdate } from '@maxim/contracts';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { ChatCatalogKind, ChatEntityType, Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readWebhookEventTimestamp } from './webhook-semantic-event-key';

export const DORMANT_BOT_OBSERVATION_MARKER = 'DORMANT_BOT_OBSERVATION_V1';

export async function settleDormantWebhookObservation(
  prisma: PrismaService,
  links: MaxBotLinkService,
  webhookEventId: string,
  update: MaxUpdate,
  previousMarker: string | null,
  receivedAt: Date,
): Promise<boolean> {
  const chatId = update.message?.chatId?.trim();
  const botId = update.botId?.trim();
  const sourceAt = readWebhookEventTimestamp(update);
  // FLAG: A future remote timestamp never moves receipt admission past first activation.
  const receiptSourceAt = new Date(Math.min(receivedAt.getTime(), sourceAt?.getTime() ?? Infinity));
  if (
    !chatId ||
    !botId ||
    (update.message?.entityType !== 'channel' && isPrivateDirectChatId(chatId)) ||
    !['message_created', 'message_edited', 'user_added'].includes(update.type.toLowerCase()) ||
    isManagedEntityHandshakeStartCommand(update) ||
    !links.isChatBotActivationRequired ||
    (previousMarker !== DORMANT_BOT_OBSERVATION_MARKER &&
      !(await links.isChatBotActivationRequired(chatId, botId, receiptSourceAt)))
  )
    return false;

  return prisma.$transaction(
    async (tx) => {
      // FLAG: A first receipt has no parent row to lock. Insert only a context shell
      // before locking, so concurrent initial activation must serialize on this exact Chat.
      // This creates neither membership nor access evidence and never calls MAX.
      const entityType =
        update.message?.entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
      await tx.chat.createMany({
        data: {
          id: chatId,
          title: update.message?.chatTitle?.trim() || `Chat ${chatId}`,
          entityType,
          catalogKind: ChatCatalogKind.CONTEXT_ONLY,
        },
        skipDuplicates: true,
      });
      // FLAG: Observation and activation serialize on Chat; execution admission also locks
      // this receipt. No shared semantic claim is created, completed, removed or reset here.
      await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
      const receipts = await tx.$queryRaw<
        Array<{ status: WebhookStatus; errorMessage: string | null }>
      >`
      SELECT status, error_message AS "errorMessage" FROM webhook_events
      WHERE id = ${webhookEventId} FOR UPDATE
    `;
      const receipt = receipts[0];
      if (!receipt) return false;
      if (
        receipt.status === WebhookStatus.PROCESSED &&
        receipt.errorMessage === DORMANT_BOT_OBSERVATION_MARKER
      )
        return true;
      const route = await links.resolveDormantReceiptPeer(chatId, botId, tx, receiptSourceAt);
      if (!route.dormant || route.peerBotId) return false;
      const ownedClaim = await tx.webhookExecutionClaim.findFirst({
        where: { webhookEventId },
        select: { id: true },
      });
      if (ownedClaim) return false;
      const settled = await tx.webhookEvent.updateMany({
        where: {
          id: webhookEventId,
          status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.FAILED] },
        },
        data: {
          status: WebhookStatus.PROCESSED,
          processedAt: new Date(),
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
          errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
        },
      });
      return settled.count === 1;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
