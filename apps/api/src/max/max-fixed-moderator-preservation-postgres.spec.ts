import { randomUUID } from 'node:crypto';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import { buildBotAccessSnapshotPersistence } from './bot-access-snapshot.util';
import { FixedModeratorPreservationService } from './fixed-moderator-preservation.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;
integration('initial fixed moderator preservation with PostgreSQL', () => {
  let db: PrismaClient;
  let service: FixedModeratorPreservationService;
  let chatId: string;
  let sendJobId: string;
  const receiptQueries: Array<{ query: string; params: string }> = [];
  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    const logged = new PrismaClient({
      log: [{ emit: 'event', level: 'query' }],
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10000 }),
    });
    logged.$on('query', (event) => {
      if (
        event.query.trimStart().startsWith('SELECT') &&
        event.query.includes('"max_action_ledger"') &&
        event.query.includes('ORDER BY')
      ) {
        receiptQueries.push({ query: event.query, params: event.params });
        if (receiptQueries.length > 10) receiptQueries.shift();
      }
    });
    db = logged;
    service = new FixedModeratorPreservationService(
      db as never,
      {
        getPublisherBotDescriptor: () => ({ id: 'publisher' }),
        getBotById: (id: string) =>
          ['working', 'peer'].includes(id) ? { id, state: 'active' } : null,
      } as never,
    );
  });
  beforeEach(async () => {
    chatId = `preserve-${randomUUID()}`;
    sendJobId = randomUUID();
    const access = buildBotAccessSnapshotPersistence(
      {
        isAdmin: true,
        isOwner: false,
        permissionsKnown: true,
        permissions: ['read_all_messages', 'write', 'add_remove_members'],
      },
      { source: 'seed', now: new Date(Date.now() - 1000) },
    );
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Существующее сообщество',
        primaryBotId: 'working',
        botId: 'working',
        routingVersion: 4,
        routingState: 'READY',
        botMemberships: {
          create: ['working', 'peer'].map((botId) => ({
            botId,
            role: botId === 'working' ? 'PRIMARY' : 'STANDBY',
            ...access,
          })),
        },
      },
    });
    await db.maxActionLedgerEntry.create({
      data: {
        jobId: sendJobId,
        chatId,
        actionType: 'SEND_MESSAGE',
        status: 'SUCCEEDED',
        terminal: true,
        dispatchBotId: 'working',
        remoteMessageId: 'existing-notice',
        dispatchStartedAt: new Date(Date.now() - 100),
        completedAt: new Date(),
      },
    });
  });
  afterEach(async () => {
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('freezes the current executor and resumes the same committed result after a lost response', async () => {
    const before = await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: sendJobId } });
    expect(await service.explain(chatId)).toMatchObject({
      explainOnly: true,
      plans: expect.any(Array),
    });
    const plan = { ...(await service.preview(chatId)), operationId: randomUUID() };
    expect(plan).toMatchObject({ eligible: true, botId: 'working', routingVersion: 4 });
    const [one, two] = await Promise.all([service.preserve(plan), service.preserve(plan)]);
    expect(one).toEqual(two);
    expect(one.actorUserId).toBe('system:fixed-moderator-preservation');
    expect(await service.preserve({ ...plan, observedAt: '2020-01-01T00:00:00.000Z' })).toEqual(
      one,
    );
    expect(await db.chat.findUnique({ where: { id: chatId } })).toMatchObject({
      fixedModeratorBotId: 'working',
      primaryBotId: 'working',
      routingVersion: 5,
    });
    expect(await db.maxActionLedgerEntry.findUnique({ where: { jobId: sendJobId } })).toEqual(
      before,
    );
    expect(await db.auditLog.count({ where: { chatId, action: 'PRESERVE_MODERATOR' } })).toBe(1);
  });

  it('leaves split executors and uncertain effects in their existing mode', async () => {
    await db.maxActionLedgerEntry.update({
      where: { jobId: sendJobId },
      data: { dispatchBotId: 'peer' },
    });
    expect(await service.preview(chatId)).toMatchObject({
      eligible: false,
      reason: 'split_executor',
    });
    await db.maxActionLedgerEntry.update({
      where: { jobId: sendJobId },
      data: { status: 'AMBIGUOUS', ambiguous: true },
    });
    expect(await service.preview(chatId)).toMatchObject({
      eligible: false,
      reason: 'uncertain_effect',
    });
    expect(
      (await db.chat.findUniqueOrThrow({ where: { id: chatId } })).fixedModeratorBotId,
    ).toBeNull();
  });

  it('preserves the working moderator without changing independent Publisher receipts', async () => {
    const receipt = await db.maxActionLedgerEntry.create({
      data: {
        jobId: randomUUID(),
        chatId,
        actionType: 'SEND_MESSAGE',
        dispatchBotId: 'publisher',
        status: 'AMBIGUOUS',
        ambiguous: true,
        dispatchStartedAt: new Date(),
      },
    });
    const preview = await service.preview(chatId);
    expect(preview).toMatchObject({ eligible: true, botId: 'working' });
    await service.preserve({ ...preview, operationId: randomUUID() });
    expect(await db.maxActionLedgerEntry.findUnique({ where: { id: receipt.id } })).toEqual(
      receipt,
    );
  });

  it('requires confirmed work and refuses a saturated receipt window', async () => {
    await db.maxActionLedgerEntry.delete({ where: { jobId: sendJobId } });
    expect(await service.preview(chatId)).toMatchObject({
      eligible: false,
      reason: 'no_confirmation',
    });
    await db.maxActionLedgerEntry.createMany({
      data: Array.from({ length: 65 }, () => ({
        jobId: randomUUID(),
        chatId,
        actionType: 'SEND_MESSAGE',
      })),
    });
    expect(await service.preview(chatId)).toMatchObject({
      eligible: false,
      reason: 'receipt_limit',
    });
  });

  it('rechecks exact access and routing revision without promoting a peer', async () => {
    const plan = { ...(await service.preview(chatId)), operationId: randomUUID() };
    await db.chatBotMembership.update({
      where: { chatId_botId: { chatId, botId: 'working' } },
      data: { botAccessState: 'DENIED' },
    });
    await expect(service.preserve(plan)).rejects.toThrow('Existing executor');
    expect(await db.managedModeratorAssignment.count({ where: { chatId } })).toBe(0);
    expect(await db.chat.findUnique({ where: { id: chatId } })).toMatchObject({
      primaryBotId: 'working',
      fixedModeratorBotId: null,
    });
  });

  it('uses bounded ordered index probes with retained history, a hot window and an empty action', async () => {
    for (let batch = 0; batch < 6; batch += 1) {
      await db.maxActionLedgerEntry.createMany({
        data: Array.from({ length: 2000 }, (_, index) => ({
          jobId: randomUUID(),
          chatId,
          actionType: 'SEND_MESSAGE',
          updatedAt: new Date(
            Date.now() - (batch === 0 && index < 200 ? 1000 : 7 * 24 * 60 * 60_000),
          ),
        })),
      });
    }
    // Only the disposable database is analyzed; production uses plain EXPLAIN.
    await db.$executeRawUnsafe('ANALYZE max_action_ledger');
    receiptQueries.length = 0;
    expect(await service.preview(chatId)).toMatchObject({ reason: 'receipt_limit' });
    const captured = [...receiptQueries];
    expect(captured.length).toBe(1);
    type Plan = {
      'Node Type': string;
      'Index Name'?: string;
      'Actual Rows': number;
      Plans?: Plan[];
    };
    const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap(flatten)];
    for (const action of ['SEND_MESSAGE', 'UNBAN_MEMBER']) {
      const statement = captured[0]!;
      const params = (JSON.parse(statement.params) as unknown[]).map((value) =>
        value === 'SEND_MESSAGE' ? action : value,
      );
      const result = await db.$queryRawUnsafe<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`,
        ...params,
      );
      const nodes = flatten(result[0]!['QUERY PLAN'][0]!.Plan);
      expect(
        nodes.some((node) => node['Index Name'] === 'max_action_ledger_chat_action_updated_idx'),
      ).toBe(true);
      expect(nodes.some((node) => ['Seq Scan', 'Sort'].includes(node['Node Type']))).toBe(false);
      expect(nodes.every((node) => node['Actual Rows'] <= 65)).toBe(true);
    }
  });

  it('rejects substituted executors and changed preview digests atomically', async () => {
    const plan = { ...(await service.preview(chatId)), operationId: randomUUID() };
    await expect(service.preserve({ ...plan, botId: 'peer' })).rejects.toThrow('Existing executor');
    await expect(service.preserve({ ...plan, digest: '0'.repeat(64) })).rejects.toThrow(
      'Existing executor',
    );
    expect(await db.auditLog.count({ where: { chatId, action: 'PRESERVE_MODERATOR' } })).toBe(0);
  });
});
