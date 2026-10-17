import { randomUUID } from 'node:crypto';
import { PrismaClient, createPrismaAdapter, type Prisma } from '../prisma/prisma-client';
import { dispatchScheduledPublicationOccurrences } from './publication-occurrence-dispatcher';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
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
  let extraChatIds: string[];
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
    extraChatIds = [];
    chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
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
        targets: { create: { targetChatId: chatId, entityType: 'CHAT', position: 0 } },
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
    await db.chat.deleteMany({ where: { id: { in: [chatId, ...extraChatIds] } } });
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
    originalDeliveryDeadlineAt?: Date,
  ) {
    await db.publicationOccurrence.create({
      data: {
        ...occurrence(id, offsetMs),
        ...(originalDeliveryDeadlineAt ? { deliveryDeadlineAt: originalDeliveryDeadlineAt } : {}),
      },
    });
    return db.managedBroadcast.create({
      data: {
        id: `broadcast-${id}`,
        sourceChatId: chatId,
        actorUserId: chatId,
        targetChatIds: [chatId],
        buttons: [],
        publicationOccurrenceId: id,
        ...(originalDeliveryDeadlineAt ? { publicationContentRevisionId: contentRevisionId } : {}),
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
            ...(originalDeliveryDeadlineAt ? { contentRevisionId } : {}),
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
    // FLAG: Native suites share this disposable database. Compact every relation
    // in the selection joins: dead parent/broadcast pages also change join costs
    // and index choice even after ANALYZE reports the declared live distribution.
    // Keep the production indexes and planner settings unchanged.
    await db.$executeRawUnsafe(
      'VACUUM (FULL, ANALYZE) publication_occurrences, publications, publication_schedules, managed_broadcasts',
    );
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

  it('prefers ready modern NOW execution over older future retries and fresh delivery leases while retaining due verification and fallback', async () => {
    const prefix = randomUUID();
    const deadlineAt = new Date(now.getTime() + 86_400_000);
    const delayedIds: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const retry = await envelope(
        `${prefix}-future-retry-${index}`,
        -600_000 + index,
        { nextAttemptAt: new Date(now.getTime() + 60_000) },
        deadlineAt,
      );
      const sending = await envelope(
        `${prefix}-fresh-sending-${index}`,
        -500_000 + index,
        { status: 'SENDING', lockedAt: now, lockToken: `lease-${index}`, attemptCount: 1 },
        deadlineAt,
      );
      delayedIds.push(retry.id, sending.id);
    }
    const ready = await envelope(`${prefix}-ready`, -1_000, {}, deadlineAt);
    const verification = await envelope(
      `${prefix}-verification`,
      -2_000,
      {
        status: 'SENT',
        remoteMessageId: 'remote-due-verification',
        sentAt: new Date(now.getTime() - 60_000),
        remoteMessageVerificationNextAt: new Date(now.getTime() - 1_000),
      },
      deadlineAt,
    );

    const preferred = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      2,
      'PUBLIK_V1',
      '100',
    );

    expect(preferred.dueRows).toEqual([{ id: ready.id }, { id: verification.id }]);

    const withFallback = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      delayedIds.length + 2,
      'PUBLIK_V1',
      '100',
    );
    expect(withFallback.dueRows.slice(0, 2)).toEqual([{ id: ready.id }, { id: verification.id }]);
    expect(new Set(withFallback.dueRows.map((row) => row.id))).toEqual(
      new Set([ready.id, verification.id, ...delayedIds]),
    );
  });

  it('keeps an expired modern NOW envelope preferred for closure even when its pending retry is in the future', async () => {
    const prefix = randomUUID();
    const expired = await envelope(
      `${prefix}-expired`,
      -86_401_000,
      { nextAttemptAt: new Date(now.getTime() + 60_000) },
      new Date(now.getTime() - 1_000),
    );
    await envelope(`${prefix}-ready`, -1_000, {}, new Date(now.getTime() + 86_400_000));

    const batch = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      1,
      'PUBLIK_V1',
      '100',
    );

    expect(batch.dueRows).toEqual([{ id: expired.id }]);
  });

  it('keeps due receipt verification preferred within a modern NOW envelope whose pending retry is in the future', async () => {
    const prefix = randomUUID();
    const deadlineAt = new Date(now.getTime() + 86_400_000);
    const mixed = await envelope(
      `${prefix}-mixed`,
      -60_000,
      { nextAttemptAt: new Date(now.getTime() + 60_000) },
      deadlineAt,
    );
    const receiptTargetId = `${chatId}1`;
    await db.chat.create({ data: { id: receiptTargetId, title: 'Synthetic receipt target' } });
    extraChatIds.push(receiptTargetId);
    await db.publicationTarget.create({
      data: { publicationId, targetChatId: receiptTargetId, entityType: 'CHAT', position: 1 },
    });
    await db.managedBroadcast.update({
      where: { id: mixed.id },
      data: { targetChatIds: [chatId, receiptTargetId] },
    });
    await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: mixed.id,
        occurrenceIndex: 1,
        targetChatId: receiptTargetId,
        publicationOccurrenceId: mixed.publicationOccurrenceId,
        contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        dialogBotId: 'dialog-test',
        publisherDialogContext: { version: 1, dialogBotId: 'dialog-test', buttons: [] },
        publicationPolicyRevision: 0,
        status: 'SENT',
        remoteMessageId: 'remote-mixed-verification',
        sentAt: new Date(now.getTime() - 60_000),
        remoteMessageVerificationNextAt: new Date(now.getTime() - 1_000),
      },
    });
    await envelope(`${prefix}-ready`, -1_000, {}, deadlineAt);

    const batch = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      1,
      'PUBLIK_V1',
      '100',
    );

    expect(batch.dueRows).toEqual([{ id: mixed.id }]);
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

  it('wakes elapsed actor-readiness retries but preserves cooldown, quarantine and lifecycle fences', async () => {
    const pending = await envelope(randomUUID(), -60_000, {
      dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      dispatchBlockedAt: new Date(now.getTime() - 60_000),
    });
    const select = (at = now) =>
      selectNextPendingPublisherPublicationDeadline(db as never, at, ['NOW']);
    expect(await select(new Date(now.getTime() - 1))).toBeNull();
    expect(await select()).toEqual({ id: pending.id, nextSendAt: pending.nextSendAt });
    const update = (data: Prisma.ManagedBroadcastDeliveryUpdateManyMutationInput) =>
      db.managedBroadcastDelivery.updateMany({ where: { broadcastId: pending.id }, data });
    await expect(update({ dispatchBlockedAt: null })).rejects.toThrow(
      'managed_broadcast_deliveries_dispatch_blocker_check',
    );
    await update({
      dispatchBlockedAt: new Date(now.getTime() - 60_000),
      lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
    });
    expect(await select()).toBeNull();
    await update({ lastErrorCode: null, dispatchBlockerCode: 'PUBLISHER_RUNTIME_UNAVAILABLE' });
    expect(await select()).toBeNull();
    await update({ dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED', status: 'AMBIGUOUS' });
    expect(await select()).toBeNull();
    await update({ status: 'PENDING' });
    await db.publication.update({ where: { id: publicationId }, data: { lifecycle: 'CANCELED' } });
    expect(await select()).toBeNull();
  });
});
