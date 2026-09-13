import type { Logger } from '@nestjs/common';
import {
  PublicationLifecycle,
  PublicationScheduleStatus,
  type PublicationSchedule,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';

export async function recoverPublicationRecurrencePreparationFailure(options: {
  prisma: PrismaService;
  logger: Pick<Logger, 'warn'>;
  schedule: Pick<PublicationSchedule, 'id' | 'publicationId' | 'revision' | 'nextMaterializeAt'>;
  error: unknown;
}): Promise<void> {
  const { prisma, logger, schedule, error } = options;
  // FLAG: Failed preparation has not sent anything. Infrastructure and Publisher access
  // outages must retain the schedule and its content revision for a later bounded poll.
  if (isTransientPublicationPrismaError(error)) {
    logger.warn(
      { scheduleId: schedule.id, publicationId: schedule.publicationId },
      'Deferred publication recurrence after a transient database failure',
    );
    return;
  }
  const where = {
    id: schedule.id,
    revision: schedule.revision,
    status: PublicationScheduleStatus.ACTIVE,
    nextMaterializeAt: schedule.nextMaterializeAt,
    publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
  };
  if (error instanceof PublisherSetupRequiredException) {
    await prisma.publicationSchedule.updateMany({
      where,
      data: {
        nextMaterializeAt: new Date(Date.now() + 60_000),
        lastError: error.blockerCode.slice(0, 96),
      },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  const failed = await prisma.publicationSchedule.updateMany({
    where,
    data: { status: PublicationScheduleStatus.ERROR, nextMaterializeAt: null, lastError: message },
  });
  if (failed.count > 0) {
    await prisma.publication.updateMany({
      where: { id: schedule.publicationId, lifecycle: PublicationLifecycle.ACTIVE },
      data: { lifecycle: PublicationLifecycle.ERROR },
    });
  }
  logger.warn(
    { scheduleId: schedule.id, publicationId: schedule.publicationId, err: message },
    'Failed to materialize publication recurrence',
  );
}
