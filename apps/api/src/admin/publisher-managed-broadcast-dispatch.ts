import { ServiceUnavailableException, type Logger } from '@nestjs/common';
import {
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
} from '../prisma/prisma-client';
import {
  classifyPublisherFailure,
  type PublisherFailureClassification,
} from '../publisher/publisher-dispatch-health.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';

const PUBLISHER_BLOCKED_RETRY_MS = 60_000;
const PUBLISHER_RUNTIME_BLOCKER = 'PUBLISHER_RUNTIME_UNAVAILABLE';

type PublisherBroadcastRow = {
  id: string;
  publicationOccurrenceId: string | null;
  requiredBotId: string | null;
};

type PublisherDeliveryRow = {
  id: string;
  targetChatId: string;
  dialogBotId: string | null;
};

export class PublisherDeliveryDeferredError extends Error {
  constructor(readonly blockerCode: string) {
    super(`Publik delivery is blocked: ${blockerCode}`);
    this.name = 'PublisherDeliveryDeferredError';
  }
}

export class PublisherManagedBroadcastDispatch {
  constructor(
    private readonly context: AdminManagedBroadcastRuntimeContext,
    private readonly logger: Logger,
  ) {}

  async ensureRuntimeBoundary(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: { lockToken: string },
  ): Promise<{ ready: true } | { ready: false; retryAt: Date }> {
    try {
      if (!this.context.publisherRuntimeBoundaryService) {
        throw new Error('Publisher runtime boundary is unavailable');
      }
      this.context.publisherRuntimeBoundaryService.assertDispatchEnabled();
    } catch (error: unknown) {
      return this.deferRuntime(row, occurrenceIndex, lease, error);
    }

    await Promise.all([
      row.publicationOccurrenceId
        ? this.context.prisma.publicationOccurrence.updateMany({
            where: {
              id: row.publicationOccurrenceId,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              dispatchBlockerCode: PUBLISHER_RUNTIME_BLOCKER,
            },
            data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
          })
        : Promise.resolve(),
      this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchBlockerCode: PUBLISHER_RUNTIME_BLOCKER,
        },
        data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
      }),
    ]);
    return { ready: true };
  }

  async assertDeliveryReady(chatId: string, requiredBotId: string): Promise<void> {
    try {
      const boundary = this.context.publisherRuntimeBoundaryService;
      const readiness = this.context.publisherReadinessService;
      const health = this.context.publisherDispatchHealthService;
      if (!boundary || !readiness || !health) {
        throw new Error('Publisher delivery guards are unavailable');
      }
      boundary.assertDispatchEnabled();
      await health.assertDispatchAllowed();
      const route = await readiness.assertEntityReady(chatId, 'publication');
      if (route.requiredBotId !== requiredBotId) {
        throw new PublisherDeliveryDeferredError('PUBLISHER_BOT_CHANGED');
      }
    } catch (error: unknown) {
      if (error instanceof PublisherDeliveryDeferredError) {
        throw error;
      }
      const blockerCode =
        typeof (error as { blockerCode?: unknown } | null)?.blockerCode === 'string'
          ? String((error as { blockerCode: string }).blockerCode)
          : (error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED'
            ? 'PUBLISHER_AUTH_PAUSED'
            : PUBLISHER_RUNTIME_BLOCKER;
      throw new PublisherDeliveryDeferredError(blockerCode.slice(0, 96));
    }
  }

  async deferUnreadyBeforeClaim(
    row: PublisherBroadcastRow,
    delivery: PublisherDeliveryRow,
    requiredBotId: string,
  ): Promise<Date | null> {
    try {
      await this.assertDeliveryReady(delivery.targetChatId, requiredBotId);
      await this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId,
        },
        data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
      });
      return null;
    } catch (error: unknown) {
      const blockerCode =
        error instanceof PublisherDeliveryDeferredError
          ? error.blockerCode
          : PUBLISHER_RUNTIME_BLOCKER;
      const blockedAt = new Date();
      const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
      await Promise.all([
        this.context.prisma.managedBroadcastDelivery.updateMany({
          where: {
            id: delivery.id,
            status: ManagedBroadcastDeliveryStatus.PENDING,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            requiredBotId,
          },
          data: { dispatchBlockerCode: blockerCode, dispatchBlockedAt: blockedAt },
        }),
        row.publicationOccurrenceId
          ? this.context.prisma.publicationOccurrence.updateMany({
              where: {
                id: row.publicationOccurrenceId,
                dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              },
              data: { dispatchBlockerCode: blockerCode, dispatchBlockedAt: blockedAt },
            })
          : Promise.resolve(),
      ]);
      return retryAt;
    }
  }

  async deferClaimed(params: {
    row: PublisherBroadcastRow;
    delivery: PublisherDeliveryRow;
    deliveryLockToken: string;
    blockerCode: string;
  }): Promise<Date> {
    const blockedAt = new Date();
    const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
    await Promise.all([
      this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: params.delivery.id,
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lockToken: params.deliveryLockToken,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: params.row.requiredBotId,
        },
        data: {
          status: ManagedBroadcastDeliveryStatus.PENDING,
          lockedAt: null,
          lockToken: null,
          dispatchBlockerCode: params.blockerCode.slice(0, 96),
          dispatchBlockedAt: blockedAt,
        },
      }),
      params.row.publicationOccurrenceId
        ? this.context.prisma.publicationOccurrence.updateMany({
            where: {
              id: params.row.publicationOccurrenceId,
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            },
            data: {
              dispatchBlockerCode: params.blockerCode.slice(0, 96),
              dispatchBlockedAt: blockedAt,
            },
          })
        : Promise.resolve(),
    ]);
    return retryAt;
  }

  async resolveDialogBotId(
    delivery: PublisherDeliveryRow,
    deliveryLockToken: string,
  ): Promise<string> {
    const persisted = delivery.dialogBotId?.trim();
    if (persisted) {
      return persisted;
    }
    const chat = await this.context.prisma.chat.findUnique({
      where: { id: delivery.targetChatId },
      select: { primaryBotId: true, botId: true },
    });
    const dialogBotId = (chat?.primaryBotId ?? chat?.botId)?.trim();
    if (!dialogBotId) {
      throw new ServiceUnavailableException({
        code: 'PUBLISHER_SETUP_REQUIRED',
        message: 'Для публикации не найден основной бот, который откроет комментарии.',
        chatId: delivery.targetChatId,
      });
    }
    const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: delivery.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: deliveryLockToken,
        dialogBotId: null,
      },
      data: { dialogBotId },
    });
    if (updated.count !== 1) {
      throw new ServiceUnavailableException(
        'Publisher delivery lock was lost while repairing dialog attribution',
      );
    }
    return dialogBotId;
  }

  async recordFailure(
    chatId: string,
    error: unknown,
    observedAt: Date,
  ): Promise<PublisherFailureClassification> {
    const classification = classifyPublisherFailure(error);
    try {
      await this.context.publisherDispatchHealthService?.recordSendFailure(
        chatId,
        error,
        observedAt,
      );
    } catch (healthError: unknown) {
      this.logger.warn(
        {
          chatId,
          classification,
          err: healthError instanceof Error ? healthError.message : String(healthError),
        },
        'Failed to persist Publik delivery health failure',
      );
    }
    return classification;
  }

  async recordSuccess(chatId: string, attemptedAt: Date): Promise<void> {
    try {
      await this.context.publisherDispatchHealthService?.recordSendSuccess(chatId, attemptedAt);
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Publik send succeeded but health persistence failed',
      );
    }
  }

  private async deferRuntime(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: { lockToken: string },
    error: unknown,
  ): Promise<{ ready: false; retryAt: Date }> {
    const blockedAt = new Date();
    const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
    await this.context.prisma.$transaction(async (tx) => {
      if (row.publicationOccurrenceId) {
        await tx.publicationOccurrence.updateMany({
          where: {
            id: row.publicationOccurrenceId,
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          },
          data: {
            dispatchBlockerCode: PUBLISHER_RUNTIME_BLOCKER,
            dispatchBlockedAt: blockedAt,
          },
        });
      }
      await tx.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: ManagedBroadcastDeliveryStatus.PENDING,
        },
        data: {
          dispatchBlockerCode: PUBLISHER_RUNTIME_BLOCKER,
          dispatchBlockedAt: blockedAt,
        },
      });
      await tx.managedBroadcast.updateMany({
        where: {
          id: row.id,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          lockToken: lease.lockToken,
        },
        data: { nextSendAt: retryAt, lockedAt: null, lockToken: null },
      });
    });
    this.logger.warn(
      {
        broadcastId: row.id,
        occurrenceIndex,
        err: error instanceof Error ? error.message : String(error),
      },
      'Deferred Publik publication because its dispatch runtime is unavailable',
    );
    return { ready: false, retryAt };
  }
}
