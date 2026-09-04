import { PublicationOccurrenceStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

const PUBLICATION_ROLLUP_BATCH = 200;
const PUBLICATION_ROLLUP_RETRY_BATCH = 20;
const PUBLICATION_ROLLUP_RETRY_CAPACITY = PUBLICATION_ROLLUP_BATCH;

type PublicationOccurrenceRollupCursor = {
  scheduledAt: Date;
  id: string;
};

export class PublicationOccurrenceRollupScanner {
  private cursor: PublicationOccurrenceRollupCursor | null = null;
  private readonly retryQueue: string[] = [];
  private readonly queuedRetryIds = new Set<string>();

  async scan(options: {
    prisma: Pick<PrismaService, 'publicationOccurrence'>;
    rollup: (occurrenceId: string) => Promise<void>;
    onError: (occurrenceId: string, error: unknown) => void;
  }): Promise<void> {
    const retriedIds = new Set<string>();
    const retryCount = Math.min(PUBLICATION_ROLLUP_RETRY_BATCH, this.retryQueue.length);
    for (let attempt = 0; attempt < retryCount; attempt += 1) {
      const occurrenceId = this.retryQueue.shift();
      if (!occurrenceId) {
        break;
      }
      this.queuedRetryIds.delete(occurrenceId);
      retriedIds.add(occurrenceId);
      await this.rollupOrQueueRetry(options, occurrenceId);
    }

    const cursor = this.cursor;
    // FLAG: Advance on immutable schedule keys. Rows whose active status is unchanged must not
    // remain at the head of every bounded sweep and starve later Publisher occurrences.
    const rows = await options.prisma.publicationOccurrence.findMany({
      where: {
        status: {
          in: [
            PublicationOccurrenceStatus.SCHEDULED,
            PublicationOccurrenceStatus.IN_PROGRESS,
            PublicationOccurrenceStatus.AMBIGUOUS,
          ],
        },
        legacyBroadcasts: { some: { deliveries: { some: {} } } },
        ...(cursor
          ? {
              OR: [
                { scheduledAt: { gt: cursor.scheduledAt } },
                { scheduledAt: cursor.scheduledAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: PUBLICATION_ROLLUP_BATCH,
      select: { id: true, scheduledAt: true },
    });

    for (const row of rows) {
      if (!retriedIds.has(row.id)) {
        await this.rollupOrQueueRetry(options, row.id);
      }
    }

    const last = rows.at(-1);
    this.cursor =
      rows.length === PUBLICATION_ROLLUP_BATCH && last
        ? { scheduledAt: last.scheduledAt, id: last.id }
        : null;
  }

  private async rollupOrQueueRetry(
    options: {
      rollup: (occurrenceId: string) => Promise<void>;
      onError: (occurrenceId: string, error: unknown) => void;
    },
    occurrenceId: string,
  ): Promise<void> {
    try {
      await options.rollup(occurrenceId);
    } catch (error: unknown) {
      this.queueRetry(occurrenceId);
      options.onError(occurrenceId, error);
    }
  }

  private queueRetry(occurrenceId: string): void {
    if (
      this.queuedRetryIds.has(occurrenceId) ||
      this.retryQueue.length >= PUBLICATION_ROLLUP_RETRY_CAPACITY
    ) {
      return;
    }
    this.retryQueue.push(occurrenceId);
    this.queuedRetryIds.add(occurrenceId);
  }
}
