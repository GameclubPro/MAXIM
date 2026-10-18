import { PublicationOccurrenceStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { rollupPublicationOccurrenceWithRouteOutageRecovery } from './publication-access-loss-recovery';
import { resolvePublicationOccurrenceRollupStatus } from './publication-delivery-verification-state';

export async function rollupPublicationOccurrence(
  prisma: PrismaService,
  occurrenceId: string,
): Promise<void> {
  const occurrence = await prisma.publicationOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      legacyBroadcasts: {
        include: {
          deliveries: {
            select: {
              status: true,
              targetChatId: true,
              lastErrorCode: true,
              lastError: true,
              remoteMessageId: true,
              remoteMessageVerifiedAt: true,
              remoteMessageVerificationAttemptCount: true,
              remoteMessageVerificationAbsentCount: true,
              remoteMessageVerificationPresentCount: true,
              remoteMessageVerificationAttemptedAt: true,
              remoteMessageVerificationNextAt: true,
              remoteMessageVerificationSource: true,
            },
          },
        },
      },
    },
  });
  if (!occurrence || occurrence.status === PublicationOccurrenceStatus.CANCELED) {
    return;
  }
  const deliveries = occurrence.legacyBroadcasts.flatMap((broadcast) => broadcast.deliveries);
  if (deliveries.length === 0) {
    return;
  }
  const status = resolvePublicationOccurrenceRollupStatus(
    occurrence.legacyBroadcasts,
    occurrence.scheduledAt,
  );
  await rollupPublicationOccurrenceWithRouteOutageRecovery(prisma, occurrence, status, deliveries);
}
