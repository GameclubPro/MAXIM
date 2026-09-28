import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { recoverPublicationRecurrencePreparationFailure } from './publication-recurrence-recovery';
import { dispatchScheduledPublicationOccurrences } from './publication-occurrence-dispatcher';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;

postgres('Publication recurrence failure fencing on PostgreSQL', () => {
  let db: PrismaClient;
  let publicationId: string;
  const lockCalendar = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
    );
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test database required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
  });
  beforeEach(async () => {
    const publication = await db.publication.create({
      data: {
        actorUserId: `recovery-${randomUUID()}`,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        schedule: {
          create: { mode: 'RECURRENCE', status: 'ACTIVE', rule: {}, nextMaterializeAt: new Date() },
        },
      },
    });
    publicationId = publication.id;
  });
  afterEach(async () => {
    await db.publication.delete({ where: { id: publicationId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createPastOccurrence() {
    const schedule = await db.publicationSchedule.update({
      where: { publicationId },
      data: {
        mode: 'ONCE',
        rule: { mode: 'once', timezone: 'Europe/Moscow', at: '2026-01-01T00:00:00.000Z' },
      },
    });
    const content = await db.publicationContentRevision.create({
      data: { publicationId, revision: 1 },
    });
    return db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: schedule.id,
        scheduleRevision: schedule.revision,
        contentRevisionId: content.id,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        scheduledAt: new Date(Date.now() - 3_600_000),
      },
    });
  }

  it('preserves an explicit retry committed after a missed slot was selected', async () => {
    const occurrence = await createPastOccurrence();
    const retryAt = new Date();
    const createExecution = jest.fn();
    await dispatchScheduledPublicationOccurrences(
      {
        prisma: db as unknown as PrismaService,
        publisherRouting: {
          blockedRetryBefore: () => new Date(Date.now() - 60_000),
        } as unknown as PublicationPublisherRoutingService,
        logger: { warn: jest.fn() },
        resolveTargets: jest.fn(),
        createExecution,
        cancelFutureWork: jest.fn(),
        lockCalendar: async (tx) => {
          await db.publicationOccurrence.update({
            where: { id: occurrence.id },
            data: {
              dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
              dispatchBlockedAt: retryAt,
            },
          });
          await lockCalendar(tx);
        },
      },
      1,
      undefined,
      { publicationId },
    );
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      status: 'SCHEDULED',
      dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
      dispatchBlockedAt: retryAt,
    });
    expect(createExecution).not.toHaveBeenCalled();
  });

  it('keeps the first blocker timestamp when stale and fresh deferrals race', async () => {
    const occurrence = await createPastOccurrence();
    const routing = new PublicationPublisherRoutingService(
      db as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const error = new PublisherSetupRequiredException(['target'], 'policy_disabled');
    await routing.deferOccurrenceIfBlocked(occurrence, error);
    const first = await db.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    expect(first.dispatchFirstBlockedAt).toBeInstanceOf(Date);
    await routing.deferOccurrenceIfBlocked(occurrence, error);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      dispatchFirstBlockedAt: first.dispatchFirstBlockedAt,
      dispatchBlockedAt: first.dispatchBlockedAt,
    });
    await routing.deferOccurrenceIfBlocked(first, error);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      dispatchFirstBlockedAt: first.dispatchFirstBlockedAt,
    });
  });

  it.each(['edit', 'resume', 'cancel', 'content'] as const)(
    'does not overwrite a newer %s while waiting for the calendar lock',
    async (operation) => {
      const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
      let releaseEdit!: () => void;
      let enteredEdit!: () => void;
      let enteredRecovery!: () => void;
      const editReady = new Promise<void>((resolve) => {
        enteredEdit = resolve;
      });
      const editRelease = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const recoveryReady = new Promise<void>((resolve) => {
        enteredRecovery = resolve;
      });
      const editing = db.$transaction(async (tx) => {
        await lockCalendar(tx);
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            version: { increment: 1 },
            lifecycle: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
          },
        });
        if (operation !== 'content')
          await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: {
              revision: { increment: 1 },
              status: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
            },
          });
        enteredEdit();
        await editRelease;
      });
      await editReady;
      const recovery = recoverPublicationRecurrencePreparationFailure({
        prisma: db as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        error: new Error('Old preparation failed'),
        lockCalendar: async (tx) => {
          enteredRecovery();
          await lockCalendar(tx);
        },
      });
      await recoveryReady;
      releaseEdit();
      await Promise.all([editing, recovery]);
      const current = await db.publication.findUniqueOrThrow({
        where: { id: publicationId },
        include: { schedule: true },
      });
      expect(current.version).toBe(2);
      expect(current.lifecycle).toBe(operation === 'cancel' ? 'CANCELED' : 'ACTIVE');
      expect(current.schedule!.status).toBe(operation === 'cancel' ? 'CANCELED' : 'ACTIVE');
    },
  );

  it('rolls back the schedule error when the publication write fails', async () => {
    const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
    const failingDb = {
      $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          const fenced = new Proxy(tx, {
            get(target, key) {
              if (key === 'publication')
                return {
                  updateMany: async () => {
                    throw new Error('Injected write failure');
                  },
                };
              return Reflect.get(target, key);
            },
          });
          return run(fenced);
        }),
    };
    await expect(
      recoverPublicationRecurrencePreparationFailure({
        prisma: failingDb as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        error: new Error('Old preparation failed'),
        lockCalendar,
      }),
    ).rejects.toThrow('Injected write failure');
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { id: schedule.id } }),
    ).toMatchObject({ status: 'ACTIVE', nextMaterializeAt: schedule.nextMaterializeAt });
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      lifecycle: 'ACTIVE',
    });
  });
});
