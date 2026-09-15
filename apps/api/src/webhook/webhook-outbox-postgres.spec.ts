import { randomUUID } from 'node:crypto';

import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  WebhookExecutionClaimStatus,
  WebhookStatus,
} from '../prisma/prisma-client';
import { WebhookOutboxService } from './webhook-outbox.service';
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
    expect(capturedSelectionQuery!.values.filter((value) => value === 5_000)).toHaveLength(5);

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
