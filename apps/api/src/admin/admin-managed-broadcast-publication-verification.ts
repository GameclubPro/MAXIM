import {
  ManagedBroadcastDeliveryStatus,
  Prisma,
  PublicationDeliveryVerificationSource,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import type { MaxPublishedMessage } from '../max/max-client.service';
import {
  recordMaxSendRouteDisappearance,
  recordMaxSendRouteStableSuccess,
} from '../max/max-send-route-health';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { resolvePublicationVerificationNextSendAt } from './publication-delivery-verification-state';
import {
  PUBLICATION_POST_SEND_VERIFY_DELAY_MS,
  PUBLICATION_POST_SEND_ABSENCE_MAX_ATTEMPTS,
  PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
  PUBLICATION_POST_SEND_STABILITY_WINDOW_MS,
  PUBLICATION_POST_SEND_VERIFY_MAX_ATTEMPTS,
  PUBLICATION_POST_SEND_VERIFY_RETRY_DELAYS_MS,
  PUBLICATION_POST_SEND_VERIFY_TIMEOUT_MS,
  type ManagedBroadcastMaxApiOptions,
} from './admin.service.support';

type ManagedBroadcastVerificationProgress = () => Promise<void>;

export type ManagedBroadcastPublicationVerificationBudget = {
  remaining: number;
};

class ManagedBroadcastVerificationProgressError extends Error {
  constructor(readonly cause: unknown) {
    super('Managed broadcast verification progress callback failed');
  }
}

const buildVerificationResultKey = (chatId: string, messageId: string): string =>
  JSON.stringify([chatId, messageId]);

const MAX_VERIFICATION_ERROR_LENGTH = 1_000;
const VERIFIED_PRESENT_OBSERVATIONS = 2;

const buildVerificationCasWhere = (
  delivery: ManagedBroadcastDelivery,
  remoteMessageId: string,
): Prisma.ManagedBroadcastDeliveryWhereInput => ({
  id: delivery.id,
  status: ManagedBroadcastDeliveryStatus.SENT,
  remoteMessageId,
  remoteMessageVerifiedAt: null,
  remoteMessageVerificationAttemptCount: delivery.remoteMessageVerificationAttemptCount ?? 0,
  remoteMessageVerificationAbsentCount: delivery.remoteMessageVerificationAbsentCount ?? 0,
  remoteMessageVerificationPresentCount: delivery.remoteMessageVerificationPresentCount ?? 0,
  remoteMessageVerificationAttemptedAt: delivery.remoteMessageVerificationAttemptedAt ?? null,
  remoteMessageVerificationNextAt: delivery.remoteMessageVerificationNextAt ?? null,
  remoteMessageVerificationLastError: delivery.remoteMessageVerificationLastError ?? null,
  remoteMessageVerificationSource: delivery.remoteMessageVerificationSource ?? null,
});

const normalizeVerificationError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : error ? String(error) : 'Unknown error';
  return message.trim().slice(0, MAX_VERIFICATION_ERROR_LENGTH) || 'Unknown error';
};

const resolveVerificationRetryAt = (attemptCount: number, now: Date, minimumAt?: Date): Date => {
  const delayIndex = Math.min(
    Math.max(0, attemptCount - 1),
    PUBLICATION_POST_SEND_VERIFY_RETRY_DELAYS_MS.length - 1,
  );
  const retryAtMs = now.getTime() + PUBLICATION_POST_SEND_VERIFY_RETRY_DELAYS_MS[delayIndex]!;
  return new Date(Math.max(retryAtMs, minimumAt?.getTime() ?? 0));
};

export class AdminManagedBroadcastPublicationVerification {
  constructor(private readonly context: AdminManagedBroadcastRuntimeContext) {}

  nextAt(
    deliveries: ReadonlyArray<
      Pick<
        ManagedBroadcastDelivery,
        | 'remoteMessageId'
        | 'remoteMessageVerificationNextAt'
        | 'remoteMessageVerifiedAt'
        | 'sentAt'
        | 'status'
      >
    >,
  ): Date {
    const hasPendingDelivery = deliveries.some(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.PENDING ||
        delivery.status === ManagedBroadcastDeliveryStatus.SENDING,
    );
    const unverifiedDeliveries = deliveries.filter(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null,
    );
    return resolvePublicationVerificationNextSendAt(unverifiedDeliveries, hasPendingDelivery);
  }

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
    budget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<Set<string>> {
    const guardedProgress = async () => {
      try {
        await onProgress();
      } catch (error: unknown) {
        throw new ManagedBroadcastVerificationProgressError(error);
      }
    };

    try {
      return await this.verifyAfterSendPersisted(
        row,
        occurrenceIndex,
        maxApiOptions,
        guardedProgress,
        budget,
      );
    } catch (error: unknown) {
      if (error instanceof ManagedBroadcastVerificationProgressError) {
        throw error.cause;
      }
      this.context.logger.warn(
        {
          broadcastId: row.id,
          occurrenceIndex,
          err: normalizeVerificationError(error),
        },
        'Managed publication verification was deferred after a persistence failure',
      );
      return new Set();
    }
  }

  private async verifyAfterSendPersisted(
    row: ManagedBroadcast,
    occurrenceIndex: number,
    maxApiOptions: ManagedBroadcastMaxApiOptions,
    onProgress: ManagedBroadcastVerificationProgress,
    budget?: ManagedBroadcastPublicationVerificationBudget,
  ): Promise<Set<string>> {
    const unconfirmedChatIds = new Set<string>();
    if (!row.publicationOccurrenceId) {
      return unconfirmedChatIds;
    }

    const remainingBudget = Math.max(
      0,
      Math.min(
        PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
        budget?.remaining ?? PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
      ),
    );
    if (remainingBudget === 0) {
      return unconfirmedChatIds;
    }

    const now = new Date();
    const verifyReadyBefore = new Date(now.getTime() - PUBLICATION_POST_SEND_VERIFY_DELAY_MS);
    const deliveries = (
      await this.context.prisma.managedBroadcastDelivery.findMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          status: ManagedBroadcastDeliveryStatus.SENT,
          sentAt: { lte: verifyReadyBefore },
          remoteMessageId: { not: null },
          remoteMessageVerifiedAt: null,
          OR: [
            { remoteMessageVerificationNextAt: null },
            { remoteMessageVerificationNextAt: { lte: now } },
          ],
        },
        orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
        take: remainingBudget,
      })
    ).filter(
      (delivery) =>
        delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
        delivery.sentAt !== null &&
        delivery.sentAt <= verifyReadyBefore &&
        delivery.remoteMessageId !== null &&
        delivery.remoteMessageVerifiedAt === null &&
        (delivery.remoteMessageVerificationNextAt === null ||
          delivery.remoteMessageVerificationNextAt === undefined ||
          delivery.remoteMessageVerificationNextAt <= now),
    );
    if (budget) {
      budget.remaining = Math.max(0, budget.remaining - deliveries.length);
    }
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
      if (!botId) {
        results = groupedDeliveries.map((delivery) => ({
          chatId: delivery.targetChatId,
          messageId: delivery.remoteMessageId!,
          error: new Error('Delivery has no recorded bot route for exact verification'),
        }));
      } else {
        try {
          results = await this.context.maxClient.getExactMessagePresences(
            groupedDeliveries.map((delivery) => ({
              chatId: delivery.targetChatId,
              messageId: delivery.remoteMessageId!,
            })),
            {
              ...maxApiOptions,
              botId,
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
        const attemptedAt = new Date();
        const nextAttemptCount = (delivery.remoteMessageVerificationAttemptCount ?? 0) + 1;
        const sentAt = delivery.sentAt!;
        const stableAt = new Date(sentAt.getTime() + PUBLICATION_POST_SEND_STABILITY_WINDOW_MS);
        const oldEnoughForTerminalDecision = attemptedAt >= stableAt;
        if (result && 'presence' in result && result.presence === 'present') {
          const nextPresentCount = (delivery.remoteMessageVerificationPresentCount ?? 0) + 1;
          const stabilityConfirmed =
            oldEnoughForTerminalDecision && nextPresentCount >= VERIFIED_PRESENT_OBSERVATIONS;
          const verificationWhere = buildVerificationCasWhere(delivery, remoteMessageId);
          const verificationData = {
            remoteMessageVerificationAttemptCount: nextAttemptCount,
            remoteMessageVerificationAbsentCount: 0,
            remoteMessageVerificationPresentCount: nextPresentCount,
            remoteMessageVerificationAttemptedAt: attemptedAt,
            remoteMessageVerificationNextAt: stabilityConfirmed
              ? null
              : resolveVerificationRetryAt(nextAttemptCount, attemptedAt, stableAt),
            remoteMessageVerificationLastError: null,
            remoteMessageVerificationSource: stabilityConfirmed
              ? PublicationDeliveryVerificationSource.AUTOMATED_STABLE
              : null,
            remoteMessageVerifiedAt: stabilityConfirmed ? attemptedAt : null,
            lastError: null,
          };
          if (!stabilityConfirmed) {
            await this.context.prisma.managedBroadcastDelivery.updateMany({
              where: verificationWhere,
              data: verificationData,
            });
            continue;
          }

          const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
            where: verificationWhere,
            data: verificationData,
          });
          if (updated.count > 0) {
            await this.recordRouteHealthSafely('stable_success', delivery, attemptedAt);
          }
          continue;
        }
        const exactAbsence = Boolean(
          result && 'presence' in result && result.presence === 'absent',
        );
        const verificationError = result && 'error' in result ? result.error : null;
        const nextAbsentCount = exactAbsence
          ? (delivery.remoteMessageVerificationAbsentCount ?? 0) + 1
          : 0;
        const disappearanceConfirmed =
          exactAbsence && nextAbsentCount >= PUBLICATION_POST_SEND_ABSENCE_MAX_ATTEMPTS;
        const terminal =
          oldEnoughForTerminalDecision &&
          (nextAttemptCount >= PUBLICATION_POST_SEND_VERIFY_MAX_ATTEMPTS || disappearanceConfirmed);
        const verificationErrorMessage = exactAbsence
          ? 'MAX exact message lookup confirmed that the message is absent'
          : normalizeVerificationError(verificationError);

        if (!terminal) {
          const nextVerificationAt =
            exactAbsence &&
            nextAbsentCount >= PUBLICATION_POST_SEND_ABSENCE_MAX_ATTEMPTS &&
            !oldEnoughForTerminalDecision
              ? stableAt
              : resolveVerificationRetryAt(nextAttemptCount, attemptedAt);
          const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
            where: buildVerificationCasWhere(delivery, remoteMessageId),
            data: {
              remoteMessageVerificationAttemptCount: nextAttemptCount,
              remoteMessageVerificationAbsentCount: nextAbsentCount,
              remoteMessageVerificationPresentCount: 0,
              remoteMessageVerificationAttemptedAt: attemptedAt,
              remoteMessageVerificationNextAt: nextVerificationAt,
              remoteMessageVerificationLastError: verificationErrorMessage,
              remoteMessageVerificationSource: null,
            },
          });
          if (updated.count === 0) {
            continue;
          }
          this.context.logger.warn(
            {
              broadcastId: row.id,
              occurrenceIndex,
              deliveryId: delivery.id,
              targetChatId: delivery.targetChatId,
              botId: delivery.botId,
              messageId: remoteMessageId,
              verificationStatus: 'DEFERRED',
              verificationAttemptCount: nextAttemptCount,
              verificationAbsentCount: nextAbsentCount,
              nextVerificationAt,
              err: verificationErrorMessage,
            },
            exactAbsence
              ? 'Managed publication post-send absence needs another confirmation'
              : 'Managed publication post-send verification was deferred after an inconclusive lookup',
          );
          continue;
        }

        const terminalWhere = buildVerificationCasWhere(delivery, remoteMessageId);
        const terminalData = {
          status: disappearanceConfirmed
            ? ManagedBroadcastDeliveryStatus.FAILED
            : ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          remoteMessageVerificationAttemptCount: nextAttemptCount,
          remoteMessageVerificationAbsentCount: nextAbsentCount,
          remoteMessageVerificationPresentCount: 0,
          remoteMessageVerificationAttemptedAt: attemptedAt,
          remoteMessageVerificationNextAt: null,
          remoteMessageVerificationLastError: verificationErrorMessage,
          remoteMessageVerificationSource: null,
          lastError: disappearanceConfirmed
            ? 'MAX несколько раз подтвердил, что сообщение исчезло после отправки. Проверьте публикацию вручную.'
            : 'Не удалось устойчиво подтвердить публикацию в MAX. Проверьте сообщение вручную.',
        };
        const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
          where: terminalWhere,
          data: terminalData,
        });
        if (updated.count === 0) {
          continue;
        }
        if (disappearanceConfirmed) {
          await this.recordRouteHealthSafely('disappearance', delivery, attemptedAt);
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
            verificationAttemptCount: nextAttemptCount,
            verificationAbsentCount: nextAbsentCount,
            verificationStatus: disappearanceConfirmed
              ? ManagedBroadcastDeliveryStatus.FAILED
              : ManagedBroadcastDeliveryStatus.AMBIGUOUS,
          },
          disappearanceConfirmed
            ? 'Managed publication disappeared after MAX accepted the send'
            : 'Managed publication verification reached its bounded attempt limit',
        );
      }
    }

    return unconfirmedChatIds;
  }

  private async recordRouteHealthSafely(
    outcome: 'stable_success' | 'disappearance',
    delivery: Pick<ManagedBroadcastDelivery, 'id' | 'targetChatId' | 'botId' | 'sentAt'>,
    observedAt: Date,
  ): Promise<void> {
    if (!delivery.sentAt || !delivery.botId) {
      return;
    }
    try {
      const observation = {
        chatId: delivery.targetChatId,
        botId: delivery.botId,
        sentAt: delivery.sentAt,
        observedAt,
      };
      if (outcome === 'disappearance') {
        await recordMaxSendRouteDisappearance(this.context.prisma, observation);
      } else {
        await recordMaxSendRouteStableSuccess(this.context.prisma, observation);
      }
    } catch (error: unknown) {
      this.context.logger.warn(
        {
          deliveryId: delivery.id,
          targetChatId: delivery.targetChatId,
          botId: delivery.botId,
          routeHealthOutcome: outcome,
          err: normalizeVerificationError(error),
        },
        'Managed publication route-health persistence failed',
      );
    }
  }
}
