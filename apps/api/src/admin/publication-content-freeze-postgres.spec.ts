import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { PublicationContentInput } from '@maxim/contracts/publication';
import { PrismaClient, createPrismaAdapter, type Prisma } from '../prisma/prisma-client';
import { PublicationService } from './publication.service';
import { PublicationContentService } from './publication-content.service';
import {
  PUBLIK_LEDGER_DISPATCH_MARKER,
  reconcileRoutedManagedBroadcastSendingDeliveries,
} from './admin-managed-broadcast-ledger-recovery';
import { buildManagedBroadcastDeliveryActionKey } from './admin-managed-broadcast-reconciliation';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const integration = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

integration('Publication content freeze and immutable recovery on PostgreSQL', () => {
  let db: PrismaClient;
  let service: PublicationService;
  let chatId: string;
  let publicationId: string;
  let occurrenceId: string;
  let broadcastId: string;
  let deliveryId: string;
  let contentRevisionId: string;
  const botId = `publication-freeze-${randomUUID()}`;
  const user = () => ({ userId: chatId, username: null, displayName: null });
  const oldContent: PublicationContentInput = {
    text: 'Synthetic immutable publication',
    textFormat: 'plain',
    buttons: [],
    media: [],
    postPublish: { pin: 'silent', deleteAfterMinutes: 10 },
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 5, statement_timeout: 10_000 }),
    });
    await db.$connect();
    expect(await db.$queryRawUnsafe<Array<{ TimeZone: string }>>('SHOW TimeZone')).toEqual([
      { TimeZone: 'UTC' },
    ]);
  });

  function createService(prisma: PrismaClient = db) {
    const result = new PublicationService(
      prisma as never,
      new PublicationContentService(prisma as never, {} as never),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolvePersistedTargets: async () => [{ chatId, entityType: 'chat', title: 'Synthetic' }],
        assertTargetsReady: async () => undefined,
      } as never,
      { enqueueAfterCommittedMutation: async () => undefined } as never,
    );
    jest.spyOn(result, 'get').mockResolvedValue({ id: publicationId } as never);
    return result;
  }

  beforeEach(async () => {
    chatId = `publication-freeze-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Synthetic publication freeze fixture' } });
    const scheduledAt = new Date(Date.now() + 60_000);
    const publication = await db.publication.create({
      data: {
        actorUserId: chatId,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        targets: { create: { targetChatId: chatId, entityType: 'CHAT', position: 0 } },
        schedule: {
          create: {
            mode: 'ONCE',
            status: 'ACTIVE',
            rule: {
              mode: 'once',
              timezone: 'Europe/Moscow',
              at: scheduledAt.toISOString(),
              replaceConflicts: false,
            },
          },
        },
        contentRevisions: {
          create: { revision: 1, text: oldContent.text, postPublish: oldContent.postPublish },
        },
      },
      include: { schedule: true, contentRevisions: true },
    });
    publicationId = publication.id;
    contentRevisionId = publication.contentRevisions[0]!.id;
    await db.publication.update({
      where: { id: publicationId },
      data: { canonicalContentRevisionId: contentRevisionId },
    });
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: publication.schedule!.id,
        scheduleRevision: 1,
        contentRevisionId,
        scheduledAt,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      },
    });
    occurrenceId = occurrence.id;
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: chatId,
        text: oldContent.text,
        targetChatIds: [chatId],
        buttons: [],
        publicationOccurrenceId: occurrenceId,
        publicationContentRevisionId: contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        nextSendAt: scheduledAt,
        deliveries: {
          create: {
            occurrenceIndex: 1,
            targetChatId: chatId,
            publicationOccurrenceId: occurrenceId,
            contentRevisionId,
            dispatchProfile: 'PUBLIK_V1',
            requiredBotId: botId,
            dialogBotId: botId,
            publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [] },
            publicationPolicyRevision: 0,
            pinStatus: 'PENDING',
            deleteStatus: 'PENDING',
          },
        },
      },
      include: { deliveries: true },
    });
    broadcastId = broadcast.id;
    deliveryId = broadcast.deliveries[0]!.id;
    service = createService();
  });

  afterEach(async () => {
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
    await db.publicationOccurrence.deleteMany({ where: { publicationId } });
    await db.publication.delete({ where: { id: publicationId } });
    await db.chat.delete({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  const update = (selected = service, content: PublicationContentInput = oldContent) =>
    selected.update(
      publicationId,
      user(),
      {
        requestId: `freeze_${randomUUID()}`,
        expectedRevision: 1,
        content,
      },
      'PUBLIK_V1',
    );

  function interceptEnvelopeUpdate(hook: (run: () => Promise<unknown>) => Promise<unknown>) {
    return new Proxy(db, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(
            (tx) =>
              callback(
                new Proxy(tx, {
                  get(client, field) {
                    if (field !== 'managedBroadcast') return Reflect.get(client, field);
                    return new Proxy(client.managedBroadcast, {
                      get(delegate, method) {
                        if (method !== 'updateMany') return Reflect.get(delegate, method);
                        return (args: Parameters<typeof delegate.updateMany>[0]) =>
                          hook(() => delegate.updateMany(args));
                      },
                    });
                  },
                }),
              ),
            { timeout: 15_000 },
          );
      },
    });
  }

  it('rejects an identical-content save after an envelope claim and preserves its post-actions', async () => {
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { lockedAt: new Date(), lockToken: 'synthetic-worker' },
    });
    await expect(update()).rejects.toBeInstanceOf(ConflictException);
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      version: 1,
      canonicalContentRevisionId: contentRevisionId,
    });
    expect(await db.publicationContentRevision.count({ where: { publicationId } })).toBe(1);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'PENDING',
      contentRevisionId,
      pinStatus: 'PENDING',
      deleteStatus: 'PENDING',
    });
  });

  it('rolls the entire edit back when a worker claim commits after the edit reads an unleased envelope', async () => {
    const claimed = gate();
    const release = gate();
    const editReachedUpdate = gate();
    const worker = db.$transaction(async (tx) => {
      await tx.managedBroadcast.updateMany({
        where: { id: broadcastId, lockedAt: null },
        data: { lockedAt: new Date(), lockToken: 'concurrent-worker' },
      });
      claimed.resolve();
      await release.promise;
    });
    await claimed.promise;
    const editingService = createService(
      interceptEnvelopeUpdate(async (run) => {
        editReachedUpdate.resolve();
        return run();
      }),
    );
    const edit = update(editingService);
    const rejected = expect(edit).rejects.toBeInstanceOf(ConflictException);
    try {
      await editReachedUpdate.promise;
    } finally {
      release.resolve();
    }
    await worker;
    await rejected;
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      version: 1,
      canonicalContentRevisionId: contentRevisionId,
    });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrenceId } }),
    ).toMatchObject({ contentRevisionId });
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({
      publicationContentRevisionId: contentRevisionId,
      lockToken: 'concurrent-worker',
    });
  });

  it('lets a later worker claim only the committed new envelope, delivery revision and post-action policy', async () => {
    const frozen = gate();
    const release = gate();
    const editingService = createService(
      interceptEnvelopeUpdate(async (run) => {
        const result = await run();
        frozen.resolve();
        await release.promise;
        return result;
      }),
    );
    const edit = update(editingService, {
      ...oldContent,
      text: 'New synthetic content',
      postPublish: { pin: 'none', deleteAfterMinutes: null },
    });
    await frozen.promise;
    const worker = db.managedBroadcast.updateMany({
      where: { id: broadcastId, lockedAt: null },
      data: { lockedAt: new Date(), lockToken: 'after-edit-worker' },
    });
    release.resolve();
    await edit;
    expect((await worker).count).toBe(1);
    const publication = await db.publication.findUniqueOrThrow({ where: { id: publicationId } });
    expect(publication.canonicalContentRevisionId).not.toBe(contentRevisionId);
    expect(
      await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } }),
    ).toMatchObject({
      text: 'New synthetic content',
      publicationContentRevisionId: publication.canonicalContentRevisionId,
      lockToken: 'after-edit-worker',
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      contentRevisionId: publication.canonicalContentRevisionId,
      pinStatus: 'NONE',
      deleteStatus: 'NONE',
      postActionsNextAt: null,
    });
  });

  it('recovers an old immutable receipt after a historical envelope revision change, including after cancellation', async () => {
    const original = await db.managedBroadcast.findUniqueOrThrow({ where: { id: broadcastId } });
    const actionKey = buildManagedBroadcastDeliveryActionKey(original, 1, chatId);
    const newRevision = await db.publicationContentRevision.create({
      data: { publicationId, revision: 2, text: 'Changed envelope content' },
    });
    await db.managedBroadcast.update({
      where: { id: broadcastId },
      data: { publicationContentRevisionId: newRevision.id, text: newRevision.text },
    });
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENDING',
        attemptCount: 1,
        lockedAt: new Date(),
        lockToken: 'lost-worker',
        lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      },
    });
    await db.maxActionLedgerEntry.create({
      data: {
        jobId: actionKey,
        actionType: 'SEND_MESSAGE',
        chatId,
        status: 'SUCCEEDED',
        terminal: true,
        dispatchBotId: botId,
        remoteMessageId: 'synthetic-old-receipt',
        completedAt: new Date(),
        metadata: { ledgerContext: { managedBroadcast: { commentDialogReference: null } } },
      },
    });
    await service.cancel(
      publicationId,
      user(),
      { requestId: `cancel_${randomUUID()}`, expectedRevision: 1 },
      'PUBLIK_V1',
    );
    const recordDialogReference = jest.fn();
    await reconcileRoutedManagedBroadcastSendingDeliveries({
      prisma: db as never,
      messageRuntime: { recordDialogReference },
      broadcastId,
      occurrenceIndex: 1,
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({
      status: 'SENT',
      attemptCount: 1,
      contentRevisionId,
      remoteMessageId: 'synthetic-old-receipt',
      botId,
      pinStatus: 'PENDING',
      deleteStatus: 'PENDING',
    });
    expect(recordDialogReference).toHaveBeenCalledWith(
      expect.objectContaining({ text: oldContent.text, messageId: 'synthetic-old-receipt' }),
    );
  });

  it('quarantines a Publication delivery with missing immutable revision instead of creating a new send key', async () => {
    await db.managedBroadcastDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'SENDING',
        attemptCount: 1,
        contentRevisionId: null,
        lockedAt: new Date(),
        lockToken: 'lost-worker',
        lastErrorCode: PUBLIK_LEDGER_DISPATCH_MARKER,
      },
    });
    await reconcileRoutedManagedBroadcastSendingDeliveries({
      prisma: db as never,
      messageRuntime: { recordDialogReference: jest.fn() },
      broadcastId,
      occurrenceIndex: 1,
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).toMatchObject({ status: 'AMBIGUOUS', attemptCount: 1, contentRevisionId: null });
  });
});
