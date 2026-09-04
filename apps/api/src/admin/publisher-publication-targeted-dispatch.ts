import { PublicationDispatchProfile, PublicationScheduleMode } from '../prisma/prisma-client';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type { ManagedBroadcastPublicationVerificationBudget } from './admin-managed-broadcast-publication-verification';
import {
  selectTargetedPublisherImmediatePublicationBroadcastBatch,
  selectTargetedPublisherPublicationBroadcastBatch,
} from './admin-managed-broadcast-due-selection';
import {
  MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM,
  MANAGED_BROADCAST_DUE_MAX_PASSES,
  PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
} from './admin.service.support';

type TargetedPublicationReason = 'immediate' | 'deadline';

type TargetedPublicationOccurrenceResult = {
  sentChatIds: readonly string[];
  failedChatIds: readonly string[];
};

export async function processTargetedPublisherPublicationBroadcasts(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  dispatchProfile: PublicationDispatchProfile;
  publicationId: string;
  occurrenceId?: string;
  reason: TargetedPublicationReason;
  sharedVerificationBudget?: ManagedBroadcastPublicationVerificationBudget;
  processOccurrence(params: {
    broadcastId: string;
    reason: TargetedPublicationReason;
    staleLockBefore: Date;
    verificationBudget: ManagedBroadcastPublicationVerificationBudget;
    automaticDeliveryQuantum: number;
    rethrowPreDispatchPrismaError: true;
  }): Promise<TargetedPublicationOccurrenceResult>;
}): Promise<ManagedBroadcastPublicationVerificationBudget> {
  const verificationBudget = options.sharedVerificationBudget ?? {
    remaining: PUBLICATION_POST_SEND_VERIFY_BATCH_SIZE,
  };
  if (options.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
    return verificationBudget;
  }

  for (let pass = 0; pass < MANAGED_BROADCAST_DUE_MAX_PASSES; pass += 1) {
    const scope = {
      publicationId: options.publicationId,
      ...(options.occurrenceId ? { occurrenceId: options.occurrenceId } : {}),
    };
    const { dueRows, staleLockBefore } =
      options.reason === 'immediate'
        ? await selectTargetedPublisherImmediatePublicationBroadcastBatch(
            options.context.prisma,
            scope,
          )
        : await selectTargetedPublisherPublicationBroadcastBatch(options.context.prisma, scope, [
            PublicationScheduleMode.ONCE,
            PublicationScheduleMode.SLOTS,
            PublicationScheduleMode.RECURRENCE,
          ]);
    if (dueRows.length === 0) {
      return verificationBudget;
    }

    let madeProgress = false;
    for (const row of dueRows) {
      const result = await options.processOccurrence({
        broadcastId: row.id,
        reason: options.reason,
        staleLockBefore,
        verificationBudget,
        automaticDeliveryQuantum: MANAGED_BROADCAST_AUTOMATIC_DELIVERY_QUANTUM,
        rethrowPreDispatchPrismaError: true,
      });
      madeProgress ||= result.sentChatIds.length > 0 || result.failedChatIds.length > 0;
    }
    if (!madeProgress) {
      return verificationBudget;
    }
  }

  options.context.logger.warn(
    {
      publicationId: options.publicationId,
      occurrenceId: options.occurrenceId ?? null,
    },
    `Targeted Publisher ${options.reason === 'immediate' ? 'NOW' : 'deadline'} backlog was not fully drained after ${MANAGED_BROADCAST_DUE_MAX_PASSES} passes.`,
  );
  return verificationBudget;
}
