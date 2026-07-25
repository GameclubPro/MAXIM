import {
  ManagedBroadcastDeliveryStatus,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import type { MaxPublishedMessage } from '../max/max-client.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import {
  PUBLICATION_POST_SEND_VERIFY_DELAY_MS,
  PUBLICATION_POST_SEND_VERIFY_TIMEOUT_MS,
  sleep,
  type ManagedBroadcastMaxApiOptions,
} from './admin.service.support';

type ManagedBroadcastVerificationProgress = () => Promise<void>;

export class AdminManagedBroadcastPublicationVerification {
  constructor(private readonly context: AdminManagedBroadcastRuntimeContext) {}

  findResponseTargetMismatch(
    targetChatId: string,
    sentMessage: MaxPublishedMessage,
  ): string | null {
    const responseChatId = sentMessage.chatId?.trim();
    if (!responseChatId || responseChatId === targetChatId.trim()) {
      return null;
    }
    return `MAX вернул сообщение для другого чата (${responseChatId} вместо ${targetChatId}). Проверьте отправку вручную.`;
  }

  async persistResponseTargetMismatch(params: {
    broadcastId: string;
    occurrenceIndex: number;
    delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId'>;
    deliveryLockToken: string;
    resolvedBotId?: string;
    sentMessage: MaxPublishedMessage;
    sentAt: Date;
  }): Promise<boolean | null> {
    const mismatch = this.findResponseTargetMismatch(
      params.delivery.targetChatId,
      params.sentMessage,
    );
    if (!mismatch) {
      return null;
    }

    const persisted = await this.context.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: params.delivery.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: params.deliveryLockToken,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.AMBIGUOUS,
        sentAt: params.sentAt,
        botId: params.resolvedBotId ?? null,
        remoteMessageId: params.sentMessage.messageId,
        legacySentWithoutRemoteId: false,
        lockedAt: null,
        lockToken: null,
        lastError: mismatch,
      },
    });
    this.context.logger.warn(
      {
        broadcastId: params.broadcastId,
        occurrenceIndex: params.occurrenceIndex,
        targetChatId: params.delivery.targetChatId,
        responseChatId: params.sentMessage.chatId,
        messageId: params.sentMessage.messageId,
      },
      'Managed broadcast MAX response target did not match the requested chat',
    );
    return persisted.count > 0;
  }

  async verifyAfterSend(
    row: ManagedBroadcast,
    occurrenceIndex: number,
    maxApiOptions: ManagedBroadcastMaxApiOptions,
    onProgress: ManagedBroadcastVerificationProgress,
  ): Promise<Set<string>> {
    const unconfirmedChatIds = new Set<string>();
    if (!row.publicationOccurrenceId) {
      return unconfirmedChatIds;
    }

    const deliveries = (
      await this.context.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageId: { not: null },
          remoteMessageVerifiedAt: null,
        },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      })
    ).filter(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null,
    );
    if (deliveries.length === 0) {
      return unconfirmedChatIds;
    }

    const verifyAfterMs = Math.max(
      ...deliveries.map(
        (delivery) =>
          (delivery.sentAt?.getTime() ?? Date.now()) + PUBLICATION_POST_SEND_VERIFY_DELAY_MS,
      ),
    );
    const waitMs = Math.max(0, verifyAfterMs - Date.now());
    if (waitMs > 0) {
      await onProgress();
      await sleep(waitMs);
    }

    for (const delivery of deliveries) {
      const remoteMessageId = delivery.remoteMessageId;
      if (!remoteMessageId) {
        continue;
      }
      await onProgress();

      let nextStatus: ManagedBroadcastDeliveryStatus | null = null;
      let lastError: string | null = null;
      let verificationError: unknown = null;
      try {
        const presence = await this.context.maxClient.getExactMessagePresence(
          delivery.targetChatId,
          remoteMessageId,
          {
            ...maxApiOptions,
            botId: delivery.botId ?? undefined,
            bypassCache: true,
            ignoreFailureMetricStatuses: [404],
            timeoutMs: PUBLICATION_POST_SEND_VERIFY_TIMEOUT_MS,
          },
        );
        if (presence === 'present') {
          await this.context.prisma.managedBroadcastDelivery.updateMany({
            where: {
              id: delivery.id,
              status: ManagedBroadcastDeliveryStatus.SENT,
              remoteMessageId,
              remoteMessageVerifiedAt: null,
            },
            data: {
              remoteMessageVerifiedAt: new Date(),
              lastError: null,
            },
          });
          continue;
        }
        nextStatus = ManagedBroadcastDeliveryStatus.FAILED;
        lastError =
          'MAX подтвердил, что сообщение отсутствует после отправки. Повторите публикацию вручную.';
      } catch (error: unknown) {
        verificationError = error;
        nextStatus = ManagedBroadcastDeliveryStatus.AMBIGUOUS;
        lastError =
          'MAX не подтвердил наличие сообщения после отправки. Проверьте чат вручную перед повтором.';
      }

      const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: ManagedBroadcastDeliveryStatus.SENT,
          remoteMessageId,
          remoteMessageVerifiedAt: null,
        },
        data: { status: nextStatus, lastError },
      });
      if (updated.count === 0) {
        continue;
      }
      unconfirmedChatIds.add(delivery.targetChatId);
      this.context.logger.warn(
        {
          broadcastId: row.id,
          occurrenceIndex,
          deliveryId: delivery.id,
          targetChatId: delivery.targetChatId,
          botId: delivery.botId,
          messageId: remoteMessageId,
          verificationStatus: nextStatus,
          err:
            verificationError instanceof Error
              ? verificationError.message
              : verificationError
                ? String(verificationError)
                : undefined,
        },
        'Managed publication post-send verification did not confirm the message',
      );
    }

    return unconfirmedChatIds;
  }
}
