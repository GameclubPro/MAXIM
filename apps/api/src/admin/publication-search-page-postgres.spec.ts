import { randomUUID } from 'node:crypto';
import {
  Prisma,
  PrismaClient,
  PublicationDispatchProfile,
  createPrismaAdapter,
  type ManagedBroadcastDeliveryStatus,
  type PublicationOccurrenceStatus,
} from '../prisma/prisma-client';
import { selectPublicationSearchPage } from './publication-failed-page-query';
import { PublicationPresenterService } from './publication-presenter.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;

postgres('Publisher publication read models on PostgreSQL', () => {
  let db: PrismaClient;
  const scope = `publication-search-${randomUUID()}`;
  const publisherBotId = `${scope}-bot`;
  const otherBotId = `${scope}-other-bot`;
  const actorUserId = `${scope}-actor`;
  const chatId = `${scope}-target`;
  const unrelatedChatIds = Array.from({ length: 3_000 }, (_, index) => `${scope}-unused-${index}`);
  const createdIds: string[] = [];
  const updatedAt = new Date('2026-09-30T10:00:00Z');
  let fallbackId: string;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test database required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
    });
    await db.$connect();
    await db.chat.create({ data: { id: chatId, title: 'Major-only catalog title' } });
    await db.chat.createMany({
      data: unrelatedChatIds.map((id) => ({ id, title: 'Unrelated catalog target' })),
    });
    await db.managedBotChatCatalog.createMany({
      data: [
        { botId: publisherBotId, chatId, title: 'Publisher target needle', entityType: 'CHAT' },
        { botId: otherBotId, chatId, title: 'Other bot title', entityType: 'CHAT' },
        ...Array.from({ length: 3_000 }, (_, index) => ({
          botId: publisherBotId,
          chatId: `${scope}-unused-${index}`,
          title: 'Publisher target needle',
        })),
      ],
    });
    for (const [id, lifecycle, owner, title] of [
      ['z', 'ACTIVE', actorUserId, 'Scheduled first'],
      ['y', 'PAUSED', actorUserId, 'Scheduled second'],
      ['x', 'ACTIVE', `${scope}-another-actor`, 'Not owned'],
      ['draft', 'DRAFT', actorUserId, 'A literal 100%_done title'],
      ['history', 'COMPLETED', actorUserId, 'Old completed'],
    ] as const) {
      const row = await db.publication.create({
        data: {
          id: `${scope}-${id}`,
          actorUserId: owner,
          requestId: randomUUID(),
          lifecycle,
          title,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: publisherBotId,
          updatedAt,
          targets: { create: { targetChatId: chatId, entityType: 'CHAT', position: 0 } },
          schedule: {
            create: {
              mode: 'ONCE',
              status: lifecycle === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
              rule: { mode: 'once', timezone: 'Europe/Moscow', at: updatedAt.toISOString() },
            },
          },
        },
      });
      createdIds.push(row.id);
    }
    fallbackId = `${scope}-z`;
    const unrelatedPublications = Array.from({ length: 300 }, (_, index) => ({
      id: `${scope}-catalog-owner-${index}`,
      actorUserId: `${scope}-another-actor`,
      requestId: randomUUID(),
      lifecycle: 'ACTIVE' as const,
      updatedAt,
      dispatchProfile: 'PUBLIK_V1' as const,
      requiredBotId: publisherBotId,
    }));
    await db.publication.createMany({ data: unrelatedPublications });
    createdIds.push(...unrelatedPublications.map((row) => row.id));
    await db.publicationTarget.createMany({
      data: unrelatedChatIds.map((targetChatId, index) => ({
        publicationId: `${scope}-catalog-owner-${Math.floor(index / 10)}`,
        targetChatId,
        entityType: 'CHAT',
        position: index % 10,
      })),
    });
    await db.$executeRaw(Prisma.sql`ANALYZE managed_bot_chat_catalog`);
    await db.$executeRaw(Prisma.sql`ANALYZE publication_targets`);
    await db.$executeRaw(Prisma.sql`ANALYZE publications`);
  });

  afterAll(async () => {
    if (!db) return;
    await db.publication.deleteMany({ where: { id: { in: createdIds } } });
    await db.managedBotChatCatalog.deleteMany({
      where: { botId: { in: [publisherBotId, otherBotId] } },
    });
    await db.chat.deleteMany({ where: { id: { in: [chatId, ...unrelatedChatIds] } } });
    await db.$disconnect();
  });

  const page = (overrides: Record<string, unknown> = {}) =>
    selectPublicationSearchPage(db as never, {
      actorUserId,
      publisherBotId,
      dispatchProfile: 'PUBLIK_V1',
      view: 'plan',
      query: 'target needle',
      cursor: null,
      limit: 1,
      ...overrides,
    });

  it('limits an actor-scoped search page before hydration despite thousands of catalog matches', async () => {
    const first = await page();
    expect(first.map((row) => row.id)).toEqual([fallbackId]);
    const second = await page({
      cursor: {
        v: 1,
        updatedAt: updatedAt.toISOString(),
        id: first[0]!.id,
        view: 'plan',
        query: 'target needle',
      },
    });
    expect(second.map((row) => row.id)).toEqual([`${scope}-y`]);
  });

  it('preserves view, status and entity filters while isolating the exact active bot catalog', async () => {
    expect(await page({ query: 'Other bot title' })).toEqual([]);
    expect(await page({ query: 'Major-only catalog title' })).toEqual([]);
    expect((await page({ view: 'history' })).map((row) => row.id)).toEqual([`${scope}-history`]);
    expect((await page({ status: 'paused' })).map((row) => row.id)).toEqual([`${scope}-y`]);
    expect(await page({ entityType: 'channel' })).toEqual([]);
    expect((await page({ view: 'drafts', query: '100%_done' })).map((row) => row.id)).toEqual([
      `${scope}-draft`,
    ]);
    expect(await page({ view: 'drafts', query: '100%changed' })).toEqual([]);
  });

  it('uses the displayed chat ID fallback and keeps exact catalog lookup indexed', async () => {
    await db.managedBotChatCatalog.update({
      where: { botId_chatId: { botId: publisherBotId, chatId } },
      data: { title: '   ' },
    });
    let query: Prisma.Sql | null = null;
    const rows = await selectPublicationSearchPage(
      {
        $queryRaw: async (value: Prisma.Sql) => {
          query = value;
          return db.$queryRaw(value);
        },
      } as never,
      {
        actorUserId,
        publisherBotId,
        dispatchProfile: 'PUBLIK_V1',
        view: 'plan',
        query: chatId,
        cursor: null,
        limit: 1,
      },
    );
    expect(rows.map((row) => row.id)).toEqual([fallbackId]);
    const plan = await db.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON) ${query!}`);
    const planText = JSON.stringify(plan);
    expect(planText).toMatch(/managed_bot_chat_catalog_(?:pkey|chat_status_idx)/u);
    expect(planText).not.toContain('hashed SubPlan');
    expect(planText).toMatch(/publication_targets_publication_(?:position_key|target_key)/u);
    await db.managedBotChatCatalog.update({
      where: { botId_chatId: { botId: publisherBotId, chatId } },
      data: { status: 'REMOVED' },
    });
    expect(await page({ query: chatId })).toEqual([]);
  });

  async function createDispatchIssueFixture(input: {
    occurrenceStatus: PublicationOccurrenceStatus;
    occurrenceBlockerCode: string;
    deliveryStatus?: ManagedBroadcastDeliveryStatus;
    deliveryBlockerCode?: string;
    scheduleRevision?: number;
    occurrenceRevision?: number;
  }) {
    const publication = await db.publication.create({
      data: {
        id: `${scope}-issue-${randomUUID()}`,
        actorUserId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: publisherBotId,
        schedule: {
          create: {
            mode: 'ONCE',
            status: 'ACTIVE',
            revision: input.scheduleRevision ?? 1,
            rule: { mode: 'once', timezone: 'Europe/Moscow', at: updatedAt.toISOString() },
          },
        },
        contentRevisions: { create: { revision: 1 } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    createdIds.push(publication.id);
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId: publication.id,
        scheduleId: publication.schedule!.id,
        scheduleRevision: input.occurrenceRevision ?? publication.schedule!.revision,
        contentRevisionId: publication.contentRevisions[0]!.id,
        scheduledAt: updatedAt,
        status: input.occurrenceStatus,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: publisherBotId,
        dispatchBlockerCode: input.occurrenceBlockerCode,
        dispatchBlockedAt: updatedAt,
      },
    });
    if (input.deliveryStatus) {
      const broadcast = await db.managedBroadcast.create({
        data: {
          sourceChatId: chatId,
          actorUserId,
          targetChatIds: [chatId],
          buttons: [],
          publicationOccurrenceId: occurrence.id,
          publicationContentRevisionId: occurrence.contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: publisherBotId,
        },
      });
      await db.managedBroadcastDelivery.create({
        data: {
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId: chatId,
          status: input.deliveryStatus,
          lockedAt: input.deliveryStatus === 'SENDING' ? updatedAt : null,
          lockToken: input.deliveryStatus === 'SENDING' ? randomUUID() : null,
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: publisherBotId,
          dialogBotId: publisherBotId,
          publicationPolicyRevision: 1,
          publisherDialogContext: {
            version: 1,
            dialogBotId: publisherBotId,
            buttons: [],
            reference: null,
          },
          dispatchBlockerCode: input.deliveryBlockerCode,
          dispatchBlockedAt: input.deliveryBlockerCode ? updatedAt : null,
        },
      });
    }
    return { publication, occurrence };
  }

  const dispatchIssues = (publicationId: string) =>
    new PublicationPresenterService(db as never).loadPublicationDispatchIssues(
      [publicationId],
      actorUserId,
      PublicationDispatchProfile.PUBLIK_V1,
    );

  it.each(['CANCELED', 'FAILED'] as const)(
    'preserves a failed missed-window decision with a historical %s delivery and a future slot',
    async (deliveryStatus) => {
      const { publication, occurrence } = await createDispatchIssueFixture({
        occurrenceStatus: 'FAILED',
        occurrenceBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
        deliveryStatus,
        deliveryBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      });
      await db.publicationOccurrence.create({
        data: {
          publicationId: publication.id,
          scheduleId: publication.schedule!.id,
          scheduleRevision: publication.schedule!.revision,
          contentRevisionId: occurrence.contentRevisionId,
          scheduledAt: new Date('2026-10-01T16:30:00Z'),
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: publisherBotId,
        },
      });
      const issues = await dispatchIssues(publication.id);
      expect(issues.byPublicationId).toEqual(new Map([[publication.id, 'decision_required']]));
      expect(issues.byOccurrenceId).toEqual(new Map([[occurrence.id, 'decision_required']]));
    },
  );

  it.each([
    ['IN_PROGRESS', 'PENDING', 'PUBLISHER_MISSED_WINDOW_REVIEW'],
    ['SCHEDULED', 'SENDING', 'PUBLISHER_MISSED_WINDOW_REVIEW'],
    ['IN_PROGRESS', 'PENDING', 'BOT_ACCESS_EXPIRED'],
  ] as const)(
    'trusts an active %s occurrence with %s deliveries over its stale %s blocker',
    async (occurrenceStatus, deliveryStatus, occurrenceBlockerCode) => {
      const { publication, occurrence } = await createDispatchIssueFixture({
        occurrenceStatus,
        occurrenceBlockerCode,
        deliveryStatus,
        deliveryBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      });
      const issues = await dispatchIssues(publication.id);
      expect(issues.byPublicationId).toEqual(new Map([[publication.id, 'actor_access_required']]));
      expect(issues.byOccurrenceId).toEqual(new Map([[occurrence.id, 'actor_access_required']]));
    },
  );

  it('keeps a failed missed window visible before any execution delivery exists', async () => {
    const { publication, occurrence } = await createDispatchIssueFixture({
      occurrenceStatus: 'FAILED',
      occurrenceBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
    });
    const issues = await dispatchIssues(publication.id);
    expect(issues.byPublicationId).toEqual(new Map([[publication.id, 'decision_required']]));
    expect(issues.byOccurrenceId).toEqual(new Map([[occurrence.id, 'decision_required']]));
  });

  it('excludes a previous revision missed window while the new revision remains scheduled', async () => {
    const { publication, occurrence } = await createDispatchIssueFixture({
      occurrenceStatus: 'FAILED',
      occurrenceBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
      deliveryStatus: 'CANCELED',
      scheduleRevision: 2,
      occurrenceRevision: 1,
    });
    await db.publicationOccurrence.create({
      data: {
        publicationId: publication.id,
        scheduleId: publication.schedule!.id,
        scheduleRevision: 2,
        contentRevisionId: occurrence.contentRevisionId,
        scheduledAt: new Date('2026-10-01T16:30:00Z'),
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: publisherBotId,
      },
    });
    const issues = await dispatchIssues(publication.id);
    expect(issues.byPublicationId.size).toBe(0);
    expect(issues.byOccurrenceId.size).toBe(0);
  });
});
