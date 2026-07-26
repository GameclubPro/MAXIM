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
  type ManagedBroadcastMaxApiOptions,
} from './admin.service.support';

type ManagedBroadcastVerificationProgress = () => Promise<void>;

const buildVerificationResultKey = (chatId: string, messageId: string): string =>
  JSON.stringify([chatId, messageId]);

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

    const verifyReadyBefore = new Date(Date.now() - PUBLICATION_POST_SEND_VERIFY_DELAY_MS);
    const deliveries = (
      await this.context.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          status: ManagedBroadcastDeliveryStatus.SENT,
          sentAt: { lte: verifyReadyBefore },
          remoteMessageId: { not: null },
          remoteMessageVerifiedAt: null,
        },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      })
    ).filter(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.sentAt !== null &&
        delivery.sentAt <= verifyReadyBefore &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null,
    );
    if (deliveries.length === 0) {
      return unconfirmedChatIds;
    }

    const deliveriesByBotId = new Map<string | null, typeof deliveries>();
    for (const delivery of deliveries) {
      const botId = delivery.botId ?? null;
      const grouped = deliveriesByBotId.get(botId) ?? [];
      grouped.push(delivery);
      deliveriesByBotId.set(botId, grouped);
    }

    for (const [botId, groupedDeliveries] of deliveriesByBotId) {
      await onProgress();
      let results: Awaited<ReturnType<typeof this.context.maxClient.getExactMessagePresences>>;
      try {
        results = await this.context.maxClient.getExactMessagePresences(
          groupedDeliveries.map((delivery) => ({
            chatId: delivery.targetChatId,
            messageId: delivery.remoteMessageId!,
          })),
          {
            ...maxApiOptions,
            botId: botId ?? undefined,
            bypassCache: true,
            ignoreFailureMetricStatuses: [404],
            timeoutMs: PUBLICATION_POST_SEND_VERIFY_TIMEOUT_MS,
          },
        );
      } catch (error: unknown) {
        results = groupedDeliveries.map((delivery) => ({
          chatId: delivery.targetChatId,
          messageId: delivery.remoteMessageId!,
          error,
        }));
      }
      const resultsByTarget = new Map(
        results.map((result) => [
          buildVerificationResultKey(result.chatId, result.messageId),
          result,
        ]),
      );

      for (const delivery of groupedDeliveries) {
        const remoteMessageId = delivery.remoteMessageId;
        if (!remoteMessageId) {
          continue;
        }
        await onProgress();

        const result = resultsByTarget.get(
          buildVerificationResultKey(delivery.targetChatId, remoteMessageId),
        );
        if (result && 'presence' in result && result.presence === 'present') {
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
        if (!(result && 'presence' in result && result.presence === 'absent')) {
          const verificationError = result && 'error' in result ? result.error : null;
          this.context.logger.warn(
            {
              broadcastId: row.id,
              occurrenceIndex,
              deliveryId: delivery.id,
              targetChatId: delivery.targetChatId,
              botId: delivery.botId,
              messageId: remoteMessageId,
              verificationStatus: 'DEFERRED',
              err:
                verificationError instanceof Error
                  ? verificationError.message
                  : verificationError
                    ? String(verificationError)
                    : undefined,
            },
            'Managed publication post-send verification was deferred after an inconclusive lookup',
          );
          continue;
        }

        const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: delivery.id,
            status: ManagedBroadcastDeliveryStatus.SENT,
            remoteMessageId,
            remoteMessageVerifiedAt: null,
          },
          data: {
            status: ManagedBroadcastDeliveryStatus.FAILED,
            lastError:
              'MAX подтвердил, что сообщение отсутствует после отправки. Повторите публикацию вручную.',
          },
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
            verificationStatus: ManagedBroadcastDeliveryStatus.FAILED,
          },
          'Managed publication post-send verification did not confirm the message',
        );
      }
    }

    return unconfirmedChatIds;
  }
}
