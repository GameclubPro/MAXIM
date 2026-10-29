import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient, createPrismaAdapter, type Prisma } from '../prisma/prisma-client';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import { PublicationContentService } from './publication-content.service';
import { selectPublicationSearchPage } from './publication-failed-page-query';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationService } from './publication.service';
import { PublisherManagedBroadcastDispatch } from './publisher-managed-broadcast-dispatch';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import { findPublicationCalendarConflicts } from './publication-calendar-conflicts';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;

postgres('entity administrators share Publisher publications on PostgreSQL', () => {
  const prefix = `publication-admin-${randomUUID()}`;
  const botId = process.env.MAX_PUBLISHER_BOT_ID?.trim() || DEFAULT_MAX_PUBLISHER_BOT_ID;
  const creator = `${prefix}-creator`;
  const admin = { userId: `${prefix}-admin`, username: null, displayName: null };
  const outsider = { ...admin, userId: `${prefix}-outsider` };
  const chatId = `${prefix}-chat`;
  const privateChatId = `${prefix}-private`;
  const scope = publicationAdminScope(admin.userId, botId);
  const deliveryRoute = {
    dispatchProfile: 'PUBLIK_V1',
    requiredBotId: botId,
    dialogBotId: botId,
    publicationPolicyRevision: 1,
    publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [], reference: null },
  } satisfies Required<
    Pick<
      Prisma.ManagedBroadcastDeliveryCreateManyInput,
      | 'dispatchProfile'
      | 'requiredBotId'
      | 'dialogBotId'
      | 'publicationPolicyRevision'
      | 'publisherDialogContext'
    >
  >;
  const publications: string[] = [];
  let db: PrismaClient;
  let singleId: string;
  let multiId: string;
  let privateId: string;
  let draftId: string;
  let sharedAssetId: string;
  let privateAssetId: string;
  let presenter: PublicationPresenterService;
  let content: PublicationContentService;
  let service: PublicationService;
  const wake = { enqueueAfterCommittedMutation: jest.fn(), enqueueResolution: jest.fn() };

  async function createPublication(
    targets: string[],
    lifecycle: 'ACTIVE' | 'ERROR' | 'DRAFT' = 'ACTIVE',
  ) {
    const imageBytes = Buffer.from(`image:${targets.join(',')}`);
    const row = await db.publication.create({
      data: {
        actorUserId: creator,
        requestId: randomUUID(),
        title: `${prefix}-common`,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        lifecycle,
        targets: {
          create: targets.map((targetChatId, position) => ({
            targetChatId,
            position,
            entityType: 'CHAT',
          })),
        },
        schedule: {
          create: {
            mode: 'ONCE',
            status: lifecycle === 'DRAFT' ? 'DRAFT' : 'ACTIVE',
            rule: { mode: 'once', timezone: 'Europe/Moscow', at: '2026-11-01T12:00:00.000Z' },
          },
        },
        contentRevisions: {
          create: {
            revision: 1,
            text: 'Common shared content',
            assets: {
              create: {
                position: 0,
                asset: {
                  create: {
                    actorUserId: creator,
                    sha256: createHash('sha256').update(imageBytes).digest('hex'),
                    mimeType: 'image/png',
                    fileName: 'shared.png',
                    sizeBytes: imageBytes.length,
                    bytes: imageBytes,
                  },
                },
              },
            },
          },
        },
      },
      include: { schedule: true, contentRevisions: { include: { assets: true } } },
    });
    publications.push(row.id);
    await db.publication.update({
      where: { id: row.id },
      data: { canonicalContentRevisionId: row.contentRevisions[0]!.id },
    });
    return row;
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 2, statement_timeout: 10_000 }),
    });
    await db.$connect();
    await db.chat.createMany({
      data: [
        { id: chatId, title: 'Shared chat' },
        { id: privateChatId, title: 'Private chat' },
      ],
    });
    await db.managedBotChatCatalog.createMany({
      data: [
        { botId, chatId, entityType: 'CHAT', title: 'Shared target' },
        { botId, chatId: privateChatId, entityType: 'CHAT', title: 'Private target needle' },
      ],
    });
    await db.managedEntityAccessEdge.createMany({
      data: [
        {
          chatId,
          userId: admin.userId,
          botId,
          entityType: 'CHAT',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          checkedAt: new Date('2000-01-01Z'),
          expiresAt: new Date('2000-01-02Z'),
        },
        {
          chatId,
          userId: outsider.userId,
          botId: `${prefix}-major`,
          entityType: 'CHAT',
          state: 'GRANTED',
          userRole: 'OWNER',
          botRole: 'OWNER',
        },
      ],
    });
    const single = await createPublication([chatId]);
    singleId = single.id;
    sharedAssetId = single.contentRevisions[0]!.assets[0]!.assetId;
    const multi = await createPublication([chatId, privateChatId], 'ERROR');
    multiId = multi.id;
    const privatePublication = await createPublication([privateChatId]);
    privateId = privatePublication.id;
    privateAssetId = privatePublication.contentRevisions[0]!.assets[0]!.assetId;
    draftId = (await createPublication([], 'DRAFT')).id;
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId: multi.id,
        scheduleId: multi.schedule!.id,
        scheduleRevision: 1,
        contentRevisionId: multi.contentRevisions[0]!.id,
        scheduledAt: new Date('2026-11-01T12:00:00Z'),
        status: 'PARTIAL',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      },
    });
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: creator,
        targetChatIds: [chatId, privateChatId],
        buttons: [],
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        publicationOccurrenceId: occurrence.id,
        publicationContentRevisionId: occurrence.contentRevisionId,
      },
    });
    await db.managedBroadcastDelivery.createMany({
      data: [
        {
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId: chatId,
          status: 'SENT',
          botId,
          attemptCount: 1,
          sentAt: occurrence.scheduledAt,
          remoteMessageId: 'shared-receipt',
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          ...deliveryRoute,
        },
        {
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId: privateChatId,
          status: 'FAILED',
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          ...deliveryRoute,
          dispatchBlockerCode: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
          dispatchBlockedAt: occurrence.scheduledAt,
        },
      ],
    });
    presenter = new PublicationPresenterService(db as never);
    content = new PublicationContentService(db as never, {} as never);
    service = new PublicationService(
      db as never,
      content,
      presenter,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        requireNewRoute: () => ({ dispatchProfile: 'PUBLIK_V1', requiredBotId: botId }),
        async resolveAudienceTargets() {
          return [
            { chatId, entityType: 'chat', title: 'Shared target', avatarUrl: null, link: null },
          ];
        },
      } satisfies Pick<
        PublicationPublisherRoutingService,
        'requireNewRoute' | 'resolveAudienceTargets'
      > as never,
      wake as never,
      new ConfigService({ PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT: 'off' }),
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.managedBroadcast.deleteMany({ where: { actorUserId: creator } });
    await db.publication.deleteMany({ where: { id: { in: publications } } });
    await db.publicationAsset.deleteMany({
      where: { actorUserId: creator, contentLinks: { none: {} } },
    });
    await db.managedBotChatCatalog.deleteMany({
      where: { botId, chatId: { in: [chatId, privateChatId] } },
    });
    await db.chat.deleteMany({ where: { id: { in: [chatId, privateChatId] } } });
    await db.$disconnect();
  });

  it('accepts a second exact administrator despite an old TTL and preserves creator attribution', async () => {
    const details = await service.get(singleId, admin, 'PUBLIK_V1');
    expect(details.access?.canManageAllTargets).toBe(true);
    const result = await service.pause(
      singleId,
      admin,
      { requestId: `${prefix}-pause`, expectedRevision: 1 },
      'PUBLIK_V1',
    );
    expect(result.lifecycle).toBe('PAUSED');
    expect(
      await db.publication.findUnique({ where: { id: singleId }, select: { actorUserId: true } }),
    ).toEqual({ actorUserId: creator });
    expect(
      await db.publicationMutationRecord.findUnique({
        where: {
          actorUserId_requestId: { actorUserId: admin.userId, requestId: `${prefix}-pause` },
        },
      }),
    ).toMatchObject({ actorUserId: admin.userId, publicationId: singleId });
  });

  it('projects a multi-target publication and hides foreign failures, metadata and mutations', async () => {
    const details = await service.get(multiId, admin, 'PUBLIK_V1');
    expect(details.targets.map((target) => target.chatId)).toEqual([chatId]);
    expect(details.targetCount).toBe(1);
    expect(details.access?.canManageAllTargets).toBe(false);
    expect(details.lifecycle).toBe('ACTIVE');
    expect(details.delivery).toMatchObject({ total: 1, sent: 1, failed: 0 });
    expect(details.occurrences[0]).toMatchObject({ status: 'SENT', canRetry: false });
    expect(JSON.stringify(details)).not.toContain(privateChatId);
    const deliveries = await service.listDeliveries(multiId, admin, {}, 'PUBLIK_V1');
    expect(deliveries.items.map((item) => item.target.chatId)).toEqual([chatId]);
    await expect(
      service.pause(
        multiId,
        admin,
        { requestId: `${prefix}-forbidden`, expectedRevision: 1 },
        'PUBLIK_V1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      await db.publication.findFirst({
        where: { id: multiId, ...publicationAdminAccessWhere(scope, 'PUBLIK_V1', 'manage') },
      }),
    ).toBeNull();
  });

  it('scopes SQL search and failed filters before pagination', async () => {
    const page = (query: string, status?: 'failed') =>
      selectPublicationSearchPage(db as never, {
        actorUserId: admin.userId,
        publisherBotId: botId,
        dispatchProfile: 'PUBLIK_V1',
        view: 'plan',
        query,
        status,
        cursor: null,
        limit: 100,
      });
    expect(await page('Private target needle')).toEqual([]);
    expect(await page('', 'failed')).toEqual([]);
    expect((await page('Common shared content')).map((row) => row.id).sort()).toEqual(
      [singleId, multiId].sort(),
    );
  });

  it('lets the remaining administrator cancel a blocked author post only in their own target', async () => {
    const publication = await createPublication([privateChatId, chatId]);
    const receipts = [];
    for (const [index, status] of (
      ['PENDING', 'SENDING', 'SENT', 'AMBIGUOUS'] as const
    ).entries()) {
      const scheduledAt = new Date(Date.now() - 10_000 - index * 1000);
      const occurrence = await db.publicationOccurrence.create({
        data: {
          publicationId: publication.id,
          scheduleId: publication.schedule!.id,
          contentRevisionId: publication.contentRevisions[0]!.id,
          scheduleRevision: 1,
          scheduledAt,
          status: 'IN_PROGRESS',
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          deliveryDeadlineAt: new Date(Date.now() + 3_600_000),
        },
      });
      const broadcast = await db.managedBroadcast.create({
        data: {
          sourceChatId: chatId,
          actorUserId: creator,
          targetChatIds: [chatId, privateChatId],
          buttons: [],
          publicationOccurrenceId: occurrence.id,
          publicationContentRevisionId: occurrence.contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
        },
      });
      const own = await db.managedBroadcastDelivery.create({
        data: {
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId: chatId,
          status,
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          attemptCount: status === 'PENDING' ? 0 : 1,
          remoteMessageId: status === 'SENT' ? `${prefix}-sent` : null,
          sentAt: status === 'SENT' ? scheduledAt : null,
          botId: status === 'SENT' ? botId : null,
          lockedAt: status === 'SENDING' ? new Date() : null,
          lockToken: status === 'SENDING' ? `${prefix}-active-lease` : null,
          ...deliveryRoute,
        },
      });
      const foreign = await db.managedBroadcastDelivery.create({
        data: {
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId: privateChatId,
          status: 'PENDING',
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          ...deliveryRoute,
        },
      });
      await db.managedBroadcastCalendarReservation.createMany({
        data: [chatId, privateChatId].map((targetChatId) => ({
          broadcastId: broadcast.id,
          sourceChatId: chatId,
          targetChatId,
          entityType: 'CHAT',
          occurrenceIndex: 1,
          scheduledAt,
        })),
      });
      receipts.push({ own, foreign, occurrence });
    }
    const result = await service.cancel(
      publication.id,
      admin,
      { requestId: `${prefix}-cancel-own-target`, expectedRevision: 1 },
      'PUBLIK_V1',
    );
    expect(result.lifecycle).toBe('CANCELED');
    expect(result.targets.map((target) => target.chatId)).toEqual([chatId]);
    expect(await db.publication.findUniqueOrThrow({ where: { id: publication.id } })).toMatchObject(
      {
        lifecycle: 'ACTIVE',
        actorUserId: creator,
        version: 2,
      },
    );
    const targets = await db.publicationTarget.findMany({
      where: { publicationId: publication.id },
    });
    expect(targets.find((target) => target.targetChatId === chatId)).toHaveProperty(
      'canceledAt',
      expect.any(Date),
    );
    expect(targets.find((target) => target.targetChatId === privateChatId)).toHaveProperty(
      'canceledAt',
      null,
    );
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId: publication.id } }),
    ).toMatchObject({ status: 'ACTIVE', revision: 1 });
    for (const { own, foreign } of receipts) {
      const actual = await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: own.id } });
      if (own.status === 'PENDING')
        expect(actual).toMatchObject({ status: 'CANCELED', attemptCount: 0 });
      else expect(actual).toEqual(own);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: foreign.id } }),
      ).toEqual(foreign);
      expect(
        await db.managedBroadcastCalendarReservation.count({
          where: { broadcastId: own.broadcastId, targetChatId: chatId },
        }),
      ).toBe(own.status === 'PENDING' ? 0 : 1);
      expect(
        await db.managedBroadcastCalendarReservation.count({
          where: { broadcastId: foreign.broadcastId, targetChatId: privateChatId },
        }),
      ).toBe(1);
    }
    const conflict = await findPublicationCalendarConflicts(
      db,
      [{ chatId, entityType: 'chat' }],
      receipts.map(({ occurrence }) => occurrence.scheduledAt),
    );
    expect(conflict.occurrences).toEqual([]);
    expect(conflict.reservations).toHaveLength(3);
    const calendar = await service.getCalendarAvailability(
      admin,
      {
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId, entityType: 'chat' }],
        },
        from: new Date(Date.now() - 60_000).toISOString(),
        to: new Date(Date.now() + 60_000).toISOString(),
      },
      'PUBLIK_V1',
    );
    expect(calendar.slots.map((slot) => slot.scheduledAt)).not.toContain(
      receipts[0]!.occurrence.scheduledAt.toISOString(),
    );
    expect(calendar.slots).toHaveLength(3);
    const routing = new PublicationPublisherRoutingService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    expect(
      (await routing.resolveScheduledTargets({ ...publication, targets })).map(
        (target) => target.chatId,
      ),
    ).toEqual([privateChatId]);
    const readiness = {
      async assertEntityReady(targetChatId) {
        return {
          chatId: targetChatId,
          requiredBotId: botId,
          entityType: 'chat',
          policyRevision: 1,
        };
      },
    } satisfies Pick<PublisherReadinessService, 'assertEntityReady'>;
    const dispatch = new PublisherManagedBroadcastDispatch(
      {
        prisma: db,
        publisherRuntimeBoundaryService: { assertDispatchEnabled() {} },
        publisherDispatchHealthService: { async assertDispatchAllowed() {} },
        publisherReadinessService: readiness,
      } as never,
      { warn() {} } as never,
    );
    const authority = {
      kind: 'publication',
      occurrenceId: receipts[0]!.occurrence.id,
      contentRevisionId: receipts[0]!.occurrence.contentRevisionId,
      actorUserId: creator,
      entityType: 'chat',
    } as const;
    await expect(dispatch.assertDeliveryReady(chatId, botId, authority)).rejects.toMatchObject({
      blockerCode: 'PUBLISHER_TARGET_CANCELED',
    });
    await expect(
      dispatch.assertDeliveryReady(privateChatId, botId, authority),
    ).resolves.toBeUndefined();
    const lateOccurrence = await db.publicationOccurrence.create({
      data: {
        publicationId: publication.id,
        scheduleId: publication.schedule!.id,
        contentRevisionId: authority.contentRevisionId,
        scheduleRevision: 1,
        scheduledAt: new Date(),
        status: 'IN_PROGRESS',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        deliveryDeadlineAt: new Date(Date.now() + 3_600_000),
      },
    });
    const lateEnvelope = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: creator,
        targetChatIds: [chatId],
        buttons: [],
        publicationOccurrenceId: lateOccurrence.id,
        publicationContentRevisionId: authority.contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      },
    });
    const lateDelivery = await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: lateEnvelope.id,
        occurrenceIndex: 1,
        targetChatId: chatId,
        publicationOccurrenceId: lateOccurrence.id,
        contentRevisionId: authority.contentRevisionId,
        ...deliveryRoute,
      },
    });
    await db.managedBroadcastCalendarReservation.create({
      data: {
        broadcastId: lateEnvelope.id,
        sourceChatId: chatId,
        targetChatId: chatId,
        occurrenceIndex: 1,
        scheduledAt: lateOccurrence.scheduledAt,
      },
    });
    await expect(
      dispatch.deferUnreadyBeforeClaim(lateEnvelope, lateDelivery, botId, {
        ...authority,
        occurrenceId: lateOccurrence.id,
      }),
    ).resolves.toBeInstanceOf(Date);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: lateDelivery.id } }),
    ).toMatchObject({ status: 'CANCELED', attemptCount: 0, remoteMessageId: null });
    expect(
      await db.managedBroadcastCalendarReservation.count({
        where: { broadcastId: lateEnvelope.id },
      }),
    ).toBe(0);
    expect(
      (await service.list(admin, { view: 'plan', limit: 100 }, 'PUBLIK_V1')).items.map(
        (row) => row.id,
      ),
    ).not.toContain(publication.id);
    expect(
      (await service.list(admin, { view: 'history', limit: 100 }, 'PUBLIK_V1')).items.map(
        (row) => row.id,
      ),
    ).toContain(publication.id);
    expect(
      (
        await selectPublicationSearchPage(db as never, {
          actorUserId: admin.userId,
          publisherBotId: botId,
          dispatchProfile: 'PUBLIK_V1',
          view: 'history',
          query: 'Common shared',
          cursor: null,
          limit: 100,
        })
      ).map((row) => row.id),
    ).toContain(publication.id);
    await expect(
      service.pause(
        publication.id,
        admin,
        { requestId: randomUUID(), expectedRevision: 2 },
        'PUBLIK_V1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.cancel(
        publication.id,
        outsider,
        { requestId: randomUUID(), expectedRevision: 2 },
        'PUBLIK_V1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(
      (
        await service.cancel(
          publication.id,
          admin,
          { requestId: `${prefix}-cancel-own-target`, expectedRevision: 1 },
          'PUBLIK_V1',
        )
      ).version,
    ).toBe(2);
  });

  it.each([
    { occurrenceStatus: 'CANCELED', broadcastStatus: 'ACTIVE', stopped: true },
    { occurrenceStatus: 'SENT', broadcastStatus: 'CANCELED', stopped: true },
    { occurrenceStatus: 'SCHEDULED', broadcastStatus: 'ACTIVE', stopped: false },
  ] as const)(
    'preserves pending evidence with occurrence $occurrenceStatus and envelope $broadcastStatus',
    async ({ occurrenceStatus, broadcastStatus, stopped }) => {
      const scheduledAt = new Date(Date.now() + 60 * 60_000);
      const publication = await db.publication.create({
        data: {
          actorUserId: creator,
          requestId: randomUUID(),
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          lifecycle: 'ACTIVE',
          targets: {
            create: [chatId, privateChatId].map((targetChatId, position) => ({
              targetChatId,
              position,
              entityType: 'CHAT' as const,
            })),
          },
          schedule: {
            create: {
              mode: 'ONCE',
              status: 'ACTIVE',
              rule: { mode: 'once', timezone: 'UTC', at: scheduledAt.toISOString() },
            },
          },
          contentRevisions: { create: { revision: 1, text: 'Retained delivery evidence' } },
        },
        include: { schedule: true, contentRevisions: true },
      });
      publications.push(publication.id);
      const contentRevisionId = publication.contentRevisions[0]!.id;
      await db.publication.update({
        where: { id: publication.id },
        data: { canonicalContentRevisionId: contentRevisionId },
      });
      const occurrence = await db.publicationOccurrence.create({
        data: {
          publicationId: publication.id,
          scheduleId: publication.schedule!.id,
          scheduleRevision: publication.schedule!.revision,
          contentRevisionId,
          scheduledAt,
          status: occurrenceStatus,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
        },
      });
      const broadcast = await db.managedBroadcast.create({
        data: {
          sourceChatId: chatId,
          actorUserId: creator,
          targetChatIds: [chatId, privateChatId],
          buttons: [],
          status: broadcastStatus,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: botId,
          publicationOccurrenceId: occurrence.id,
          publicationContentRevisionId: contentRevisionId,
        },
      });
      await db.managedBroadcastDelivery.createMany({
        data: [chatId, privateChatId].map((targetChatId) => ({
          broadcastId: broadcast.id,
          occurrenceIndex: 1,
          targetChatId,
          status: 'PENDING' as const,
          publicationOccurrenceId: occurrence.id,
          contentRevisionId,
          ...deliveryRoute,
          nextAttemptAt: scheduledAt,
          waitReason: 'local_capacity',
        })),
      });

      const details = await service.get(publication.id, admin, 'PUBLIK_V1');
      expect(details.delivery).toMatchObject({ total: 1, pending: 1 });
      expect(details.delivery).not.toHaveProperty('dispatchPending');
      expect(details.actionableDelivery).toMatchObject({
        total: 1,
        pending: 1,
        dispatchPending: stopped ? 0 : 1,
      });
      const deliveries = await service.listDeliveries(publication.id, admin, {}, 'PUBLIK_V1');
      expect(deliveries.items).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ chatId }),
          status: 'PENDING',
          dispatchStopped: stopped,
          attemptCount: 0,
          remoteMessageId: null,
          nextAttemptAt: scheduledAt.toISOString(),
          waitReason: 'local_capacity',
        }),
      ]);
      const allTargets = await presenter.loadActionableDeliveryStatsByPublicationIds([
        publication.id,
      ]);
      expect(allTargets.get(publication.id)).toMatchObject({
        pending: 2,
        dispatchPending: stopped ? 0 : 2,
      });

      if (!stopped) {
        await db.publicationSchedule.update({
          where: { id: publication.schedule!.id },
          data: { revision: { increment: 1 } },
        });
        const afterRevisionChange = await presenter.loadActionableDeliveryStatsByPublicationIds(
          [publication.id],
          scope,
        );
        expect(afterRevisionChange.get(publication.id)).toMatchObject({
          pending: 0,
          dispatchPending: 0,
        });
        expect(await presenter.loadDeliveryStats(publication.id, scope)).toMatchObject({
          pending: 1,
        });
      }
    },
  );

  it('shares only linked publication media and allows safe reuse without changing its owner', async () => {
    expect(
      (await content.getOwnedAsset(singleId, sharedAssetId, admin.userId)).bytes.toString(),
    ).toBe(`image:${chatId}`);
    await expect(
      content.getOwnedAsset(singleId, privateAssetId, admin.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
    const prepared = await content.prepareContentRevision({
      text: 'Edited',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'image-ref', assetId: sharedAssetId }],
    });
    const revision = await db.$transaction((tx) =>
      content.persistPreparedContentRevision(tx, singleId, 2, prepared, admin.userId),
    );
    expect(
      await db.publicationContentAsset.findFirst({ where: { contentRevisionId: revision.id } }),
    ).toMatchObject({ assetId: sharedAssetId });
    expect(
      await db.publicationAsset.findUnique({
        where: { id: sharedAssetId },
        select: { actorUserId: true },
      }),
    ).toEqual({ actorUserId: creator });
  });

  it('does not grant authorship, Major rights or empty private drafts shared authority', async () => {
    await expect(service.get(privateId, admin, 'PUBLIK_V1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(singleId, outsider, 'PUBLIK_V1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.get(draftId, admin, 'PUBLIK_V1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      service.get(singleId, { ...admin, userId: creator }, 'PUBLIK_V1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect((await service.get(draftId, { ...admin, userId: creator }, 'PUBLIK_V1')).lifecycle).toBe(
      'DRAFT',
    );
  });

  it('reauthorizes a committed mutation replay after explicit revocation', async () => {
    await db.managedEntityAccessEdge.update({
      where: { chatId_userId_botId: { chatId, userId: admin.userId, botId } },
      data: { state: 'USER_DENIED' },
    });
    await expect(
      service.pause(
        singleId,
        admin,
        { requestId: `${prefix}-pause`, expectedRevision: 1 },
        'PUBLIK_V1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      content.getOwnedAsset(singleId, sharedAssetId, admin.userId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(wake.enqueueAfterCommittedMutation).not.toHaveBeenCalled();
  });
});
