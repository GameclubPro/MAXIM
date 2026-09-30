import type { Logger } from '@nestjs/common';
import {
  PublicationLifecycle,
  PublicationScheduleStatus,
  type Prisma,
  type PublicationSchedule,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';

const PUBLICATION_RECURRENCE_PREPARATION_BACKOFF_MS = 60_000;
const PUBLICATION_RECURRENCE_PREPARATION_JITTER_MS = 15_000;

type RecurrencePreparationFailureOptions = {
  prisma: PrismaService;
  logger: Pick<Logger, 'warn'>;
  schedule: Pick<PublicationSchedule, 'id' | 'publicationId' | 'revision' | 'nextMaterializeAt'>;
  publicationVersion: number;
  lockCalendar: (tx: Prisma.TransactionClient) => Promise<void>;
};

export async function deferPublicationRecurrencePreparation(
  options: RecurrencePreparationFailureOptions,
  blockerCode = 'PUBLICATION_PREPARATION_TRANSIENT',
): Promise<boolean> {
  const { prisma, logger, schedule, publicationVersion, lockCalendar } = options;
  const jitter =
    blockerCode === 'PUBLICATION_PREPARATION_TRANSIENT'
      ? Math.floor(Math.random() * PUBLICATION_RECURRENCE_PREPARATION_JITTER_MS)
      : 0;
  try {
    await prisma.$transaction(async (tx) => {
      // FLAG: Even a nonterminal preparation pause must serialize with content edits/cancel.
      // The observed revision and publication version are rechecked after the calendar lock.
      await lockCalendar(tx);
      await tx.publicationSchedule.updateMany({
        where: {
          id: schedule.id,
          revision: schedule.revision,
          status: PublicationScheduleStatus.ACTIVE,
          nextMaterializeAt: schedule.nextMaterializeAt,
          publication: {
            is: { lifecycle: PublicationLifecycle.ACTIVE, version: publicationVersion },
          },
        },
        data: {
          nextMaterializeAt: new Date(
            Date.now() + PUBLICATION_RECURRENCE_PREPARATION_BACKOFF_MS + jitter,
          ),
          lastError: blockerCode.slice(0, 96),
        },
      });
    });
    return true;
  } catch (error: unknown) {
    if (!isTransientPublicationPrismaError(error)) throw error;
    logger.warn(
      { scheduleId: schedule.id, publicationId: schedule.publicationId },
      'Stopped recurrence preparation sweep while the database is unavailable',
    );
    return false;
  }
}

export async function recoverPublicationRecurrencePreparationFailure(options: {
  prisma: PrismaService;
  logger: Pick<Logger, 'warn'>;
  schedule: Pick<PublicationSchedule, 'id' | 'publicationId' | 'revision' | 'nextMaterializeAt'>;
  publicationVersion: number;
  lockCalendar: (tx: Prisma.TransactionClient) => Promise<void>;
  error: unknown;
}): Promise<boolean> {
  const { prisma, logger, schedule, error, publicationVersion, lockCalendar } = options;
  // FLAG: Failed preparation has not sent anything. Infrastructure and Publisher access
  // outages must retain the schedule and its content revision for a later bounded poll.
  if (isTransientPublicationPrismaError(error)) {
    logger.warn(
      { scheduleId: schedule.id, publicationId: schedule.publicationId },
      'Deferred publication recurrence after a transient database failure',
    );
    return deferPublicationRecurrencePreparation(options);
  }
  const where = {
    id: schedule.id,
    revision: schedule.revision,
    status: PublicationScheduleStatus.ACTIVE,
    nextMaterializeAt: schedule.nextMaterializeAt,
    publication: { is: { lifecycle: PublicationLifecycle.ACTIVE, version: publicationVersion } },
  };
  if (error instanceof PublisherSetupRequiredException) {
    return deferPublicationRecurrencePreparation(options, error.blockerCode);
  }
  const message = error instanceof Error ? error.message : String(error);
  // FLAG: Error recovery participates in the edit/cancel calendar fence. Both writes
  // must commit together, and an old preparation must never terminalize a new revision.
  const changed = await prisma.$transaction(async (tx) => {
    await lockCalendar(tx);
    const failed = await tx.publicationSchedule.updateMany({
      where,
      data: {
        status: PublicationScheduleStatus.ERROR,
        nextMaterializeAt: null,
        lastError: message,
      },
    });
    if (failed.count === 0) return false;
    const publication = await tx.publication.updateMany({
      where: {
        id: schedule.publicationId,
        lifecycle: PublicationLifecycle.ACTIVE,
        version: publicationVersion,
      },
      data: { lifecycle: PublicationLifecycle.ERROR },
    });
    if (publication.count !== 1) throw new Error('Publication recurrence recovery fence changed');
    return true;
  });
  if (!changed) return true;
  logger.warn(
    { scheduleId: schedule.id, publicationId: schedule.publicationId, err: message },
    'Failed to materialize publication recurrence',
  );
  return true;
}
