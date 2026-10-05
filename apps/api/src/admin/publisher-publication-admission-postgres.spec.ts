import { randomUUID } from 'node:crypto';
import { PrismaClient, createPrismaAdapter, Prisma } from '../prisma/prisma-client';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import { PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE } from './publication-dispatch-issue';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';
import { buildClearResolvedPublisherRecipientBlockerQuery } from './publisher-publication-recipient-admission';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(90_000);

integration('Publisher bounded recipient admission on PostgreSQL', () => {
  let db: PrismaClient;
  let chatIds: string[] = [];
  let publicationId: string;
  let broadcastId: string;
  let occurrenceId: string;
  let actorId: string;
  let runtime: AdminManagedBroadcastRuntime;
  let admission: jest.SpyInstance;
  const botId = `publisher-admission-${randomUUID()}`;
  const requestActorAccessRefresh = jest.fn().mockResolvedValue(undefined);
  const remoteSend = jest.fn();
  let beforeMutation: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });
  beforeEach(() => {
    requestActorAccessRefresh.mockClear();
    remoteSend.mockClear();
    beforeMutation = undefined;
    publicationId = '';
  });
  afterEach(async () => {
    if (publicationId) {
      await db.publicationOccurrence.deleteMany({ where: { publicationId } });
      await db.publication.delete({ where: { id: publicationId } });
    }
    for (let offset = 0; offset < chatIds.length; offset += 1_000)
      await db.chat.deleteMany({ where: { id: { in: chatIds.slice(offset, offset + 1_000) } } });
    chatIds = [];
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  function createRuntime() {
    const result = new AdminManagedBroadcastRuntime(
      {
        prisma: db,
        logger: { warn: jest.fn(), log: jest.fn() },
        publisherRuntimeBoundaryService: { assertDispatchEnabled: () => undefined },
        publisherDispatchHealthService: {
          assertDispatchAllowed: async () => undefined,
          recordSendSuccess: async () => undefined,
        },
        publisherReadinessService: {
          assertEntityReady: async () => ({ requiredBotId: botId, entityType: 'chat' }),
          requestActorAccessRefresh,
        },
        maxRoutedPublicationService: {
          publish: async (request: {
            entityId: string;
            publisherExactBotId: string;
            prepareAttempt: (context: { botId: string }) => Promise<unknown>;
            onDispatchAttempt: (context: { botId: string }) => Promise<void>;
            beforeSendMutation: (context: { botId: string }) => Promise<void>;
          }) => {
            expect(request.publisherExactBotId).toBe(botId);
            const context = { botId };
            await request.prepareAttempt(context);
            await request.onDispatchAttempt(context);
            await beforeMutation?.();
            await request.beforeSendMutation(context);
            remoteSend(request.entityId);
            return { messageId: `synthetic-${request.entityId}`, botId, url: null };
          },
        },
      } as never,
      'PUBLIK_V1',
    );
    // FLAG: Keep SQL claims, receipt persistence, admission and final author guards real.
    // Only media rendering, optional URL hydration and the synthetic MAX response are replaced.
    jest
      .spyOn((result as any).mediaRuntime, 'loadManagedBroadcastExecutionMedia')
      .mockResolvedValue({ requestMedia: {} });
    jest
      .spyOn((result as any).mediaRuntime, 'resolveManagedBroadcastExecutionMedia')
      .mockResolvedValue({});
    jest.spyOn((result as any).messageRuntime, 'buildMessage').mockResolvedValue({
      messageText: 'Synthetic admission fixture',
      messageOptions: undefined,
      commentDialogReference: null,
    });
    jest
      .spyOn((result as any).messageRuntime, 'recordDialogReference')
      .mockResolvedValue(undefined);
    jest
      .spyOn((result as any).publicationVerification, 'verifyAfterSend')
      .mockResolvedValue(new Set());
    admission = jest.spyOn((result as any).publisherDispatch, 'deferUnreadyBeforeClaim');
    return result;
  }

  async function fixture(size: number, blockedHead = 0) {
    const prefix = `admission-${randomUUID()}`;
    actorId = `${prefix}-actor`;
    chatIds = Array.from(
      { length: size },
      (_, index) => `${prefix}-${String(index).padStart(5, '0')}`,
    );
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
    for (let offset = 0; offset < size; offset += 1_000) {
      const chats = chatIds.slice(offset, offset + 1_000);
      await db.chat.createMany({
        data: chats.map((id) => ({ id, title: 'Synthetic admission fixture' })),
      });
      await db.publisherEntityBinding.createMany({
        data: chats.map(
          (chatId): Prisma.PublisherEntityBindingCreateManyInput => ({
            chatId,
            publisherBotId: botId,
            status: 'ACTIVE',
            botAccessState: 'CONFIRMED_ADMIN',
            botAccessCheckedAt: now,
            botAccessExpiresAt: expiresAt,
          }),
        ),
      });
      await db.managedEntityAccessEdge.createMany({
        data: chats.map((chatId, index): Prisma.ManagedEntityAccessEdgeCreateManyInput => {
          const position = offset + index;
          return {
            chatId,
            userId: actorId,
            botId,
            entityType: 'CHAT',
            state: position < blockedHead && position % 2 === 1 ? 'USER_DENIED' : 'GRANTED',
            userRole: 'ADMIN',
            botRole: 'ADMIN',
            checkedAt: position < blockedHead ? new Date(now.getTime() - 20 * 60_000) : now,
            expiresAt,
            source: 'publisher_targeted_user_access',
            sourceVersion: `${prefix}-proof-${position}`,
          };
        }),
      });
    }
    const publication = await db.publication.create({
      data: {
        actorUserId: actorId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        schedule: {
          create: {
            mode: 'ONCE',
            status: 'ACTIVE',
            rule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: now.toISOString(),
              replaceConflicts: false,
            },
          },
        },
        contentRevisions: { create: { revision: 1, text: 'Synthetic admission fixture' } },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    const revision = publication.contentRevisions[0]!.id;
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: publication.schedule!.id,
        contentRevisionId: revision,
        scheduleRevision: 1,
        scheduledAt: now,
        status: 'IN_PROGRESS',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      },
    });
    occurrenceId = occurrence.id;
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatIds[0]!,
        actorUserId: actorId,
        text: 'Synthetic admission fixture',
        targetChatIds: chatIds,
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: revision,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: now,
        scheduleMode: 'calendar',
        occurrences: {
          create: { sourceChatId: chatIds[0]!, occurrenceIndex: 1, scheduledAt: now },
        },
      },
    });
    broadcastId = broadcast.id;
    for (let offset = 0; offset < size; offset += 1_000)
      await db.managedBroadcastDelivery.createMany({
        data: chatIds.slice(offset, offset + 1_000).map(
          (targetChatId): Prisma.ManagedBroadcastDeliveryCreateManyInput => ({
            broadcastId,
            targetChatId,
            occurrenceIndex: 1,
            publicationOccurrenceId: occurrenceId,
            contentRevisionId: revision,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
            publicationPolicyRevision: 0,
          }),
        ),
      });
    runtime = createRuntime();
  }

  async function run() {
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { nextSendAt: new Date(Date.now() - 1) },
    });
    return (
      runtime as unknown as {
        processManagedBroadcastOccurrence(...args: unknown[]): Promise<unknown>;
      }
    ).processManagedBroadcastOccurrence(
      broadcastId,
      'deadline',
      new Date(Date.now() - 5 * 60_000),
      ['ACTIVE'],
    );
  }

  it('bounds probes to four and sends fresh recipients behind stale/denied heads in a 10,004-chat audience', async () => {
    await fixture(10_004, 4);
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(0, 4));
    expect(requestActorAccessRefresh).toHaveBeenCalledTimes(4);
    expect(remoteSend).not.toHaveBeenCalled();
    const blocked = await db.managedBroadcastDelivery.findMany({
      where: { broadcastId, targetChatId: { in: chatIds.slice(0, 4) } },
    });
    expect(blocked).toHaveLength(4);
    expect(
      blocked.every(
        (delivery) =>
          delivery.status === 'PENDING' &&
          delivery.attemptCount === 0 &&
          delivery.dispatchBlockerCode === PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
      ),
    ).toBe(true);
    runtime = createRuntime();
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(4, 8));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(4, 8));
    expect(
      await db.managedBroadcastDelivery.count({
        where: { broadcastId, status: 'SENT', attemptCount: 1 },
      }),
    ).toBe(4);
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'SENDING' } }),
    ).toBe(0);
    expect(
      await db.managedBroadcastDelivery.count({
        where: { broadcastId, status: 'PENDING', attemptCount: 0 },
      }),
    ).toBe(10_000);
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({ status: 'ACTIVE', lockedAt: null, lockToken: null });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE });
    await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
    const indexedProbe = async () => {
      const plan = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: unknown }> }>>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        ${buildClearResolvedPublisherRecipientBlockerQuery(occurrenceId, new Date())}
      `);
      const serialized = JSON.stringify(plan);
      expect(serialized).toContain('managed_broadcast_deliveries_pub_pending_blocker_idx');
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
      };
      visit(plan[0]!['QUERY PLAN'][0]!.Plan as Record<string, unknown>);
      const probe = nodes.find(
        (node) => node['Index Name'] === 'managed_broadcast_deliveries_pub_pending_blocker_idx',
      )!;
      expect(Number(probe['Actual Rows'])).toBeLessThanOrEqual(1);
      expect(Number(probe['Actual Loops'])).toBeLessThanOrEqual(1);
      expect(Number(probe['Rows Removed by Filter'] ?? 0)).toBe(0);
    };
    await indexedProbe();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE },
      data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
    });
    await db.$executeRawUnsafe('ANALYZE managed_broadcast_deliveries');
    await indexedProbe();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: null, dispatchBlockedAt: null });
  });

  it('recovers a quarantined recipient after healthy recipients while another author remains denied', async () => {
    await fixture(6);
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId, chatId: chatIds[0] },
      data: { state: 'USER_DENIED' },
    });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, targetChatId: chatIds[5] },
      data: {
        lastErrorCode: PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE,
        updatedAt: new Date(Date.now() - 15 * 60_000),
      },
    });
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(0, 4));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(1, 4));
    runtime = createRuntime();
    await run();
    expect(admission.mock.calls.map((call) => call[1].targetChatId)).toEqual(chatIds.slice(4, 6));
    expect(remoteSend.mock.calls.map((call) => call[0])).toEqual(chatIds.slice(1, 6));
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[0] },
      }),
    ).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
    });
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[5] },
      }),
    ).toMatchObject({ status: 'SENT', attemptCount: 1, lastErrorCode: null });
  });

  it('retains the final author guard when authority expires after admission, without consuming an HTTP attempt', async () => {
    await fixture(1);
    beforeMutation = async () => {
      await db.managedEntityAccessEdge.updateMany({
        where: { chatId: chatIds[0], userId: actorId, botId },
        data: { checkedAt: new Date(Date.now() - 20 * 60_000) },
      });
    };
    await run();
    expect(admission).toHaveBeenCalledTimes(1);
    expect(remoteSend).not.toHaveBeenCalled();
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({ where: { broadcastId } }),
    ).toMatchObject({
      status: 'PENDING',
      attemptCount: 0,
      dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
      remoteMessageId: null,
    });
    expect(
      (
        await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } })
      ).nextSendAt!.getTime(),
    ).toBeGreaterThan(Date.now() + 50_000);
  });

  it('recovers receipts with expired authority before admission and stops remaining recipients after cancellation', async () => {
    await fixture(6, 6);
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId, targetChatId: chatIds[0] },
      data: {
        status: 'SENDING',
        remoteMessageId: 'synthetic-crash-receipt',
        lockedAt: new Date(Date.now() - 10 * 60_000),
        attemptCount: 1,
      },
    });
    await run();
    expect(
      await db.managedBroadcastDelivery.findFirstOrThrow({
        where: { broadcastId, targetChatId: chatIds[0] },
      }),
    ).toMatchObject({
      status: 'SENT',
      remoteMessageId: 'synthetic-crash-receipt',
      attemptCount: 1,
    });
    expect(admission).toHaveBeenCalledTimes(4);
    await db.publication.update({ where: { id: publicationId }, data: { lifecycle: 'CANCELED' } });
    admission.mockClear();
    await run();
    expect(admission).not.toHaveBeenCalled();
    expect(remoteSend).not.toHaveBeenCalled();
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'SENT' } }),
    ).toBe(1);
    expect(
      await db.managedBroadcastDelivery.count({ where: { broadcastId, status: 'CANCELED' } }),
    ).toBe(5);
  });

  it('clears the shared recipient signal after recovery while preserving explicit retry authorization', async () => {
    await fixture(4, 4);
    const retryAuthorizedAt = new Date();
    await db.publicationOccurrence.update({
      where: { id: occurrenceId },
      data: {
        dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
        dispatchBlockedAt: new Date(Date.now() - 120_000),
        retryAuthorizedAt,
      },
    });
    await db.managedBroadcastDelivery.updateMany({
      where: { broadcastId },
      data: {
        dispatchBlockerCode: PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
        dispatchBlockedAt: new Date(Date.now() - 120_000),
      },
    });
    await db.managedEntityAccessEdge.updateMany({
      where: { botId, userId: actorId },
      data: { state: 'GRANTED', checkedAt: new Date() },
    });
    await run();
    expect(remoteSend).toHaveBeenCalledTimes(4);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ dispatchBlockerCode: null, dispatchBlockedAt: null, retryAuthorizedAt });
    for (const dispatchBlockerCode of [
      'PUBLISHER_EXPLICIT_RETRY',
      'PUBLISHER_MISSED_WINDOW_REVIEW',
    ]) {
      await db.publicationOccurrence.update({
        where: { id: occurrenceId },
        data: { dispatchBlockerCode, dispatchBlockedAt: retryAuthorizedAt },
      });
      await db.$executeRaw(
        buildClearResolvedPublisherRecipientBlockerQuery(occurrenceId, new Date()),
      );
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
      ).toMatchObject({
        dispatchBlockerCode,
        dispatchBlockedAt: retryAuthorizedAt,
        retryAuthorizedAt,
      });
    }
  });
});
