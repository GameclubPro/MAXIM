import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { randomUUID } from 'node:crypto';

import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  WebhookExecutionClaimStatus,
  WebhookStatus,
} from '../prisma/prisma-client';
import { WebhookOutboxService } from './webhook-outbox.service';
import { webhookPayloadChange } from './webhook-payload-write';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

type OrderedWebhookHead = {
  id: string;
  createdAt: Date;
};

type OrderedWebhookHeadReader = {
  findOrderedWebhookHeadsForChats: (
    chatIds: readonly string[],
  ) => Promise<Map<string, OrderedWebhookHead>>;
  selectEnqueueCandidates: (
    now: Date,
    admission?: {
      degraded: boolean;
      batchSize: number;
      enqueueConcurrency: number;
      includeQueuedRepair: boolean;
      includeCompletedTimeoutRepair: boolean;
      expandSelectedChats: boolean;
    },
  ) => Promise<
    Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
    }>
  >;
  expandSelectedChatCandidates: (
    candidates: Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
      priority: number;
    }>,
    now: Date,
  ) => Promise<
    Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
      priority: number;
    }>
  >;
};

function collectExplainNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectExplainNodes);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectExplainNodes)];
}

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

describePostgres('PostgreSQL webhook outbox queries', () => {
  let prisma: PrismaClient;
  let reader: OrderedWebhookHeadReader;
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    const service = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(service, 'prisma', { value: prisma });
    Object.defineProperty(service, 'batchSize', { value: 100 });
    Object.defineProperty(service, 'manualClosePriorityCache', { value: new Map() });
    reader = service as OrderedWebhookHeadReader;
  });

  afterEach(async () => {
    if (createdEventIds.length === 0) {
      return;
    }
    await prisma.webhookEvent.deleteMany({
      where: { id: { in: createdEventIds.splice(0) } },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function preparationService() {
    return new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'on' }),
      {
        getStoredChatPrimaryBotId: async () => 'preparation-bot',
        observeStoredChatBotWebhook: async () => undefined,
      } as never,
    );
  }
  async function preparationReceipt() {
    const id = `preparation-${randomUUID()}`;
    const update = {
      updateId: id,
      botId: 'preparation-bot',
      type: 'message_created',
      message: {
        chatId: `-${randomUUID()}`,
        messageId: `message-${id}`,
        senderId: '',
        text: '',
        createdAt: new Date().toISOString(),
      },
    };
    createdEventIds.push(id);
    await prisma.webhookEvent.create({
      data: { id, dedupKey: id, botId: update.botId, rawPayload: {}, normalizedPayload: update },
    });
    return { id, update };
  }

  it.each([
    'persistAdminReadModels',
    'stageManagedEntityPendingBootstrap',
    'schedulePendingExecutionOwnerFailoverRecheck',
    'completeManagedEntityHandshake',
  ])('recovers the same durable receipt after failure in %s before READY', async (stage) => {
    const { id, update } = await preparationReceipt();
    const first = preparationService();
    jest
      .spyOn(first as never, stage as never)
      .mockRejectedValueOnce(new WebhookPreparationDeferredError('retry fixture', 1_000) as never);
    await expect(first.preparePersistedWebhookEvent(id, update)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    const pending = await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } });
    expect(pending).toMatchObject({ status: 'PENDING', preparedAt: null, leaseToken: null });
    expect((await prisma.webhookEvent.findUnique({ where: { id } }))!.status).toBe('RECEIVED');
    const restarted = preparationService();
    expect((await restarted.preparePersistedWebhookEvent(id, update)).prepared).toBe(true);
    const ready = await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } });
    expect(ready).toMatchObject({ id: pending!.id, status: 'READY', leaseToken: null });
    expect(ready!.preparedAt).not.toBeNull();
    await first.onModuleDestroy();
    await restarted.onModuleDestroy();
  });

  it('drains admitted preparation before shutdown and rejects new work without creating a claim', async () => {
    const { id, update } = await preparationReceipt();
    const service = preparationService();
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(
        service as unknown as { completeManagedEntityHandshake: () => Promise<void> },
        'completeManagedEntityHandshake',
      )
      .mockImplementation(async () => {
        reached();
        await gate;
      });
    const running = service.preparePersistedWebhookEvent(id, update);
    await started;
    expect(
      await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } }),
    ).toMatchObject({ preparedAt: null, status: 'PENDING' });
    const workers = service.stopWorkerAdmission();
    let drained = false;
    const draining = workers[0]!.pause(false).then(() => {
      drained = true;
    });
    await expect(
      service.preparePersistedWebhookEvent('not-admitted', update),
    ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
    expect(
      await prisma.webhookExecutionClaim.count({ where: { webhookEventId: 'not-admitted' } }),
    ).toBe(0);
    expect(drained).toBe(false);
    release();
    await Promise.all([running, draining]);
    expect(drained).toBe(true);
    expect(
      await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } }),
    ).toMatchObject({ status: 'READY' });
  });

  it('does not replay completed preparation for a mirrored receipt', async () => {
    const { id, update } = await preparationReceipt();
    const service = preparationService();
    await service.preparePersistedWebhookEvent(id, update);
    const mirrorId = `preparation-mirror-${randomUUID()}`;
    createdEventIds.push(mirrorId);
    const mirror = { ...update, updateId: mirrorId, botId: 'mirror-bot' };
    await prisma.webhookEvent.create({
      data: {
        id: mirrorId,
        dedupKey: mirrorId,
        botId: mirror.botId,
        rawPayload: {},
        normalizedPayload: mirror,
      },
    });
    const core = jest.spyOn(service as never, 'prepareWebhookEventCore' as never);
    expect((await service.preparePersistedWebhookEvent(mirrorId, mirror)).canonical).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(await prisma.webhookEvent.findUnique({ where: { id: mirrorId } })).toMatchObject({
      status: 'DUPLICATE',
    });
    await service.onModuleDestroy();
  });

  it('skips identical prepared JSON without changing the heap tuple and persists a changed owner', async () => {
    const id = `payload-noop-${randomUUID()}`;
    createdEventIds.push(id);
    const payload = { type: 'message_created', raw: { text: 'kept', attachments: [] } };
    await prisma.webhookEvent.create({
      data: {
        id,
        dedupKey: id,
        rawPayload: {},
        normalizedPayload: payload,
      },
    });
    const tuple = () => prisma.$queryRaw<Array<{ version: string }>>`
      SELECT xmin::text AS version FROM webhook_events WHERE id = ${id}
    `;
    const before = await tuple();
    // JSONB equality is semantic, including object key ordering.
    await expect(
      prisma.webhookEvent.updateMany(
        webhookPayloadChange(id, {
          raw: { attachments: [], text: 'kept' },
          type: 'message_created',
        }),
      ),
    ).resolves.toEqual({ count: 0 });
    expect(await tuple()).toEqual(before);
    const changed = { ...payload, executionOwnerBotId: 'owner' };
    await expect(
      prisma.webhookEvent.updateMany(webhookPayloadChange(id, changed)),
    ).resolves.toEqual({ count: 1 });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).normalizedPayload,
    ).toEqual(changed);
    await prisma.webhookEvent.update({ where: { id }, data: { status: WebhookStatus.PROCESSED } });
    await expect(
      prisma.webhookEvent.updateMany(webhookPayloadChange(id, payload)),
    ).resolves.toEqual({ count: 0 });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).normalizedPayload,
    ).toEqual(changed);
  });

  it('executes the bulk ordered-head query and returns the oldest event per chat', async () => {
    const suffix = randomUUID();
    const chatA = `outbox-chat-a-${suffix}`;
    const chatB = `outbox-chat-b-${suffix}`;
    const emptyChat = `outbox-chat-empty-${suffix}`;
    const firstCreatedAt = new Date('2026-08-15T08:00:00.000Z');
    const secondCreatedAt = new Date('2026-08-15T08:00:01.000Z');
    const eventAFirst = `outbox-a-1-${suffix}`;
    const eventASecond = `outbox-a-2-${suffix}`;
    const eventB = `outbox-b-1-${suffix}`;
    createdEventIds.push(eventAFirst, eventASecond, eventB);

    await prisma.webhookEvent.createMany({
      data: [
        {
          id: eventASecond,
          dedupKey: `outbox-dedup-a-2-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatA },
          },
          createdAt: secondCreatedAt,
        },
        {
          id: eventAFirst,
          dedupKey: `outbox-dedup-a-1-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_edited',
            message: { chatId: chatA },
          },
          createdAt: firstCreatedAt,
        },
        {
          id: eventB,
          dedupKey: `outbox-dedup-b-1-${suffix}`,
          status: WebhookStatus.FAILED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatB },
          },
          nextEnqueueAt: secondCreatedAt,
          createdAt: secondCreatedAt,
        },
      ],
    });

    const heads = await reader.findOrderedWebhookHeadsForChats([chatA, chatB, emptyChat]);

    expect(heads).toEqual(
      new Map([
        [chatA, { id: eventAFirst, createdAt: firstCreatedAt }],
        [chatB, { id: eventB, createdAt: secondCreatedAt }],
      ]),
    );
  });

  it.each(
    [false, true]
      .flatMap((degraded) =>
        ['received', 'failed', 'queued', 'background'].map((lane) => ({
          degraded,
          lane,
          batchSize: degraded ? 40 : 100,
        })),
      )
      .concat([{ degraded: true, lane: 'received', batchSize: 1 }]),
  )(
    'reaches middle backlog despite a blocked hot head and a growing tail (degraded=$degraded, lane=$lane, batch=$batchSize)',
    async ({ degraded, lane, batchSize }) => {
      Object.defineProperty(reader, 'enqueueScans', {
        value: new Map(),
        configurable: true,
        writable: true,
      });
      const suffix = randomUUID();
      const hotChat = `middle-hot-${suffix}`;
      const middleId = `middle-independent-${suffix}`;
      const half = degraded ? 1200 : 6000;
      const base = Date.parse('2026-08-16T00:00:00.000Z');
      const now = new Date(base + 100_000_000);
      const row = (index: number) => ({
        id: `middle-${String(index).padStart(6, '0')}-${suffix}`,
        dedupKey: `middle-${index}-${suffix}`,
        status:
          lane === 'received'
            ? WebhookStatus.RECEIVED
            : lane === 'failed'
              ? WebhookStatus.FAILED
              : WebhookStatus.QUEUED,
        nextEnqueueAt: lane === 'failed' ? new Date(base) : null,
        queueName: lane === 'background' ? 'moderation-background' : null,
        createdAt: new Date(base + index * 1000),
        rawPayload: {},
        normalizedPayload: { type: 'message_created', message: { chatId: hotChat } },
      });
      const rows = Array.from({ length: half * 2 + 1 }, (_, index) => row(index));
      rows[half] = {
        ...rows[half]!,
        id: middleId,
        normalizedPayload: {
          type: 'message_created',
          message: { chatId: `independent-${suffix}` },
        },
      };
      createdEventIds.push(...rows.map(({ id }) => id));
      for (let start = 0; start < rows.length; start += 1000)
        await prisma.webhookEvent.createMany({ data: rows.slice(start, start + 1000) });
      await prisma.webhookEvent.update({
        where: { id: rows[0]!.id },
        data: { nextEnqueueAt: new Date(now.getTime() + 60_000) },
      });
      let observed = false;
      for (let pass = 0; pass < 8; pass += 1) {
        const tail = { ...row(half * 2 + 1 + pass), createdAt: new Date(now.getTime() + pass + 1) };
        createdEventIds.push(tail.id);
        await prisma.webhookEvent.create({ data: tail });
        const candidates = await reader.selectEnqueueCandidates(
          new Date(now.getTime() + pass + 1),
          {
            degraded,
            batchSize,
            enqueueConcurrency: 2,
            includeQueuedRepair: true,
            includeCompletedTimeoutRepair: true,
            expandSelectedChats: false,
          },
        );
        observed ||= candidates.some(({ id }) => id === middleId);
      }
      expect(observed).toBe(true);
      if (!degraded && lane === 'received') {
        // FLAG: Model the settled receipt history when checking planner selectivity. A
        // tiny all-pending heap can correctly favor a sequential scan for a broad page.
        for (let offset = 0; offset < 50_000; offset += 1_000) {
          const history = Array.from({ length: 1_000 }, (_, index) => ({
            ...row(offset + index),
            id: `settled-${offset + index}-${suffix}`,
            dedupKey: `settled-${offset + index}-${suffix}`,
            status: WebhookStatus.PROCESSED,
            createdAt: new Date(base - 60_000),
          }));
          createdEventIds.push(...history.map(({ id }) => id));
          await prisma.webhookEvent.createMany({ data: history });
        }
        await prisma.$executeRaw`ANALYZE webhook_events`;
        const capture = jest.spyOn(prisma, '$queryRaw');
        await reader.selectEnqueueCandidates(now);
        const query = capture.mock.calls[0]![0] as Prisma.Sql;
        capture.mockRestore();
        const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
          Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
        );
        const nodes = collectExplainNodes(explained);
        const pools = nodes.filter((node) => node['Subplan Name'] === 'CTE page_pool');
        expect(pools).toHaveLength(5);
        expect(pools.every((node) => Number(node['Actual Rows']) <= 2500)).toBe(true);
        expect(
          nodes
            .filter(
              (node) =>
                node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'webhook_events',
            )
            .map((node) => ({
              node: node['Node Type'],
              rows: node['Actual Rows'],
              removed: node['Rows Removed by Filter'],
            })),
        ).toEqual([]);
        expect(query.sql).not.toMatch(/\bOFFSET\b/);
      }

      expect((await reader.findOrderedWebhookHeadsForChats([hotChat])).get(hotChat)?.id).toBe(
        rows[0]!.id,
      );
    },
    30_000,
  );

  it('does not skip capped distinct pages and safely repeats after cursor loss or a failed query', async () => {
    const service = reader as unknown as {
      enqueueScans?: Map<string, unknown>;
      prisma: PrismaClient;
    };
    service.enqueueScans = new Map();
    const suffix = randomUUID();
    const base = Date.parse('2026-08-17T00:00:00Z');
    const rows = Array.from({ length: 800 }, (_, index) => ({
      id: `scan-cap-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `scan-cap-${index}-${suffix}`,
      createdAt: new Date(base + index),
      status: WebhookStatus.RECEIVED,
      rawPayload: {},
      normalizedPayload: {
        type: 'message_created',
        message: { chatId: `scan-chat-${index}-${suffix}` },
      },
    }));
    createdEventIds.push(...rows.map(({ id }) => id));
    await prisma.webhookEvent.createMany({ data: rows });
    const now = new Date(base + 10_000);
    const observed = new Set<string>();
    for (let pass = 0; pass < 12; pass++) {
      for (const candidate of await reader.selectEnqueueCandidates(now)) observed.add(candidate.id);
      if (pass === 1) {
        const state = JSON.stringify([...service.enqueueScans.entries()]);
        const failure = jest
          .spyOn(prisma, '$queryRaw')
          .mockRejectedValueOnce(new Error('SQL unavailable'));
        await expect(reader.selectEnqueueCandidates(now)).rejects.toThrow('SQL unavailable');
        expect(JSON.stringify([...service.enqueueScans.entries()])).toBe(state);
        failure.mockRestore();
        service.enqueueScans = new Map(); // Process restart: durable rows are not advanced or removed.
      }
    }
    expect(rows.every(({ id }) => observed.has(id))).toBe(true);
  });

  it('collapses a 4k hot chat inside bounded lane scans without probing every global head', async () => {
    const suffix = randomUUID();
    const poisonChat = `outbox-poison-${suffix}`;
    const fencedChat = `outbox-fenced-${suffix}`;
    const lifecycleEventId = `outbox-lifecycle-${suffix}`;
    const [fencedHeadId, fencedNewerId] = [randomUUID(), randomUUID()].sort();
    const baseCreatedAt = new Date('2026-08-15T09:00:00.000Z');
    const tiedCreatedAt = new Date(baseCreatedAt.getTime() + 4_100_000);
    const now = new Date('2026-08-15T12:00:00.000Z');
    const poisonRows = Array.from({ length: 4_000 }, (_, index) => ({
      id: `outbox-poison-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `outbox-poison-dedup-${index}-${suffix}`,
      status: WebhookStatus.RECEIVED,
      rawPayload: {},
      normalizedPayload: {
        updateId: `outbox-poison-update-${index}-${suffix}`,
        type: 'message_created',
        message: {
          chatId: poisonChat,
          messageId: `outbox-poison-message-${index}-${suffix}`,
        },
      },
      createdAt: new Date(baseCreatedAt.getTime() + index * 1_000),
    }));
    createdEventIds.push(
      ...poisonRows.map((row) => row.id),
      lifecycleEventId,
      fencedHeadId,
      fencedNewerId,
    );

    await prisma.webhookEvent.createMany({
      data: [
        ...poisonRows,
        {
          id: lifecycleEventId,
          dedupKey: `outbox-lifecycle-dedup-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-lifecycle-update-${suffix}`,
            type: 'user_removed',
            chatId: fencedChat,
          },
          createdAt: tiedCreatedAt,
        },
        {
          id: fencedHeadId,
          dedupKey: `outbox-fenced-head-dedup-${suffix}`,
          status: WebhookStatus.FAILED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-fenced-head-update-${suffix}`,
            type: 'message_created',
            message: { chatId: fencedChat, messageId: `fenced-head-${suffix}` },
          },
          nextEnqueueAt: new Date(now.getTime() + 60_000),
          createdAt: tiedCreatedAt,
        },
        {
          id: fencedNewerId,
          dedupKey: `outbox-fenced-newer-dedup-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-fenced-newer-update-${suffix}`,
            type: 'message_edited',
            message: { chatId: fencedChat, messageId: `fenced-newer-${suffix}` },
          },
          createdAt: tiedCreatedAt,
        },
      ],
    });

    const candidates = await reader.selectEnqueueCandidates(now);
    const selectedTestIds = candidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));

    expect(selectedTestIds).toContain(poisonRows[0]!.id);
    expect(selectedTestIds).toContain(lifecycleEventId);
    expect(selectedTestIds.filter((id) => id.startsWith('outbox-poison-'))).toEqual([
      poisonRows[0]!.id,
    ]);
    expect(selectedTestIds).not.toContain(fencedHeadId);
    expect(selectedTestIds).toContain(fencedNewerId);
    await expect(reader.findOrderedWebhookHeadsForChats([fencedChat])).resolves.toEqual(
      new Map([[fencedChat, { id: fencedHeadId, createdAt: tiedCreatedAt }]]),
    );

    await prisma.webhookEvent.update({
      where: { id: fencedHeadId },
      data: { nextEnqueueAt: now },
    });
    const dueCandidates = await reader.selectEnqueueCandidates(now);
    const dueSelectedTestIds = dueCandidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));
    expect(dueSelectedTestIds).toContain(fencedHeadId);
    expect(dueSelectedTestIds).not.toContain(fencedNewerId);
    expect(dueSelectedTestIds).toContain(lifecycleEventId);

    const dueHead = dueCandidates.find((candidate) => candidate.id === fencedHeadId);
    if (!dueHead) {
      throw new Error('Expected the due ordered head to be selected');
    }
    const expandedCandidates = await reader.expandSelectedChatCandidates(
      [{ ...dueHead, priority: 5 }],
      now,
    );
    const expandedTestIds = expandedCandidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));
    expect(expandedTestIds).toContain(fencedHeadId);
    expect(expandedTestIds).toContain(fencedNewerId);
    expect(expandedTestIds).not.toContain(lifecycleEventId);

    const hotHead = dueCandidates.find((candidate) => candidate.id === poisonRows[0]!.id)!;
    const hotExpansion = await reader.expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(
      hotExpansion.filter((candidate) => candidate.id.startsWith('outbox-poison-')),
    ).toHaveLength(16);
    expect(hotExpansion.map((candidate) => candidate.id)).toContain(fencedNewerId);

    let capturedExpansionQuery: Prisma.Sql | null = null;
    const expansionCaptureService = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(expansionCaptureService, 'batchSize', { value: 100 });
    Object.defineProperty(expansionCaptureService, 'prisma', {
      value: {
        $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
          operation({
            $executeRaw: async () => 0,
            $queryRaw: async (query: Prisma.Sql) => {
              capturedExpansionQuery = query;
              return [];
            },
          }),
      },
    });
    await (expansionCaptureService as OrderedWebhookHeadReader).expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(capturedExpansionQuery).not.toBeNull();
    expect(capturedExpansionQuery!.sql).toContain('selected_chat_heads AS MATERIALIZED');
    expect(capturedExpansionQuery!.values.filter((value) => typeof value === 'number')).toEqual([
      16, 300,
    ]);
    const expansionPlan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${capturedExpansionQuery!}`,
    );
    const expansionNodes = collectExplainNodes(expansionPlan);
    expect(
      expansionNodes.some((node) => node['Index Name'] === 'webhook_events_ordered_chat_head_idx'),
    ).toBe(true);
    expect(
      expansionNodes.some(
        (node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'webhook_events',
      ),
    ).toBe(false);

    // Ineligible heads must consume the window, not trigger an unbounded search for due rows.
    await prisma.webhookEvent.updateMany({
      where: { id: { in: poisonRows.slice(0, 16).map((row) => row.id) } },
      data: { nextEnqueueAt: new Date(now.getTime() + 60_000) },
    });
    const fencedExpansion = await reader.expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(
      fencedExpansion.filter((candidate) => candidate.id.startsWith('outbox-poison-')),
    ).toEqual([{ ...hotHead, priority: 5 }]);
    expect(fencedExpansion.map((candidate) => candidate.id)).toContain(fencedNewerId);

    let capturedSelectionQuery: Prisma.Sql | null = null;
    const captureService = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(captureService, 'batchSize', { value: 100 });
    Object.defineProperty(captureService, 'prisma', {
      value: {
        $queryRaw: async (query: Prisma.Sql) => {
          capturedSelectionQuery = query;
          return [];
        },
      },
    });
    await (captureService as OrderedWebhookHeadReader).selectEnqueueCandidates(now);
    expect(capturedSelectionQuery).not.toBeNull();
    expect(capturedSelectionQuery!.sql).not.toContain('LATERAL');
    expect(capturedSelectionQuery!.values.filter((value) => value === 5_000)).toHaveLength(1);
    // Three unchanged oldest lanes split 5k; FAILED shares 4,800 due + 200 recovery rows.
    expect(capturedSelectionQuery!.values.filter((value) => value === 2_500)).toHaveLength(9);

    const plan = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL enable_seqscan = off`;
      return transaction.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${capturedSelectionQuery!}`,
      );
    });
    const planNodes = collectExplainNodes(plan);
    expect(planNodes.some((node) => node['Subplan Name'] === 'CTE ordered_message_head_ids')).toBe(
      false,
    );
    expect(planNodes.some((node) => node['Alias'] === 'ordered_chat_head_event')).toBe(false);
    expect(planNodes.filter((node) => node['Node Type'] === 'Limit').length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('cancels blocked optional expansion in PostgreSQL and releases its connection', async () => {
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE webhook_events IN ACCESS EXCLUSIVE MODE`;
        markLocked();
        await release;
      },
      { timeout: 5_000 },
    );
    try {
      await Promise.race([
        lockHeld,
        blocker.then(() => {
          throw new Error('Lock was not held');
        }),
      ]);
      await expect(
        reader.expandSelectedChatCandidates(
          [
            {
              id: randomUUID(),
              status: WebhookStatus.RECEIVED,
              createdAt: new Date(),
              normalizedPayload: {
                type: 'message_created',
                message: { chatId: 'expansion-timeout' },
              },
              priority: 5,
            },
          ],
          new Date(),
        ),
      ).rejects.toThrow(/statement timeout/u);
    } finally {
      releaseLock();
      await blocker;
    }
    await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
  });

  it('bounds timeout proof probes before filtering history while live receipts and due retries progress', async () => {
    (reader as unknown as { enqueueScans: Map<string, unknown> }).enqueueScans = new Map();
    const suffix = randomUUID();
    const base = Date.parse('2026-09-01T00:00:00Z');
    const now = new Date(base + 60_000);
    const history = Array.from({ length: 1_201 }, (_, index) => ({
      id: `timeout-bound-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `timeout-bound-${index}-${suffix}`,
      createdAt: new Date(base + index),
      status: WebhookStatus.FAILED,
      rawPayload: {},
      errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:fixture: retained`,
      normalizedPayload: {
        type: 'message_created',
        message: { chatId: `timeout-chat-${index}-${suffix}`, messageId: `message-${index}` },
      },
    }));
    const repair = history.at(-1)!;
    const due = {
      ...repair,
      id: `due-${suffix}`,
      dedupKey: `due-${suffix}`,
      nextEnqueueAt: now,
      normalizedPayload: { type: 'message_created', message: { chatId: `due-${suffix}` } },
    };
    const live = {
      ...due,
      id: `live-${suffix}`,
      dedupKey: `live-${suffix}`,
      status: WebhookStatus.RECEIVED,
      normalizedPayload: { type: 'message_created', message: { chatId: `live-${suffix}` } },
    };
    createdEventIds.push(...history.map(({ id }) => id), due.id, live.id);
    await prisma.webhookEvent.createMany({ data: [...history, due, live] });
    await prisma.webhookExecutionClaim.create({
      data: {
        id: `claim-${suffix}`,
        kind: 'EXECUTION',
        semanticKey: `timeout-bound-${suffix}`,
        webhookEventId: repair.id,
        status: WebhookExecutionClaimStatus.COMPLETED,
        preparedAt: now,
        completedAt: now,
      },
    });
    const capture = jest.spyOn(prisma, '$queryRaw');
    let query: Prisma.Sql;
    try {
      const first = await reader.selectEnqueueCandidates(now);
      query = capture.mock.calls[0]![0] as Prisma.Sql;
      expect(first.map(({ id }) => id)).toEqual(expect.arrayContaining([due.id, live.id]));
      // The completed row lies beyond the first physical recovery page. Checking all
      // historical claims before LIMIT would incorrectly reach it in this first pass.
      expect(first.map(({ id }) => id)).not.toContain(repair.id);
    } finally {
      capture.mockRestore();
    }
    const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query!}`,
    );
    const nodes = collectExplainNodes(explained);
    const rawPools = nodes.filter((node) =>
      ['CTE head_source', 'CTE page_source'].includes(String(node['Subplan Name'])),
    );
    expect(rawPools).toHaveLength(2);
    expect(rawPools.every((node) => Number(node['Actual Rows']) <= 100)).toBe(true);
    expect(
      nodes
        .filter((node) => node['Relation Name'] === 'webhook_execution_claims')
        .every((node) => Number(node['Actual Loops']) <= 200),
    ).toBe(true);
    let recovered = false;
    for (let pass = 0; pass < 14; pass++) {
      const candidates = await reader.selectEnqueueCandidates(now);
      expect(candidates.map(({ id }) => id)).toEqual(expect.arrayContaining([due.id, live.id]));
      recovered ||= candidates.some(({ id }) => id === repair.id);
      expect(candidates.every(({ id }) => [due.id, live.id, repair.id].includes(id))).toBe(true);
    }
    expect(recovered).toBe(true);
  });

  it('selects a retained snake-case mirror only from a clean completed semantic owner', async () => {
    const suffix = randomUUID();
    const chatId = `outbox-semantic-chat-${suffix}`;
    const messageId = `outbox-semantic-message-${suffix}`;
    const ownerId = `outbox-semantic-owner-${suffix}`;
    const mirrorId = `outbox-semantic-mirror-${suffix}`;
    const claimId = `outbox-semantic-claim-${suffix}`;
    const ownerCompletedAt = new Date('2026-08-15T11:00:01.000Z');
    const now = new Date('2026-08-15T12:00:00.000Z');
    const mirrorPayload = {
      update_id: `mirror-update-${suffix}`,
      bot_id: 'bot-mirror',
      type: 'message_created',
      message: { chat_id: chatId, message_id: messageId },
    };
    const ownerPayload = {
      update_id: `owner-update-${suffix}`,
      bot_id: 'bot-owner',
      type: 'message_created',
      message: { chat_id: chatId, message_id: messageId },
    };
    const semanticKey = buildWebhookSemanticEventKey(mirrorPayload);
    if (!semanticKey || semanticKey !== buildWebhookSemanticEventKey(ownerPayload)) {
      throw new Error('Expected snake-case bot envelopes to share one semantic key');
    }
    createdEventIds.push(ownerId, mirrorId);

    await prisma.webhookEvent.createMany({
      data: [
        {
          id: ownerId,
          dedupKey: `outbox-semantic-owner-dedup-${suffix}`,
          status: WebhookStatus.PROCESSED,
          botId: 'bot-owner',
          rawPayload: {},
          normalizedPayload: ownerPayload,
          processedAt: ownerCompletedAt,
          createdAt: new Date('2026-08-15T11:00:00.000Z'),
        },
        {
          id: mirrorId,
          dedupKey: `outbox-semantic-mirror-dedup-${suffix}`,
          status: WebhookStatus.FAILED,
          botId: 'bot-mirror',
          queueName: 'moderation-default-2',
          enqueueAttempts: 1,
          rawPayload: {},
          normalizedPayload: mirrorPayload,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-${suffix}: detached execution failed without a canonical claim`,
          queuedAt: new Date('2026-08-15T11:00:02.000Z'),
          createdAt: new Date('2026-08-15T11:00:00.100Z'),
        },
      ],
    });
    await prisma.webhookExecutionClaim.create({
      data: {
        id: claimId,
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: ownerId,
        status: WebhookExecutionClaimStatus.READY,
        preparedAt: new Date('2026-08-15T11:00:00.500Z'),
        leaseToken: `lease-${suffix}`,
        leaseExpiresAt: new Date('2026-08-15T11:05:00.000Z'),
      },
    });

    const transitionalCandidates = await reader.selectEnqueueCandidates(now);
    expect(transitionalCandidates.map(({ id }) => id)).not.toContain(mirrorId);

    await prisma.webhookExecutionClaim.update({
      where: { id: claimId },
      data: {
        status: WebhookExecutionClaimStatus.COMPLETED,
        completedAt: ownerCompletedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const completedCandidates = await reader.selectEnqueueCandidates(now);
    expect(completedCandidates.map(({ id }) => id)).toContain(mirrorId);

    const admissionWithoutTimeoutScan = {
      degraded: false,
      batchSize: 100,
      enqueueConcurrency: 4,
      includeQueuedRepair: true,
      includeCompletedTimeoutRepair: false,
      expandSelectedChats: true,
    };
    const pacedCandidates = await reader.selectEnqueueCandidates(now, admissionWithoutTimeoutScan);
    expect(pacedCandidates.map(({ id }) => id)).not.toContain(mirrorId);

    await prisma.webhookEvent.update({
      where: { id: mirrorId },
      data: { nextEnqueueAt: now },
    });
    const dueRetryCandidates = await reader.selectEnqueueCandidates(
      now,
      admissionWithoutTimeoutScan,
    );
    expect(dueRetryCandidates.map(({ id }) => id)).toContain(mirrorId);
    await prisma.webhookEvent.update({
      where: { id: mirrorId },
      data: { nextEnqueueAt: null },
    });

    await prisma.webhookEvent.update({
      where: { id: ownerId },
      data: {
        normalizedPayload: {
          ...ownerPayload,
          message: { chat_id: chatId, message_id: `different-${messageId}` },
        },
      },
    });
    const invalidOwnerCandidates = await reader.selectEnqueueCandidates(now);
    expect(invalidOwnerCandidates.map(({ id }) => id)).not.toContain(mirrorId);
  });
});
