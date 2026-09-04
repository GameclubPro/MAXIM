import {
  ManagedBroadcastStatus,
  PublicationDispatchProfile,
  type ManagedBroadcast,
} from '../prisma/prisma-client';
import type { MaxPublishedMessage } from '../max/max-client.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type { BroadcastOccurrenceResult } from './admin.service.support';
import {
  deferClaimedPublicationEnvelopeAfterTransientPrismaError,
  deferPublicationAfterPreDispatchPrismaError,
  settlePublicationDeliveryAfterAttemptPersistenceError,
} from './publication-execution-recovery';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';

export type PublicationDeliveryAttemptRecoveryState = {
  id: string;
  targetChatId: string;
  attemptCount: number;
  lockToken: string;
  sendAttemptStarted: boolean;
  sentMessage: MaxPublishedMessage | null;
  resolvedBotId: string | null;
  sentAt: Date | null;
  responseTargetMismatch: string | null;
};

export async function recoverPublicationExecutionError(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  row: Pick<ManagedBroadcast, 'id' | 'status' | 'publicationOccurrenceId'>;
  dispatchProfile: PublicationDispatchProfile;
  occurrenceIndex: number;
  broadcastLockToken: string;
  targetChatIds: string[];
  activeDeliveryClaim?: PublicationDeliveryAttemptRecoveryState;
  error: unknown;
  rethrowPreDispatchPrismaError: boolean;
  clearActiveDeliveryClaim(): void;
  reconcileAttemptedDelivery(params: { id: string; lockToken: string }): Promise<void>;
  finalize(params: {
    sentChatIds: string[];
    failedChatIds: string[];
    error: unknown;
  }): Promise<BroadcastOccurrenceResult>;
  readCurrentResult(error: unknown): Promise<BroadcastOccurrenceResult>;
}): Promise<BroadcastOccurrenceResult | null> {
  const sendAttemptStarted =
    options.activeDeliveryClaim?.sendAttemptStarted === true ||
    (options.error as { managedBroadcastSendStarted?: unknown } | null)
      ?.managedBroadcastSendStarted === true;
  if (
    options.row.status === ManagedBroadcastStatus.ACTIVE &&
    options.row.publicationOccurrenceId &&
    isTransientPublicationPrismaError(options.error) &&
    sendAttemptStarted &&
    options.activeDeliveryClaim
  ) {
    const interruptedDelivery = options.activeDeliveryClaim;
    try {
      let settledStatus: 'sent' | 'ambiguous' | 'lost' = 'lost';
      if (interruptedDelivery.sentMessage) {
        settledStatus = await settlePublicationDeliveryAfterAttemptPersistenceError({
          context: options.context,
          broadcastId: options.row.id,
          occurrenceIndex: options.occurrenceIndex,
          delivery: interruptedDelivery,
          botId: interruptedDelivery.resolvedBotId,
          remoteMessageId: interruptedDelivery.sentMessage.messageId,
          sentAt: interruptedDelivery.sentAt ?? new Date(),
          responseTargetMismatch: interruptedDelivery.responseTargetMismatch,
          error: options.error,
        });
      } else {
        await options.reconcileAttemptedDelivery({
          id: interruptedDelivery.id,
          lockToken: interruptedDelivery.lockToken,
        });
      }
      options.clearActiveDeliveryClaim();
      return await options.finalize({
        sentChatIds: settledStatus === 'sent' ? [interruptedDelivery.targetChatId] : [],
        failedChatIds: settledStatus === 'sent' ? [] : [interruptedDelivery.targetChatId],
        error: options.error,
      });
    } catch (recoveryError: unknown) {
      options.clearActiveDeliveryClaim();
      if (isTransientPublicationPrismaError(recoveryError)) {
        await deferClaimedPublicationEnvelopeAfterTransientPrismaError({
          context: options.context,
          broadcastId: options.row.id,
          broadcastLockToken: options.broadcastLockToken,
          error: recoveryError,
        });
      }
      throw recoveryError;
    }
  }

  if (
    options.row.status !== ManagedBroadcastStatus.ACTIVE &&
    options.row.publicationOccurrenceId &&
    isTransientPublicationPrismaError(options.error)
  ) {
    const released = await options.context.prisma.managedBroadcast.updateMany({
      where: {
        id: options.row.id,
        publicationOccurrenceId: options.row.publicationOccurrenceId,
        dispatchProfile: options.dispatchProfile,
        status: options.row.status,
        lockToken: options.broadcastLockToken,
      },
      data: { lockedAt: null, lockToken: null },
    });
    if (released.count === 1) {
      options.context.logger.warn(
        {
          broadcastId: options.row.id,
          status: options.row.status,
          err: options.error instanceof Error ? options.error.message : String(options.error),
        },
        'Released a terminal publication envelope after a transient database failure',
      );
    }
    throw options.error;
  }

  if (
    options.row.status === ManagedBroadcastStatus.ACTIVE &&
    options.row.publicationOccurrenceId &&
    isTransientPublicationPrismaError(options.error) &&
    !sendAttemptStarted
  ) {
    const retryAt = await deferPublicationAfterPreDispatchPrismaError({
      context: options.context,
      row: options.row,
      occurrenceIndex: options.occurrenceIndex,
      broadcastLockToken: options.broadcastLockToken,
      ...(options.activeDeliveryClaim
        ? {
            delivery: {
              id: options.activeDeliveryClaim.id,
              targetChatId: options.activeDeliveryClaim.targetChatId,
              attemptCount: options.activeDeliveryClaim.attemptCount,
              lockToken: options.activeDeliveryClaim.lockToken,
            },
          }
        : {}),
      sendAttemptStarted,
      error: options.error,
    });
    if (options.rethrowPreDispatchPrismaError) {
      throw options.error;
    }
    if (retryAt) {
      return {
        status: ManagedBroadcastStatus.ACTIVE,
        currentOccurrence: options.occurrenceIndex,
        sentChatIds: [],
        failedChatIds: [],
        pendingChatIds: options.activeDeliveryClaim
          ? [options.activeDeliveryClaim.targetChatId]
          : options.targetChatIds,
        canRetry: false,
        firstSendError: null,
        nextSendAt: retryAt,
      };
    }
    return await options.readCurrentResult(options.error);
  }

  return null;
}
