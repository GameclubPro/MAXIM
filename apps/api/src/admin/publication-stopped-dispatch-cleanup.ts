import { randomUUID } from 'node:crypto';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_MISSED_WINDOW_BLOCKER_CODE } from './publication-dispatch-issue';
import { isPublicationScheduledWindowExpired } from './publication-late-policy';

type StoppedPublicationClaim = {
  id: string;
  lockToken: string;
  attemptCount: number;
  sendAttemptStarted: boolean;
};

export async function cancelPublicationDeliveryBeforeStoppedDispatch(
  prisma: PrismaService,
  claim: StoppedPublicationClaim | undefined,
): Promise<void> {
  if (!claim) return;
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
    );
    // FLAG: Undo only this claim's proven pre-HTTP increment. Previous real attempts and
    // another owner's token must survive cancellation and prohibit destructive cleanup.
    const canceled = await tx.managedBroadcastDelivery.updateMany({
      where: {
        id: claim.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: claim.lockToken,
        remoteMessageId: null,
        sentAt: null,
        legacySentWithoutRemoteId: false,
        ...(!claim.sendAttemptStarted ? { attemptCount: claim.attemptCount + 1 } : {}),
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.CANCELED,
        ...(!claim.sendAttemptStarted ? { attemptCount: { decrement: 1 } } : {}),
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: 'Публикация остановлена до отправки.',
      },
    });
    if (canceled.count !== 1 || claim.sendAttemptStarted) return;
    const delivery = await tx.managedBroadcastDelivery.findUnique({
      where: { id: claim.id },
      select: { publicationOccurrenceId: true },
    });
    if (!delivery?.publicationOccurrenceId) return;
    const occurrence = await tx.publicationOccurrence.findUnique({
      where: { id: delivery.publicationOccurrenceId },
      include: {
        publication: { select: { lifecycle: true } },
        schedule: { select: { revision: true, status: true, mode: true } },
      },
    });
    if (
      !occurrence ||
      occurrence.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      (occurrence.publication.lifecycle !== PublicationLifecycle.ACTIVE &&
        occurrence.publication.lifecycle !== PublicationLifecycle.ERROR) ||
      (occurrence.schedule.status !== PublicationScheduleStatus.ACTIVE &&
        occurrence.schedule.status !== PublicationScheduleStatus.ERROR) ||
      occurrence.schedule.revision !== occurrence.scheduleRevision ||
      !isPublicationScheduledWindowExpired(occurrence) ||
      !(
        (occurrence.status === PublicationOccurrenceStatus.FAILED &&
          occurrence.dispatchBlockerCode === PUBLISHER_MISSED_WINDOW_BLOCKER_CODE) ||
        (occurrence.status === PublicationOccurrenceStatus.CANCELED &&
          occurrence.dispatchBlockerCode === 'PUBLISHER_WINDOW_EXPIRED')
      )
    )
      return;
    const occurrenceFence = await tx.publicationOccurrence.updateMany({
      where: {
        id: occurrence.id,
        status: occurrence.status,
        dispatchBlockerCode: occurrence.dispatchBlockerCode,
        retryAuthorizedAt: occurrence.retryAuthorizedAt,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
      },
      data: { status: occurrence.status },
    });
    if (occurrenceFence.count !== 1) return;
    const envelopes = await tx.managedBroadcast.findMany({
      where: { publicationOccurrenceId: occurrence.id },
      select: { id: true },
    });
    if (!envelopes.length) return;
    const cleanupToken = `publication-stopped:${randomUUID()}`;
    const envelopeScope = { id: { in: envelopes.map((row) => row.id) } };
    const claimed = await tx.managedBroadcast.updateMany({
      where: {
        ...envelopeScope,
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: occurrence.requiredBotId,
        publicationContentRevisionId: occurrence.contentRevisionId,
        status: { not: ManagedBroadcastStatus.COMPLETED },
        sentCount: 0,
        lockedAt: null,
        lockToken: null,
      },
      data: { lockedAt: new Date(), lockToken: cleanupToken },
    });
    const releaseCleanup = () =>
      tx.managedBroadcast.updateMany({
        where: { ...envelopeScope, lockToken: cleanupToken },
        data: { lockedAt: null, lockToken: null },
      });
    if (claimed.count !== envelopes.length) {
      await releaseCleanup();
      return;
    }
    // FLAG: Lock every claimable untouched row before proving the whole occurrence empty.
    // A competing claim either wins first and is preserved, or cannot start before deletion.
    await tx.managedBroadcastDelivery.updateMany({
      where: {
        publicationOccurrenceId: occurrence.id,
        status: {
          in: [
            ManagedBroadcastDeliveryStatus.PENDING,
            ManagedBroadcastDeliveryStatus.FAILED,
            ManagedBroadcastDeliveryStatus.CANCELED,
          ],
        },
        attemptCount: 0,
        remoteMessageId: null,
        legacySentWithoutRemoteId: false,
        sentAt: null,
        lockedAt: null,
        lockToken: null,
      },
      data: { status: ManagedBroadcastDeliveryStatus.CANCELED },
    });
    const unsafeDeliveryWhere: Prisma.ManagedBroadcastDeliveryWhereInput = {
      OR: [
        { attemptCount: { gt: 0 } },
        { remoteMessageId: { not: null } },
        { legacySentWithoutRemoteId: true },
        { sentAt: { not: null } },
        { lockedAt: { not: null } },
        { lockToken: { not: null } },
        {
          status: {
            in: [
              ManagedBroadcastDeliveryStatus.SENDING,
              ManagedBroadcastDeliveryStatus.SENT,
              ManagedBroadcastDeliveryStatus.AMBIGUOUS,
            ],
          },
        },
      ],
    };
    const unsafe = await tx.managedBroadcastDelivery.count({
      where: { publicationOccurrenceId: occurrence.id, ...unsafeDeliveryWhere },
    });
    if (unsafe) {
      await releaseCleanup();
      return;
    }
    const deleted = await tx.managedBroadcast.deleteMany({
      where: {
        ...envelopeScope,
        lockToken: cleanupToken,
        sentCount: 0,
        deliveries: { none: unsafeDeliveryWhere },
        publicationOccurrence: {
          is: { id: occurrence.id, deliveries: { none: unsafeDeliveryWhere } },
        },
      },
    });
    if (deleted.count === 0) {
      await releaseCleanup();
      return;
    }
    if (deleted.count !== envelopes.length)
      throw new Error('Stopped publication cleanup fence changed');
  });
}
