import { randomUUID } from 'node:crypto';
import { PrismaClient, createPrismaAdapter, type Prisma } from '../prisma/prisma-client';
import { dispatchScheduledPublicationOccurrences } from './publication-occurrence-dispatcher';
import {
  selectNextPendingPublisherPublicationDeadline,
  selectPublicationManagedBroadcastDueBatch,
} from './admin-managed-broadcast-due-selection';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const createClient = () =>
  new PrismaClient({
    adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
    log: [{ emit: 'event', level: 'query' }],
  });
jest.setTimeout(30_000);

postgres('Publication latency and fairness on PostgreSQL', () => {
  let db: ReturnType<typeof createClient>;
  let publicationId: string;
  let scheduleId: string;
  let contentRevisionId: string;
  let chatId: string;
  let now: Date;
  const queries: Prisma.QueryEvent[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = createClient();
    db.$on('query', (event) => queries.push(event));
    await db.$connect();
  });

  beforeEach(async () => {
    now = new Date();
    chatId = `latency-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Publication latency test' } });
    const publication = await db.publication.create({
      data: {
        actorUserId: chatId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        schedule: {
          create: {
            mode: 'NOW',
            status: 'ACTIVE',
            rule: { mode: 'now', timezone: 'Europe/Moscow' },
          },
        },
        contentRevisions: { create: { revision: 1, text: 'Test' } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    scheduleId = publication.schedule!.id;
    contentRevisionId = publication.contentRevisions[0]!.id;
    queries.length = 0;
  });

  afterEach(async () => {
    await db.publicationOccurrence.deleteMany({ where: { publicationId } });
    await db.publication.delete({ where: { id: publicationId } });
    await db.chat.delete({ where: { id: chatId } });
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  const occurrence = (id: string, offsetMs: number) => ({
    id,
    publicationId,
    scheduleId,
    contentRevisionId,
    scheduleRevision: 1,
    scheduledAt: new Date(now.getTime() + offsetMs),
    dispatchProfile: 'PUBLIK_V1' as const,
    requiredBotId: 'publisher-test',
  });

  async function envelope(
    id: string,
    offsetMs: number,
    delivery: Partial<Prisma.ManagedBroadcastDeliveryCreateManyInput>,
  ) {
    await db.publicationOccurrence.create({ data: occurrence(id, offsetMs) });
    return db.managedBroadcast.create({
      data: {
        id: `broadcast-${id}`,
        sourceChatId: chatId,
        actorUserId: chatId,
        targetChatIds: [chatId],
        buttons: [],
        publicationOccurrenceId: id,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        nextSendAt: new Date(now.getTime() + offsetMs),
        deliveries: {
          create: {
            occurrenceIndex: 1,
            targetChatId: chatId,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: 'publisher-test',
            dialogBotId: 'dialog-test',
            publisherDialogContext: { version: 1, dialogBotId: 'dialog-test', buttons: [] },
            publicationOccurrenceId: id,
            publicationPolicyRevision: 0,
            ...(delivery.dispatchBlockerCode ? { dispatchBlockedAt: now } : {}),
            ...delivery,
          },
        },
      },
    });
  }

  it('prepares fresh work ahead of thousands of older blockers, rotates recovery, and uses ordered indexes', async () => {
    const prefix = randomUUID();
    await db.publicationOccurrence.createMany({
      data: [
        ...Array.from({ length: 3_000 }, (_, i) => ({
          ...occurrence(`${prefix}-blocked-${i}`, -86_400_000 + i),
          dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
          dispatchBlockedAt: new Date(now.getTime() - 600_000 + i),
        })),
        ...Array.from({ length: 20 }, (_, i) => occurrence(`${prefix}-ready-${i}`, -1_000 + i)),
      ],
    });
    await db.$executeRawUnsafe('ANALYZE publication_occurrences');
    await db.$executeRawUnsafe('ANALYZE publications');
    await db.$executeRawUnsafe('ANALYZE publication_schedules');
    await db.$executeRawUnsafe('ANALYZE managed_broadcasts');
    const selected: string[] = [];
    const context = {
      prisma: db,
      logger: { warn: jest.fn() },
      publisherRouting: { blockedRetryBefore: () => new Date(now.getTime() - 60_000) },
      resolveTargets: async () => [{ chatId, entityType: 'chat', title: 'Test' }],
      createExecution: async (row: { id: string; dispatchBlockerCode: string | null }) => {
        selected.push(row.id);
        await db.publicationOccurrence.update({
          where: { id: row.id },
          data: row.dispatchBlockerCode ? { dispatchBlockedAt: now } : { status: 'IN_PROGRESS' },
        });
      },
    };
    queries.length = 0;
    await dispatchScheduledPublicationOccurrences(context as never, 2);
    expect(selected).toEqual([`${prefix}-ready-0`, `${prefix}-blocked-0`]);
    const selectionQueries = queries.filter(
      (event) =>
        event.query.startsWith('SELECT') &&
        event.query.includes('"publication_occurrences"') &&
        event.query.includes('ORDER BY'),
    );
    expect(selectionQueries).toHaveLength(2);
    const plans: string[] = [];
    for (const event of selectionQueries) {
      plans.push(
        JSON.stringify(
          await db.$queryRawUnsafe(
            `EXPLAIN (FORMAT JSON) ${event.query}`,
            ...JSON.parse(event.params),
          ),
        ),
      );
    }
    expect(plans[0]).toContain('publication_occurrences_ready_dispatch_idx');
    expect(plans[1]).toContain('publication_occurrences_blocked_dispatch_idx');
    await dispatchScheduledPublicationOccurrences(context as never, 2);
    expect(selected.slice(2)).toEqual([`${prefix}-ready-1`, `${prefix}-blocked-1`]);
  });

  it('does not let future verification rows consume the due verification page', async () => {
    const prefix = randomUUID();
    for (let i = 0; i < 12; i += 1) {
      await envelope(`${prefix}-future-${i}`, -600_000 + i, {
        status: 'SENT',
        remoteMessageId: `remote-${i}`,
        sentAt: new Date(now.getTime() - 60_000),
        remoteMessageVerificationNextAt: new Date(now.getTime() + 60_000),
      });
    }
    const due = await envelope(`${prefix}-due`, -60_000, {
      status: 'SENT',
      remoteMessageId: 'remote-due',
      sentAt: new Date(now.getTime() - 60_000),
      remoteMessageVerificationNextAt: new Date(now.getTime() - 1_000),
    });
    const batch = await selectPublicationManagedBroadcastDueBatch(
      db as never,
      ['NOW'],
      2,
      'PUBLIK_V1',
    );
    expect(batch.dueRows).toEqual([{ id: due.id }]);
    expect(await selectNextPendingPublisherPublicationDeadline(db as never)).toBeNull();
  });

  it('wakes pending NOW work while excluding blocked and fresh in-flight deliveries', async () => {
    const prefix = randomUUID();
    await envelope(`${prefix}-blocked`, -600_000, {
      dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
    });
    await envelope(`${prefix}-sending`, -500_000, { status: 'SENDING', lockedAt: now });
    const pending = await envelope(`${prefix}-pending`, -1_000, {});
    expect(await selectNextPendingPublisherPublicationDeadline(db as never, now, ['NOW'])).toEqual({
      id: pending.id,
      nextSendAt: pending.nextSendAt,
    });
    expect(
      await selectNextPendingPublisherPublicationDeadline(db as never, now, [
        'ONCE',
        'SLOTS',
        'RECURRENCE',
      ]),
    ).toBeNull();
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId: pending.id },
      data: { status: 'AMBIGUOUS' },
    });
    expect(await selectNextPendingPublisherPublicationDeadline(db as never)).toBeNull();
  });
});
