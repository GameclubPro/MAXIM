import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { MANAGED_BROADCAST_LOCK_STALE_MS } from './admin.service.support';
import { selectPublicationManagedBroadcastDueBatch } from './admin-managed-broadcast-due-selection';
import {
  buildPublisherTemporalEnrollment,
  type PublisherTemporalSelectionRollout,
} from './publisher-publication-temporal-enrollment';
import {
  buildPublisherTemporalExecutionDueQuery,
  withPublisherTemporalSelectionPlan,
  type PublisherTemporalCandidate,
} from './publisher-publication-temporal-selection';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

type PlanNode = {
  Plans?: PlanNode[];
  'Node Type'?: string;
  'Subplan Name'?: string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Alias?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
};
type Explained = Array<{
  'QUERY PLAN': Array<{ Plan: PlanNode; 'Execution Time': number }>;
}>;
type DeliveryOverrides = Partial<
  Pick<
    Prisma.ManagedBroadcastDeliveryCreateManyInput,
    | 'status'
    | 'attemptCount'
    | 'nextAttemptAt'
    | 'lockedAt'
    | 'lockToken'
    | 'remoteMessageId'
    | 'sentAt'
    | 'dispatchBlockerCode'
    | 'dispatchBlockedAt'
    | 'remoteMessageVerificationAbsentCount'
    | 'remoteMessageVerificationPresentCount'
    | 'remoteMessageVerificationNextAt'
    | 'remoteMessageVerificationLastError'
    | 'remoteMessageVerificationSource'
  >
>;
type Envelope = { id: string; occurrenceId: string };

function planNodes(plan: Explained): PlanNode[] {
  return descendants(plan[0]!['QUERY PLAN'][0]!.Plan);
}

function descendants(root: PlanNode): PlanNode[] {
  const nodes: PlanNode[] = [];
  const visit = (node: PlanNode) => {
    nodes.push(node);
    node.Plans?.forEach(visit);
  };
  visit(root);
  return nodes;
}

postgres('Publisher temporal selection boundaries on PostgreSQL', () => {
  let db: PrismaClient;
  let now: Date;
  let publicationId: string;
  let scheduleId: string;
  let contentRevisionId: string;
  let sourceChatId: string;
  let audienceSize: number;
  let envelopeSequence: number;
  let extraOwnedChatIds: string[];
  let ownedPublicationIds: string[];
  const botId = `temporal-${randomUUID()}`;
  const queries: Prisma.QueryEvent[] = [];
  const deliveryRoute = {
    dialogBotId: 'synthetic-temporal-dialog',
    publisherDialogContext: {
      version: 1,
      dialogBotId: 'synthetic-temporal-dialog',
      buttons: [],
    },
    publicationPolicyRevision: 0,
  } satisfies Pick<
    Prisma.ManagedBroadcastDeliveryCreateManyInput,
    'dialogBotId' | 'publisherDialogContext' | 'publicationPolicyRevision'
  >;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    const client = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    client.$on('query', (event) => queries.push(event));
    db = client;
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });

  beforeEach(async () => {
    now = new Date();
    envelopeSequence = 0;
    extraOwnedChatIds = [];
    ownedPublicationIds = [];
    audienceSize = 1;
    sourceChatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 10)}`) * 1_000_000n}`;
    await db.chat.create({ data: { id: sourceChatId, title: 'Synthetic temporal fixture' } });
    await createPublication();
    queries.length = 0;
  });

  async function createPublication(id?: string): Promise<void> {
    const publication = await db.publication.create({
      data: {
        ...(id ? { id } : {}),
        actorUserId: sourceChatId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        audienceMode: 'SNAPSHOT',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        contentRevisions: { create: { revision: 1, text: 'Synthetic temporal fixture' } },
        schedule: {
          create: { mode: 'NOW', status: 'ACTIVE', rule: { mode: 'now', timezone: 'UTC' } },
        },
        targets: { create: { targetChatId: sourceChatId, entityType: 'CHAT', position: 0 } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    ownedPublicationIds.push(publication.id);
    scheduleId = publication.schedule!.id;
    contentRevisionId = publication.contentRevisions[0]!.id;
  }

  afterEach(async () => {
    await db.publicationOccurrence.deleteMany({
      where: { publicationId: { in: ownedPublicationIds } },
    });
    await db.publication.deleteMany({ where: { id: { in: ownedPublicationIds } } });
    if (extraOwnedChatIds.length)
      await db.chat.deleteMany({ where: { id: { in: extraOwnedChatIds } } });
    await db.$executeRaw(Prisma.sql`
      DELETE FROM "chats"
      WHERE "id" IN (
        SELECT (${sourceChatId}::bigint - n)::text
        FROM generate_series(0, ${audienceSize - 1}::integer) AS n
      )
    `);
  });
  afterAll(async () => db?.$disconnect());

  const targetId = (index: number) => (BigInt(sourceChatId) - BigInt(index)).toString();
  const targets = (size = audienceSize) =>
    Array.from({ length: size }, (_, index) => targetId(index));

  async function extendAudience(size: number): Promise<void> {
    if (size <= audienceSize) return;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "chats" ("id", "title", "updated_at")
      SELECT (${sourceChatId}::bigint - n)::text, 'Synthetic temporal fixture', ${now}
      FROM generate_series(${audienceSize}::integer, ${size - 1}::integer) AS n
    `);
    const start = audienceSize;
    audienceSize = size;
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "publication_targets"
        ("id", "publication_id", "target_chat_id", "entity_type", "position")
      SELECT ${publicationId} || '-target-' || n::text,
        ${publicationId}, (${sourceChatId}::bigint - n)::text, 'CHAT', n
      FROM generate_series(${start}::integer, ${size - 1}::integer) AS n
    `);
  }

  async function envelope(
    offsetMs: number,
    options: {
      delivery?: DeliveryOverrides;
      deliveryCount?: number;
      savedTargets?: string[];
      deadline?: Date | null;
    } = {},
  ): Promise<Envelope> {
    envelopeSequence += 1;
    const occurrenceId = randomUUID();
    const id = `temporal-${randomUUID()}`;
    await db.publicationOccurrence.create({
      data: {
        id: occurrenceId,
        publicationId,
        scheduleId,
        contentRevisionId,
        scheduleRevision: 1,
        scheduledAt: new Date(now.getTime() - 600_000 + envelopeSequence),
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        deliveryDeadlineAt:
          options.deadline === undefined ? new Date(now.getTime() + 86_400_000) : options.deadline,
      },
    });
    await db.managedBroadcast.create({
      data: {
        id,
        sourceChatId,
        actorUserId: sourceChatId,
        targetChatIds: options.savedTargets ?? targets(),
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: new Date(now.getTime() + offsetMs),
        createdAt: new Date(now.getTime() - 600_000 + envelopeSequence),
      },
    });
    const deliveryCount = options.deliveryCount ?? audienceSize;
    if (deliveryCount > 0) {
      await db.managedBroadcastDelivery.createMany({
        data: Array.from(
          { length: deliveryCount },
          (_, index): Prisma.ManagedBroadcastDeliveryCreateManyInput => ({
            broadcastId: id,
            occurrenceIndex: 1,
            targetChatId: targetId(index),
            publicationOccurrenceId: occurrenceId,
            contentRevisionId,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            ...deliveryRoute,
            ...options.delivery,
          }),
        ),
      });
    }
    return { id, occurrenceId };
  }

  async function useDesignatedAudience(): Promise<{ chat: string; channel: string }> {
    const designated = [
      { id: '-78271094414679', entityType: 'CHAT' as const },
      { id: '-78271171091799', entityType: 'CHANNEL' as const },
    ];
    // FLAG: Reused designated rows are read-only; cleanup owns only rows inserted here.
    const created = await db.chat.createManyAndReturn({
      data: designated.map((target) => ({ ...target, title: 'Synthetic designated fixture' })),
      skipDuplicates: true,
      select: { id: true },
    });
    extraOwnedChatIds.push(...created.map(({ id }) => id));
    for (const target of designated)
      expect((await db.chat.findUniqueOrThrow({ where: { id: target.id } })).entityType).toBe(
        target.entityType,
      );
    await db.publicationTarget.deleteMany({ where: { publicationId } });
    await db.publicationTarget.createMany({
      data: designated.map((target, position) => ({
        publicationId,
        targetChatId: target.id,
        entityType: target.entityType,
        position,
      })),
    });
    return { chat: designated[0]!.id, channel: designated[1]!.id };
  }

  async function retarget(
    item: Envelope,
    targetChatId: string,
    entityType: 'CHAT' | 'CHANNEL',
  ): Promise<void> {
    await db.managedBroadcast.update({
      where: { id: item.id },
      data: { targetChatIds: [targetChatId], sourceChatId: targetChatId, entityType },
    });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId: item.id },
      data: { targetChatId },
    });
  }

  function query(rollout: PublisherTemporalSelectionRollout = '100', enrollment?: Prisma.Sql) {
    return buildPublisherTemporalExecutionDueQuery({
      now,
      staleLockBefore: new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS),
      scheduleModes: ['NOW'],
      enrollment: enrollment ?? buildPublisherTemporalEnrollment(rollout),
    });
  }

  const selected = async (
    rollout: PublisherTemporalSelectionRollout = '100',
    limit = 1,
    enrollment?: Prisma.Sql,
  ) =>
    (
      await withPublisherTemporalSelectionPlan(db, (tx) =>
        tx.$queryRaw<PublisherTemporalCandidate[]>(query(rollout, enrollment)),
      )
    )
      .filter((row) => row.state !== 'excluded_waiting')
      .slice(0, limit)
      .map(({ id }) => ({ id }));

  async function explain(sql: Prisma.Sql): Promise<Explained> {
    // FLAG: The connection is restricted to a disposable local race_test database above.
    return withPublisherTemporalSelectionPlan(db, (tx) =>
      tx.$queryRaw<Explained>(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`),
    );
  }

  function expectTemporalBounds(plan: Explained, maximumRows: number, requireIndex = false): void {
    const nodes = planNodes(plan);
    const parents = nodes.filter((node) => node['Subplan Name'] === 'CTE raw_execution_candidates');
    expect(parents).toHaveLength(1);
    expect(parents[0]!['Actual Rows']).toBeLessThanOrEqual(64);
    expect(parents[0]!['Actual Loops']).toBe(1);
    const keyPages = nodes.filter((node) => node['Subplan Name'] === 'CTE temporal_delivery_keys');
    expect(keyPages.length).toBeGreaterThan(0);
    for (const keyPage of keyPages) {
      expect(keyPage['Actual Rows']).toBeLessThanOrEqual(maximumRows);
      expect(keyPage['Actual Loops']).toBeLessThanOrEqual(64);
      if (requireIndex)
        for (const node of descendants(keyPage))
          expect(node['Node Type']).not.toMatch(/Bitmap|Sort/);
    }
    const scalarPages = nodes.filter(
      (node) => node['Subplan Name'] === 'CTE temporal_delivery_page',
    );
    expect(scalarPages.length).toBeGreaterThan(0);
    for (const scalarPage of scalarPages) {
      expect(scalarPage['Actual Rows']).toBeLessThanOrEqual(Math.min(maximumRows, 64));
      expect(scalarPage['Actual Loops']).toBeLessThanOrEqual(64);
      if (requireIndex)
        for (const scan of descendants(scalarPage).filter(
          (node) =>
            node['Relation Name'] === 'managed_broadcast_deliveries' ||
            node['Index Name']?.startsWith('managed_broadcast_deliveries_'),
        )) {
          if (scan['Actual Loops']! > 0)
            expect(scan['Node Type']).toMatch(/^(Index (Only )?Scan|Bitmap (Heap|Index) Scan)$/);
          expect(
            (scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0),
          ).toBeLessThanOrEqual(64);
          expect(scan['Actual Loops']).toBeLessThanOrEqual(64);
        }
    }
    const keyScans = nodes.filter(
      (node) =>
        node.Alias === 'delivery_key_source' &&
        node['Relation Name'] === 'managed_broadcast_deliveries',
    );
    expect(keyScans.length).toBeGreaterThan(0);
    for (const scan of keyScans) {
      if (requireIndex) {
        expect(scan['Node Type']).toBe('Index Only Scan');
        expect(scan['Index Name']).toMatch(
          /^managed_broadcast_deliveries_broadcast_occurrence_(target_key|status_idx)$/,
        );
        expect(
          (scan['Actual Rows'] ?? 0) + (scan['Rows Removed by Filter'] ?? 0),
        ).toBeLessThanOrEqual(maximumRows);
      }
      expect(scan['Actual Rows']).toBeLessThanOrEqual(maximumRows);
      expect(scan['Actual Loops']).toBeLessThanOrEqual(64);
    }
    const scalarScans = nodes.filter(
      (node) =>
        node.Alias === 'delivery' && node['Relation Name'] === 'managed_broadcast_deliveries',
    );
    expect(scalarScans.length).toBeGreaterThan(0);
    for (const scan of scalarScans) {
      expect(scan['Actual Rows']).toBeLessThanOrEqual(Math.min(maximumRows, 64));
      expect(scan['Actual Loops']).toBeLessThanOrEqual(64);
    }
  }

  it('uses enrollment before limiting while off and unassigned test publications retain their old priority', async () => {
    const waiting = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000);
    expect(await selected('off')).toEqual([{ id: waiting.id }]);
    expect(await selected('test')).toEqual([{ id: waiting.id }]);
    expect(await selected('100')).toEqual([{ id: ready.id }]);
    const observed = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      1,
      'PUBLIK_V1',
      '100',
    );
    expect(observed.temporalSelection).toEqual({
      candidates: 2,
      unsupported: 0,
      refused: 0,
      enrolled: 2,
      excludedWaiting: 1,
      preferredReturned: 1,
      fallbackReintroduced: 0,
      comparisonBatches: 1,
      changedDecisionBatches: 1,
      changedPositions: 1,
      newlySelected: 1,
      displaced: 1,
    });
    expect(
      (await selectPublicationManagedBroadcastDueBatch(db, ['NOW'], 1, 'PUBLIK_V1', 'test'))
        .temporalSelection,
    ).toMatchObject({ candidates: 2, refused: 2, enrolled: 0, excludedWaiting: 0 });
    const cohortKey = `publisher-temporal-v1:${Buffer.byteLength(botId)}:${botId}:${Buffer.byteLength(publicationId)}:${publicationId}`;
    const bucket = createHash('md5').update(cohortKey).digest().readUInt32BE(0) % 100;
    for (const mode of ['5', '25'] as const)
      expect(await selected(mode)).toEqual([{ id: bucket < Number(mode) ? ready.id : waiting.id }]);
  });

  it.each([
    { mode: 'ONCE' as const, rollout: 'off' as const, heads: 25, limit: 25 },
    { mode: 'NOW' as const, rollout: 'off' as const, heads: 10, limit: 10 },
    { mode: 'NOW' as const, rollout: 'test' as const, heads: 10, limit: 10 },
    { mode: 'NOW' as const, rollout: '100' as const, heads: 64, limit: 10 },
  ])(
    'selects ready $mode work beyond $heads fresh SEND owners with rollout $rollout',
    async ({ mode, rollout, heads, limit }) => {
      const waitingIds: string[] = [];
      for (let index = 0; index < heads; index += 1) {
        if (index > 0) await createPublication();
        if (mode === 'ONCE')
          await db.publicationSchedule.update({ where: { id: scheduleId }, data: { mode } });
        const waiting = await envelope(-120_000 + index, {
          delivery: {
            status: 'SENDING',
            attemptCount: 1,
            lockedAt: new Date(now.getTime() - 30_000),
            lockToken: `synthetic-fresh-owner-${index}`,
          },
        });
        waitingIds.push(waiting.id);
      }
      await createPublication();
      if (mode === 'ONCE')
        await db.publicationSchedule.update({ where: { id: scheduleId }, data: { mode } });
      const ready = await envelope(-1_000);
      const freshBefore = await db.managedBroadcastDelivery.findMany({
        where: { broadcastId: { in: waitingIds } },
        orderBy: { id: 'asc' },
      });

      const result = await selectPublicationManagedBroadcastDueBatch(
        db,
        [mode],
        limit,
        'PUBLIK_V1',
        rollout,
      );

      // FLAG: A waiting owner's receipt and lease remain untouched. Excluding it before
      // LIMIT gives a different accepted publication a turn; it never replays the owner.
      expect(result.dueRows[0]).toEqual({ id: ready.id });
      expect(
        await db.managedBroadcastDelivery.findMany({
          where: { broadcastId: { in: waitingIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(freshBefore);
      if (mode === 'NOW' && rollout === '100') {
        const candidates = await withPublisherTemporalSelectionPlan(db, (tx) =>
          tx.$queryRaw<PublisherTemporalCandidate[]>(query(rollout)),
        );
        expect(candidates).toEqual([{ id: ready.id, state: 'enrolled_kept' }]);
      }
    },
  );

  it('does not count a changed decision when a future candidate follows an already filled portion', async () => {
    const ready = await envelope(-60_000);
    await envelope(-1_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });

    const result = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      1,
      'PUBLIK_V1',
      '100',
    );

    expect(result.dueRows).toEqual([{ id: ready.id }]);
    expect(result.temporalSelection).toMatchObject({
      excludedWaiting: 1,
      preferredReturned: 1,
      fallbackReintroduced: 0,
      comparisonBatches: 1,
      changedDecisionBatches: 0,
      changedPositions: 0,
      newlySelected: 0,
      displaced: 0,
    });
  });

  it('does not count a changed decision when fallback restores the entire ordered baseline', async () => {
    const first = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const second = await envelope(-1_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });

    const result = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      2,
      'PUBLIK_V1',
      '100',
    );

    expect(result.dueRows).toEqual([{ id: first.id }, { id: second.id }]);
    expect(result.temporalSelection).toMatchObject({
      excludedWaiting: 2,
      preferredReturned: 0,
      fallbackReintroduced: 2,
      comparisonBatches: 1,
      changedDecisionBatches: 0,
      changedPositions: 0,
      newlySelected: 0,
      displaced: 0,
    });
  });

  it('compares final decisions after retaining an independent due verification reservation', async () => {
    await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000);
    const verification = await envelope(-120_000, {
      delivery: {
        status: 'SENT',
        sentAt: new Date(now.getTime() - 60_000),
        remoteMessageId: 'synthetic-temporal-reservation',
        remoteMessageVerificationNextAt: new Date(now.getTime() - 1_000),
      },
    });

    const result = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      2,
      'PUBLIK_V1',
      '100',
    );

    expect(result.dueRows).toEqual([{ id: ready.id }, { id: verification.id }]);
    expect(result.temporalSelection).toMatchObject({
      comparisonBatches: 1,
      changedDecisionBatches: 1,
      changedPositions: 1,
      newlySelected: 1,
      displaced: 1,
    });
  });

  it('recomputes verification overlap for each decision when a receipt appears after classification', async () => {
    const waiting = await envelope(-60_000, {
      delivery: {
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });
    const ready = await envelope(-1_000);
    // FLAG: This real SQL transition occurs after the bounded classifier, before the
    // separate verification query. Both pure merges must use the same newer receipt
    // inputs but independently remove their own execution/verification overlap.
    const receiptAfterClassification = db.$extends({
      query: {
        $queryRaw: async ({ args, query }) => {
          const result = await query(args);
          const statement: unknown = Array.isArray(args) ? args[0] : args;
          if (
            !statement ||
            typeof statement !== 'object' ||
            !('sql' in statement) ||
            typeof statement.sql !== 'string' ||
            !statement.sql.includes('raw_execution_candidates')
          )
            return result;
          await db.managedBroadcastDelivery.updateMany({
            where: { broadcastId: waiting.id },
            data: {
              status: 'SENT',
              lockedAt: null,
              lockToken: null,
              sentAt: new Date(now.getTime() - 60_000),
              remoteMessageId: 'synthetic-temporal-concurrent-receipt',
              remoteMessageVerificationNextAt: new Date(now.getTime() - 1_000),
            },
          });
          return result;
        },
      },
    });

    const selectionClient: Parameters<typeof selectPublicationManagedBroadcastDueBatch>[0] = {
      managedBroadcast: db.managedBroadcast,
      $transaction: receiptAfterClassification.$transaction.bind(receiptAfterClassification),
    };
    const result = await selectPublicationManagedBroadcastDueBatch(
      selectionClient,
      ['NOW'],
      2,
      'PUBLIK_V1',
      '100',
    );

    expect(result.dueRows).toEqual([{ id: ready.id }, { id: waiting.id }]);
    expect(result.temporalSelection).toMatchObject({
      excludedWaiting: 1,
      preferredReturned: 1,
      fallbackReintroduced: 0,
      comparisonBatches: 1,
      changedDecisionBatches: 1,
      changedPositions: 2,
      newlySelected: 0,
      displaced: 0,
    });
    expect(
      queries.filter((event) => event.query.includes('raw_execution_candidates')),
    ).toHaveLength(1);
  });

  it('keeps native hash cohorts stable and nested at the 5 and 25 percent boundaries', async () => {
    const fixturePrefix = publicationId;
    for (const expectedBucket of [4, 5, 24, 25, 99]) {
      let vectorId = '';
      for (let candidate = 0; candidate < 10_000; candidate += 1) {
        const id = `${fixturePrefix}-${expectedBucket}-${candidate}`;
        const key = `publisher-temporal-v1:${Buffer.byteLength(botId)}:${botId}:${Buffer.byteLength(id)}:${id}`;
        if (createHash('md5').update(key).digest().readUInt32BE(0) % 100 === expectedBucket) {
          vectorId = id;
          break;
        }
      }
      expect(vectorId).not.toBe('');
      // FLAG: Each vector receives a fresh publication before its immutable occurrences;
      // fixtures obey the same parent immutability trigger as runtime publications.
      await createPublication(vectorId);
      const waiting = await envelope(-60_000, {
        delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
      });
      const ready = await envelope(-1_000);
      for (const mode of ['5', '25', '100'] as const) {
        const expected = [{ id: expectedBucket < Number(mode) ? ready.id : waiting.id }];
        expect(await selected(mode)).toEqual(expected);
        expect(await selected(mode)).toEqual(expected);
      }
      await db.managedBroadcast.updateMany({
        where: { id: { in: [waiting.id, ready.id] } },
        data: { status: 'COMPLETED', nextSendAt: null },
      });
    }
  });

  it('enrolls designated test audiences and refuses a foreign historical sibling or publication target', async () => {
    const designated = await useDesignatedAudience();
    const waiting = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const historical = await envelope(-59_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000);
    await retarget(waiting, designated.chat, 'CHAT');
    await retarget(historical, designated.channel, 'CHANNEL');
    await retarget(ready, designated.chat, 'CHAT');
    await db.managedBroadcast.update({
      where: { id: historical.id },
      data: { status: 'COMPLETED', nextSendAt: null },
    });
    expect(await selected('test')).toEqual([{ id: ready.id }]);

    // FLAG: Historical envelopes still belong to whole-publication test enrollment.
    await db.managedBroadcast.update({
      where: { id: historical.id },
      data: { targetChatIds: [sourceChatId] },
    });
    expect(await selected('test')).toEqual([{ id: waiting.id }]);
    expect(await selected('100')).toEqual([{ id: ready.id }]);
    await db.managedBroadcast.update({
      where: { id: historical.id },
      data: { targetChatIds: [designated.channel] },
    });
    expect(await selected('test')).toEqual([{ id: ready.id }]);

    await db.publicationTarget.create({
      data: { publicationId, targetChatId: sourceChatId, entityType: 'CHAT', position: 2 },
    });
    expect(await selected('test')).toEqual([{ id: waiting.id }]);
    expect(await selected('100')).toEqual([{ id: waiting.id }]);
  });

  it('bounds the whole-publication occurrence history at 64 before expanding test-mode siblings', async () => {
    const designated = await useDesignatedAudience();
    const waiting = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000);
    await retarget(waiting, designated.chat, 'CHAT');
    await retarget(ready, designated.chat, 'CHAT');
    const addHistory = async (count: number) =>
      db.publicationOccurrence.createMany({
        data: Array.from(
          { length: count },
          (): Prisma.PublicationOccurrenceCreateManyInput => ({
            publicationId,
            scheduleId,
            contentRevisionId,
            scheduleRevision: 1,
            scheduledAt: new Date(now.getTime() - 1_000_000 - envelopeSequence++),
            status: 'SENT' as const,
            dispatchProfile: 'PUBLIK_V1' as const,
            requiredBotId: botId,
          }),
        ),
      });
    await addHistory(62);
    expect(await selected('test')).toEqual([{ id: ready.id }]);
    await addHistory(1);
    expect(await selected('test')).toEqual([{ id: waiting.id }]);
    expect(await selected('100')).toEqual([{ id: ready.id }]);
    const nodes = planNodes(await explain(query('test')));
    const occurrences = nodes.filter(
      (node) => node['Subplan Name'] === 'CTE temporal_publication_occurrence_page',
    );
    expect(occurrences.length).toBeGreaterThan(0);
    for (const occurrence of occurrences) expect(occurrence['Actual Rows']).toBe(65);
    for (const sibling of nodes.filter(
      (node) => node['Subplan Name'] === 'CTE temporal_sibling_page',
    ))
      expect(sibling['Actual Loops']).toBe(0);
  });

  it('preserves the old 70-row merge order beyond the temporal lookahead with two verification reservations', async () => {
    const ready: Envelope[] = [];
    for (let index = 0; index < 70; index += 1) ready.push(await envelope(-60_000 + index));
    const verification: Envelope[] = [];
    for (let index = 0; index < 2; index += 1)
      verification.push(
        await envelope(-120_000 + index, {
          delivery: {
            status: 'SENT',
            sentAt: new Date(now.getTime() - 86_400_000),
            remoteMessageId: `synthetic-verification-${index}`,
            remoteMessageVerificationNextAt: new Date(now.getTime() - 60_000),
          },
        }),
      );
    const expected = [...ready.slice(0, 68), ...verification].map(({ id }) => ({ id }));
    for (const mode of ['off', '100'] as const)
      expect(
        (await selectPublicationManagedBroadcastDueBatch(db, ['NOW'], 70, 'PUBLIK_V1', mode))
          .dueRows,
      ).toEqual(expected);
  });

  it('examines exactly the first 64 parents and leaves later heads to the unchanged fallback', async () => {
    const waiting: Envelope[] = [];
    for (let index = 0; index < 63; index += 1)
      waiting.push(
        await envelope(-120_000 + index, {
          delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
        }),
      );
    const atBoundary = await envelope(-60_000);
    const beyondBoundary = await envelope(-59_000);
    expect(await selected('100', 100)).toEqual([{ id: atBoundary.id }]);
    expectTemporalBounds(await explain(query('100')), 1);

    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId: atBoundary.id },
      data: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    expect(await selected('100')).toEqual([]);
    const fallback = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      1,
      'PUBLIK_V1',
      '100',
    );
    expect(fallback.dueRows).toEqual([{ id: waiting[0]!.id }]);
    expect(fallback.temporalSelection).toEqual({
      candidates: 64,
      unsupported: 0,
      refused: 0,
      enrolled: 64,
      excludedWaiting: 64,
      preferredReturned: 0,
      fallbackReintroduced: 1,
      comparisonBatches: 1,
      changedDecisionBatches: 0,
      changedPositions: 0,
      newlySelected: 0,
      displaced: 0,
    });
    expect(fallback.dueRows).not.toContainEqual({ id: beyondBoundary.id });

    const widerRequest = await selectPublicationManagedBroadcastDueBatch(
      db,
      ['NOW'],
      65,
      'PUBLIK_V1',
      '100',
    );
    expect(widerRequest.dueRows).toHaveLength(65);
    expect(new Set(widerRequest.dueRows.map((row) => row.id)).size).toBe(65);
  });

  it('checks at most 65 deliveries and retains the 65th-row sentinel without pretending the audience is complete', async () => {
    await extendAudience(64);
    const waiting = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000, { deliveryCount: 1 });
    // FLAG: The complete fixture is known here; literal enrollment isolates the delivery cap
    // from the separate policy's conservative refusal of compressed JSON snapshots.
    expect(await selected('100', 1, Prisma.sql`TRUE`)).toEqual([{ id: ready.id }]);
    await extendAudience(65);
    await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: waiting.id,
        occurrenceIndex: 1,
        targetChatId: targetId(64),
        publicationOccurrenceId: waiting.occurrenceId,
        contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        ...deliveryRoute,
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });
    expect(await selected('100', 1, Prisma.sql`TRUE`)).toEqual([{ id: waiting.id }]);
    expectTemporalBounds(await explain(query('100', Prisma.sql`TRUE`)), 65);
  });

  it('preserves missing recipients even when a different recipient makes the row counts equal', async () => {
    await extendAudience(2);
    const incomplete = await envelope(-60_000, {
      deliveryCount: 1,
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    await envelope(-1_000);
    expect(await selected()).toEqual([{ id: incomplete.id }]);
    await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: incomplete.id,
        occurrenceIndex: 1,
        targetChatId: targetId(2),
        publicationOccurrenceId: incomplete.occurrenceId,
        contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        ...deliveryRoute,
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });
    expect(await db.managedBroadcastDelivery.count({ where: { broadcastId: incomplete.id } })).toBe(
      2,
    );
    expect(await selected()).toEqual([{ id: incomplete.id }]);
  });

  it.each([0, 2])(
    'retains an envelope with an additional occurrence index %i before reading its audience',
    async (occurrenceIndex) => {
      const waiting = await envelope(-60_000, {
        delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
      });
      await db.managedBroadcastDelivery.create({
        data: {
          broadcastId: waiting.id,
          occurrenceIndex,
          targetChatId: sourceChatId,
          publicationOccurrenceId: waiting.occurrenceId,
          contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          ...deliveryRoute,
          nextAttemptAt: new Date(now.getTime() + 60_000),
        },
      });
      expect(
        await withPublisherTemporalSelectionPlan(db, (tx) =>
          tx.$queryRaw<PublisherTemporalCandidate[]>(query('100', Prisma.sql`TRUE`)),
        ),
      ).toEqual([{ id: waiting.id, state: 'refused' }]);
      const plan = await explain(query('100', Prisma.sql`TRUE`));
      for (const node of planNodes(plan).filter(
        (node) => node['Subplan Name'] === 'CTE temporal_delivery_page',
      ))
        expect(node['Actual Loops']).toBe(0);
      await envelope(-1_000);
      expect(await selected()).toEqual([{ id: waiting.id }]);
    },
  );

  it('retains legacy deadlines, expired work, stale SEND leases and saved receipt tails', async () => {
    const future = { nextAttemptAt: new Date(now.getTime() + 60_000) };
    const legacy = await envelope(-60_000, { deadline: null, delivery: future });
    const expired = await envelope(-59_000, {
      deadline: new Date(now.getTime() - 1),
      delivery: future,
    });
    const stale = await envelope(-58_000, {
      delivery: {
        status: 'SENDING',
        attemptCount: 1,
        lockedAt: new Date(now.getTime() - MANAGED_BROADCAST_LOCK_STALE_MS - 1),
        lockToken: 'synthetic-stale-lease',
      },
    });
    const receipt = await envelope(-57_000, { delivery: future });
    await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: receipt.id,
        occurrenceIndex: 1,
        targetChatId: targetId(1),
        publicationOccurrenceId: receipt.occurrenceId,
        contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        ...deliveryRoute,
        status: 'SENT',
        remoteMessageId: 'synthetic-receipt',
        sentAt: new Date(now.getTime() - 60_000),
      },
    });
    const ready = await envelope(-1_000);
    const expected = [legacy, expired, stale, receipt, ready].map(({ id }) => ({ id }));
    expect(await selected('100', 10, Prisma.sql`TRUE`)).toEqual(expected);
    expect(await selected('100', 10)).toEqual(expected);
  });

  it('uses the later capacity or blocker deadline and keeps prior attempts on the compatible path', async () => {
    const dueBlocker = await envelope(-60_000, {
      delivery: {
        dispatchBlockerCode: 'FUTURE_PROVIDER_CODE',
        dispatchBlockedAt: new Date(now.getTime() - 60_000),
      },
    });
    const laterCapacity = await envelope(-59_000, {
      delivery: {
        dispatchBlockerCode: 'FUTURE_PROVIDER_CODE',
        dispatchBlockedAt: new Date(now.getTime() - 60_000),
        nextAttemptAt: new Date(now.getTime() + 60_000),
      },
    });
    const recentBlocker = await envelope(-58_000, {
      delivery: {
        dispatchBlockerCode: 'FUTURE_PROVIDER_CODE',
        dispatchBlockedAt: new Date(now.getTime() - 59_999),
        nextAttemptAt: new Date(now.getTime() - 1),
      },
    });
    const priorAttempt = await envelope(-57_000, {
      delivery: { attemptCount: 1, nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    const ready = await envelope(-1_000);
    expect(await selected('100', 10)).toEqual(
      [dueBlocker, priorAttempt, ready].map(({ id }) => ({ id })),
    );
    expect(await selected('off', 10)).toEqual(
      [dueBlocker, laterCapacity, recentBlocker, priorAttempt, ready].map(({ id }) => ({ id })),
    );
  });

  it('defers future SEND owners while preserving other future clocks and verification recovery', async () => {
    const future = new Date(now.getTime() + 60_000);
    const overrides: DeliveryOverrides[] = [
      { status: 'SENDING', attemptCount: 1, lockedAt: future, lockToken: 'future-lease' },
      { dispatchBlockerCode: 'FUTURE_PROVIDER_CODE', dispatchBlockedAt: future },
      { remoteMessageVerificationAbsentCount: 1 },
      { remoteMessageVerificationPresentCount: 1 },
      { remoteMessageVerificationNextAt: future },
      { remoteMessageVerificationLastError: 'Synthetic old verification error' },
      { remoteMessageVerificationSource: 'AUTOMATED_STABLE' },
    ];
    const compatible: Envelope[] = [];
    for (const [index, delivery] of overrides.entries())
      compatible.push(
        await envelope(-60_000 + index, {
          delivery: { nextAttemptAt: future, ...delivery },
        }),
      );
    const occurrenceFuture = await envelope(-50_000, { delivery: { nextAttemptAt: future } });
    await db.publicationOccurrence.update({
      where: { id: occurrenceFuture.occurrenceId },
      data: { dispatchBlockerCode: 'FUTURE_PROVIDER_CODE', dispatchBlockedAt: future },
    });
    const ready = await envelope(-1_000);
    expect(await selected('100', 20)).toEqual(
      [...compatible.slice(1), occurrenceFuture, ready].map(({ id }) => ({ id })),
    );
  });

  it('refuses a large compressed JSON snapshot before expanding it even with only one delivery', async () => {
    const waiting = await envelope(-60_000, {
      delivery: { nextAttemptAt: new Date(now.getTime() + 60_000) },
    });
    await db.$executeRaw(Prisma.sql`
      UPDATE "managed_broadcasts"
      SET "target_chat_ids" = (
        SELECT jsonb_agg(${sourceChatId}::text) FROM generate_series(1, 50000)
      )
      WHERE "id" = ${waiting.id}
    `);
    const storage = await db.$queryRaw<Array<{ compression: string | null }>>(Prisma.sql`
      SELECT pg_column_compression("target_chat_ids") AS compression
      FROM "managed_broadcasts" WHERE "id" = ${waiting.id}
    `);
    expect(storage[0]!.compression).not.toBeNull();
    expect(await selected()).toEqual([{ id: waiting.id }]);
    const plan = await explain(query());
    expectTemporalBounds(plan, 1);
    for (const node of planNodes(plan).filter((node) => node['Node Type'] === 'Function Scan'))
      expect(node['Actual Rows']).toBeLessThanOrEqual(64);
  });

  it('preserves admission after a busy pool waits longer than the interactive default', async () => {
    const connection = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, {
        max: 1,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
      }),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let acquired!: () => void;
    let acquireFailed!: (error: unknown) => void;
    const occupied = new Promise<void>((resolve, reject) => {
      acquired = resolve;
      acquireFailed = reject;
    });
    const blocker = connection.$transaction(
      async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT 1`);
        acquired();
        await held;
      },
      { timeout: 10_000 },
    );
    void blocker.catch(acquireFailed);
    try {
      // FLAG: The first real SQL proves the only connection is occupied. Release
      // it after Prisma's old 2s admission limit, inside the actual pool's 5s wait.
      await occupied;
      const selection = withPublisherTemporalSelectionPlan(connection, (tx) =>
        tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`SELECT 1 AS value`),
      );
      const outcome = selection.then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 2_300));
      release();
      await blocker;
      expect(await outcome).toEqual({ value: [{ value: 1 }], error: null });
    } finally {
      release();
      await blocker.catch(() => undefined);
      await connection.$disconnect();
    }
  });

  it('restores planner settings on the same connection after success and rollback', async () => {
    const connection = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 1, statement_timeout: 10_000 }),
    });
    const settings = Prisma.sql`
      SELECT pg_backend_pid() AS pid, current_setting('enable_seqscan') AS seq,
        current_setting('enable_bitmapscan') AS bitmap, current_setting('jit') AS jit
    `;
    type Settings = { pid: number; seq: string; bitmap: string; jit: string };
    try {
      // FLAG: Use one disposable connection so a leaked session setting cannot hide
      // behind a different pooled connection. No production session is configured.
      await connection.$queryRaw(Prisma.sql`
        SELECT set_config('enable_seqscan', 'on', false),
          set_config('enable_bitmapscan', 'on', false), set_config('jit', 'on', false)
      `);
      const before = await connection.$queryRaw<Settings[]>(settings);
      const during = await withPublisherTemporalSelectionPlan(connection, (tx) =>
        tx.$queryRaw<Settings[]>(settings),
      );
      expect(during).toEqual([{ pid: before[0]!.pid, seq: 'off', bitmap: 'off', jit: 'off' }]);
      expect(await connection.$queryRaw<Settings[]>(settings)).toEqual(before);
      await expect(
        withPublisherTemporalSelectionPlan(connection, async (tx) => {
          expect(await tx.$queryRaw<Settings[]>(settings)).toEqual(during);
          throw new Error('synthetic temporal read failure');
        }),
      ).rejects.toThrow('synthetic temporal read failure');
      expect(await connection.$queryRaw<Settings[]>(settings)).toEqual(before);
    } finally {
      await connection.$disconnect();
    }
  });

  it.each([
    { statistics: 'initial', audience: 10_000 },
    { statistics: 'initial', audience: 50_000 },
    { statistics: 'stale', audience: 50_000 },
  ] as const)(
    'bounds temporal probes with $audience delivery rows and reports execution-query cost ($statistics statistics)',
    async ({ statistics, audience }) => {
      // FLAG: The scalar cap must reject this large envelope before publication-target proof.
      // Its publication projection intentionally stays small; this is not a full runtime
      // or materialization benchmark. The delivery history and saved JSON have equal size.
      const large = await envelope(-60_000, { savedTargets: targets(audience), deliveryCount: 0 });
      if (statistics === 'stale') {
        // FLAG: Keep a realistic all-distinct parent estimate after retired rows disappear.
        // The incoming 50k audience must remain bounded before auto-ANALYZE catches up.
        // All fixture parents belong to this test's chat and cascade away on cleanup.
        const retiredPrefix = `${large.id}-retired-`;
        await db.$executeRaw(Prisma.sql`
        INSERT INTO "managed_broadcasts" (
          "id", "source_chat_id", "actor_user_id", "target_chat_ids", "buttons", "status", "updated_at"
        )
        SELECT ${retiredPrefix} || n::text, ${sourceChatId}, ${sourceChatId},
          '[]'::jsonb, '[]'::jsonb, 'COMPLETED', ${now}
        FROM generate_series(1, 2048) AS n
      `);
        await db.$executeRaw(Prisma.sql`
        INSERT INTO "managed_broadcast_deliveries" (
          "id", "broadcast_id", "occurrence_index", "target_chat_id", "updated_at"
        )
        SELECT ${retiredPrefix} || n::text, ${retiredPrefix} || n::text, 1, ${sourceChatId}, ${now}
        FROM generate_series(1, 2048) AS n
      `);
        await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
        await db.managedBroadcast.deleteMany({
          where: { sourceChatId, id: { startsWith: retiredPrefix } },
        });
      }
      await db.$executeRaw(Prisma.sql`
      INSERT INTO "managed_broadcast_deliveries" (
        "id", "broadcast_id", "occurrence_index", "target_chat_id",
        "publication_occurrence_id", "content_revision_id", "dispatch_profile", "required_bot_id",
        "dialog_bot_id", "publisher_dialog_context", "publication_policy_revision",
        "next_attempt_at", "updated_at"
      )
      SELECT ${large.id} || '-delivery-' || n::text, ${large.id}, 1,
        (${sourceChatId}::bigint - n)::text, ${large.occurrenceId}, ${contentRevisionId},
        'PUBLIK_V1', ${botId}, ${deliveryRoute.dialogBotId},
        ${JSON.stringify(deliveryRoute.publisherDialogContext)}::jsonb, 0,
        ${new Date(now.getTime() + 60_000)}, ${now}
      FROM generate_series(0, ${audience - 1}::integer) AS n
    `);
      const saturatedPlan = await explain(query('100'));
      console.info('Publisher temporal saturated key-page plan', JSON.stringify(saturatedPlan));
      expectTemporalBounds(saturatedPlan, 65, true);
      for (const node of planNodes(saturatedPlan).filter(
        (node) =>
          node['Subplan Name'] === 'CTE temporal_delivery_page' ||
          (node.Alias === 'delivery' && node['Relation Name'] === 'managed_broadcast_deliveries'),
      ))
        expect(node['Actual Loops']).toBe(0);
      const ready = await envelope(-1_000);
      expect(await db.managedBroadcastDelivery.count({ where: { broadcastId: large.id } })).toBe(
        audience,
      );
      expect(await selected()).toEqual([{ id: large.id }]);

      queries.length = 0;
      expect(
        (await selectPublicationManagedBroadcastDueBatch(db, ['NOW'], 1, 'PUBLIK_V1', 'off'))
          .dueRows,
      ).toEqual([{ id: large.id }]);
      const oldSelection = queries.find(
        (event) => /^SELECT\b/.test(event.query) && event.query.includes('"managed_broadcasts"'),
      );
      expect(oldSelection).toBeDefined();
      const parameters: unknown[] = JSON.parse(oldSelection!.params);
      const oldPlan = await db.$queryRawUnsafe<Explained>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${oldSelection!.query}`,
        ...parameters,
      );
      const beforeAnalyze = await explain(query('100'));
      console.info(
        'Publisher temporal local plans before assertions',
        JSON.stringify({ old: oldPlan, beforeAnalyze }),
      );
      expectTemporalBounds(beforeAnalyze, 65, true);
      await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
      const afterAnalyze = await explain(query('100'));
      console.info('Publisher temporal local plan after ANALYZE', JSON.stringify(afterAnalyze));
      expectTemporalBounds(afterAnalyze, 65, true);
      expect(await selected('100', 2)).toEqual([{ id: large.id }, { id: ready.id }]);
      const summarize = (plan: Explained) => ({
        durationMs: plan[0]!['QUERY PLAN'][0]!['Execution Time'],
        deliveryScans: planNodes(plan)
          .filter((node) => node['Relation Name'] === 'managed_broadcast_deliveries')
          .map((node) => ({
            alias: node.Alias,
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            filtered: node['Rows Removed by Filter'] ?? 0,
            buffers: (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0),
          })),
      });
      console.info(
        'Publisher temporal local plan evidence',
        JSON.stringify({
          audience,
          statistics,
          old: summarize(oldPlan),
          beforeAnalyze: summarize(beforeAnalyze),
          afterAnalyze: summarize(afterAnalyze),
        }),
      );
    },
  );
});
