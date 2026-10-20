import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { DEFAULT_MAX_PUBLISHER_BOT_ID } from '../publisher/publisher-bot-descriptor';
import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import { PublicationContentService } from './publication-content.service';
import { selectPublicationSearchPage } from './publication-failed-page-query';
import { PublicationPresenterService } from './publication-presenter.service';
import { PublicationService } from './publication.service';

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
    const deliveryRoute = {
      dispatchProfile: 'PUBLIK_V1' as const,
      requiredBotId: botId,
      dialogBotId: botId,
      publicationPolicyRevision: 1,
      publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [], reference: null },
    };
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
      { requireNewRoute: () => ({ dispatchProfile: 'PUBLIK_V1', requiredBotId: botId }) } as never,
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
