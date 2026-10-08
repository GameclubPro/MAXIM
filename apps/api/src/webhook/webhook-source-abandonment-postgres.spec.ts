import { createHash, randomUUID } from 'node:crypto';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { Prisma } from '../prisma/prisma-client';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { buildWebhookOperationalLagQuery } from '../system/webhook-operational-lag';
import { canonical, legacySnapshotDigest } from './webhook-legacy-source';
import { WebhookParser } from './webhook.parser';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { SOURCE_ABANDONMENT_OPERATION } from './webhook-source-abandonment.contract';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import {
  inspectLegacyRecoveryCandidate,
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  installAndSealLegacyRecoveryBatch,
  readLegacyRecoveryInstallation,
} from './webhook-legacy-cold-install';
import {
  inspectSourceAbandonmentCandidate,
  inspectSourceAbandonmentReceiptCandidate,
  materializeSourceAbandonmentReceipt,
  sourceAbandonmentOwnerSnapshot,
} from './webhook-source-abandonment';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

native('exact-source modern abandonment preserves journals and independent moderation', () => {
  let h: MultibotHarness | undefined;
  const legacyCertificateIds: string[] = [];
  afterEach(async () => {
    jest.restoreAllMocks();
    // FLAG: Modern proof rows are permanent and deliberately survive source retention.
    // Only ordinary fixture receipts/entities are deleted; disposable-store teardown owns proofs.
    if (h) {
      const heldOwners = await h.prisma.webhookSourceAbandonment.findMany({
        where: { ownerWebhookEventId: { in: h.receiptIds } },
        select: { ownerWebhookEventId: true },
      });
      const projected = await h.prisma.webhookEvent.findMany({
        where: { id: { in: h.receiptIds }, sourceDispositionId: { not: null } },
        select: { id: true },
      });
      const pinned = new Set([
        ...heldOwners.map((row) => row.ownerWebhookEventId),
        ...projected.map((row) => row.id),
      ]);
      h.receiptIds.splice(0, h.receiptIds.length, ...h.receiptIds.filter((id) => !pinned.has(id)));
    }
    if (h && legacyCertificateIds.length) {
      await h.pause();
      await h.prisma.webhookExecutionClaim.deleteMany({
        where: { webhookEventId: { in: h.receiptIds } },
      });
      await h.prisma.webhookEvent.deleteMany({ where: { id: { in: h.receiptIds } } });
      for (const certificateId of legacyCertificateIds.splice(0)) {
        const authority = await h.prisma.webhookLegacySealedAuthority.findUnique({
          where: { certificateId },
        });
        if (authority)
          await h.prisma.webhookLegacyReceiptDisposition.deleteMany({
            where: { authorityId: authority.id },
          });
        await h.prisma.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
        await h.prisma.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
        await h.prisma.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
        await h.prisma.webhookLegacyQuiescenceCertificate.deleteMany({
          where: { id: certificateId },
        });
      }
    }
    await h?.dispose();
    h = undefined;
  });

  async function storeRaw(s: MultibotHarness, raw: Record<string, unknown>, botId = s.bots[0]!.id) {
    const update = new WebhookParser().parse(raw, { botId });
    update.updateId = randomUUID();
    s.messages.set(update.message!.messageId, raw.message as Record<string, unknown>);
    const result = await s.ingress.storeReceipt(update, null);
    expect(result.webhookEventId).toBeTruthy();
    s.receiptIds.push(result.webhookEventId!);
    return result.webhookEventId!;
  }

  async function fixture(
    forwardPhotos?: number,
    content?: 'share' | 'reply' | 'image' | 'video' | 'forward-without-sender',
  ) {
    h = await createMultibotHarness({
      databaseUrl,
      redisUrl,
      bots: 4,
      mode: 'on',
    });
    await h.pause();
    const [chatId, independentChatId] = await h.seedCatalog(2, {
      maxMessageLengthEnabled: true,
      maxMessageLength: 20,
      messageLimitsWarnEnabled: false,
      messageLimitsMuteEnabled: false,
      messageLimitsBanEnabled: false,
      deleteBotMessagesEnabled: false,
    });
    const [clock] = await h.prisma.$queryRaw<Array<{ at: Date; migrationAt: Date }>>(Prisma.sql`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at, finished_at AS "migrationAt"
      FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC LIMIT 1
    `);
    expect(clock).toBeDefined();
    expect(clock!.at.getTime()).toBeGreaterThan(clock!.migrationAt.getTime());
    const at = clock!.at.getTime();
    const messageId = `modern-source-${randomUUID()}`;
    const text = 'A reviewed old message with uncertain prior execution';
    const raw = {
      update_type: 'message_created',
      timestamp: at,
      message: {
        sender: { user_id: 'fixture-user', name: 'Fixture user', is_bot: false },
        recipient: { chat_id: chatId!, chat_type: 'chat' },
        timestamp: at,
        body: { mid: messageId, text },
        ...(forwardPhotos === undefined
          ? {}
          : {
              link: {
                type: 'forward',
                chat_id: independentChatId!,
                sender: { user_id: 'linked-fixture-user', is_bot: false },
                message: {
                  mid: `linked-${randomUUID()}`,
                  text: 'Original forwarded caption with two synthetic photographs',
                  attachments: Array.from({ length: forwardPhotos }, (_, i) => ({
                    type: i % 2 ? 'photo' : 'image',
                    payload: { photo_id: i + 1, url: `https://i.oneme.ru/synthetic-${i}` },
                  })),
                },
              },
            }),
      },
    };
    if (content === 'forward-without-sender') {
      raw.message.link = {
        type: 'forward',
        chat_id: independentChatId!,
        sender: { user_id: 'unused-fixture-author', is_bot: false },
        message: {
          mid: `linked-${randomUUID()}`,
          text: 'A strict flat forward with omitted original author',
          attachments: Array.from({ length: 10 }, (_, i) => ({
            type: 'image',
            payload: { photo_id: i + 1, url: `https://i.oneme.ru/omitted-sender-${i}` },
          })),
        },
      };
      delete (raw.message.link as { sender?: unknown }).sender;
    }
    if (content === 'image' || content === 'video') {
      Object.assign(raw.message.body, {
        attachments: [
          content === 'image'
            ? {
                type: 'image',
                payload: { photo_id: 42, token: 'fixture-photo', url: 'https://i.oneme.ru/photo' },
              }
            : {
                type: 'video',
                payload: { id: 42, token: 'fixture-video', url: 'https://i.oneme.ru/video' },
                thumbnail: { url: 'https://i.oneme.ru/thumbnail' },
              },
        ],
      });
    }
    if (content === 'share') {
      Object.assign(raw.message.body, {
        attachments: [
          {
            type: 'share',
            payload: { url: 'https://example.com/source', token: 'fixture-preview-token' },
            title: 'Source preview',
            description: null,
            image_url: 'https://example.com/preview.jpg',
          },
        ],
        markup: [
          { type: 'heading', from: 0, length: 1 },
          { type: 'strong', from: 0, length: 1 },
          { type: 'link', from: 0, length: 1, url: 'https://example.com/source' },
        ],
      });
    }
    if (content === 'reply') {
      raw.message.link = {
        type: 'reply',
        chat_id: independentChatId!,
        sender: { user_id: 'linked-fixture-user', is_bot: false },
        message: {
          mid: `linked-${randomUUID()}`,
          text: '',
          attachments: [
            { type: 'image', payload: { photo_id: 1, url: 'https://i.oneme.ru/reply-fixture' } },
          ],
        },
      };
    }
    const ownerId = await storeRaw(h, raw);
    await h.ingress.preparePersistedWebhookEvent(ownerId);
    const started = await h.canonical.prepareExecution(ownerId, h.bots[0]!.id);
    expect(started).not.toBeNull();
    await h.canonical.failExecution(started!, {
      errorMessage: 'Fixture uncertain started execution requires explicit source abandonment',
      terminal: true,
    });
    const owner = await h.prisma.webhookEvent.findUniqueOrThrow({
      where: { id: ownerId },
    });
    const claim = await h.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    expect(claim).toMatchObject({
      enforced: true,
      status: 'READY',
      businessStartedAt: expect.any(Date),
      completedAt: null,
      commandResult: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(owner.createdAt.getTime()).toBeGreaterThan(clock!.migrationAt.getTime());
    const retryUntilAt = new Date(at + 300_000);
    const intent = await h.prisma.moderationDeleteIntent.create({
      data: {
        id: `modern-intent-${randomUUID()}`,
        chatId: chatId!,
        messageId,
        subjectUserId: 'fixture-user',
        sourceMessageAt: new Date(at),
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: h.bots[0]!.id,
        status: 'OBSERVED',
        retryUntilAt,
      },
    });
    // Operator cutoff grants no success/absence proof and does not rewrite future deadlines.
    const [cutoff] = await h.prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    const selection = {
      majorBotIds: h.bots.map((b) => b.id),
      abandonBefore: cutoff!.at,
    };
    const refusals: string[] = [];
    const candidate = await inspectSourceAbandonmentCandidate(
      h.prisma,
      ownerId,
      selection,
      (reason) => refusals.push(reason),
    );
    expect(refusals).toEqual([]);
    expect(candidate).not.toBeNull();
    expect(
      await inspectLegacyRecoveryCandidate(h.prisma, ownerId, selection.majorBotIds),
    ).toBeNull();
    return {
      s: h,
      chatId: chatId!,
      independentChatId: independentChatId!,
      at,
      messageId,
      text,
      raw,
      ownerId,
      owner,
      claim,
      intent,
      candidate: candidate!,
      selection,
    };
  }

  async function runReceipts(s: MultibotHarness, ids: string[]) {
    await s.resume();
    const until = Date.now() + 15_000;
    do {
      await s.pumpOnce();
      const remaining = await s.prisma.webhookEvent.count({
        where: {
          id: { in: ids },
          status: { notIn: ['PROCESSED', 'DUPLICATE', 'NO_REPLAY_HELD'] },
        },
      });
      if (!remaining) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < until);
    throw new Error(
      JSON.stringify(
        await s.prisma.webhookEvent.findMany({
          where: { id: { in: ids } },
          select: { status: true, errorMessage: true },
        }),
      ),
    );
  }

  function materialize(s: MultibotHarness, receiptId: string) {
    return s.prisma.$transaction((tx) => materializeSourceAbandonmentReceipt(tx, receiptId));
  }

  async function seal(s: MultibotHarness, certificateId: string) {
    await s.prisma.$executeRaw(Prisma.sql`
      UPDATE webhook_source_abandonment_certificates
      SET sealed_at = clock_timestamp() AT TIME ZONE 'UTC' WHERE id = ${certificateId}
    `);
  }

  async function install(f: Awaited<ReturnType<typeof fixture>>, sealNow = true) {
    const certificateId = randomUUID();
    const sourceId = randomUUID();
    const sourceSha = 'a'.repeat(40);
    const imageId = `sha256:${'b'.repeat(64)}`;
    const sourceClosureSha256 = legacySnapshotDigest({
      fixture: 'exact-source-runtime',
    });
    const descendantsSha256 = legacySnapshotDigest({ intent: f.intent });
    const attestation = {
      operation: SOURCE_ABANDONMENT_OPERATION,
      sourceSha,
      imageId,
      abandonBefore: f.selection.abandonBefore.toISOString(),
      sourceClosureSha256,
      descendantsSha256,
    };
    // FLAG: Native fixture supplies reviewed immutable runtime evidence directly.
    // Offline collector/store tests separately prove stopped generations and full descendant inventory.
    await f.s.prisma.$transaction(async (tx) => {
      const reread = await inspectSourceAbandonmentCandidate(tx, f.ownerId, f.selection);
      expect(reread).toEqual(f.candidate);
      await tx.webhookSourceAbandonmentCertificate.create({
        data: {
          id: certificateId,
          sourceSha,
          imageId,
          attestation,
          attestationDigest: legacySnapshotDigest(attestation),
          previewSha256: legacySnapshotDigest(f.candidate),
          sourceClosureSha256,
          descendantsSha256,
          abandonBefore: f.selection.abandonBefore,
          expectedSourceCount: 1,
          expectedChildCount: 0,
        },
      });
      await tx.webhookSourceAbandonment.create({
        data: {
          id: sourceId,
          certificateId,
          semanticKey: f.owner.semanticKey!,
          ownerWebhookEventId: f.ownerId,
          claimId: f.claim.id,
          chatId: f.chatId,
          messageId: f.messageId,
          subjectUserId: 'fixture-user',
          sourceAt: new Date(f.at),
          rawPayloadDigest: f.candidate.rawPayloadDigest,
          normalizedPayloadDigest: f.candidate.normalizedPayloadDigest,
          ownerSnapshot: sourceAbandonmentOwnerSnapshot(f.owner),
          claimSnapshot: canonical(f.claim) as Prisma.InputJsonValue,
        },
      });
    });
    if (sealNow) await seal(f.s, certificateId);
    return { certificateId, sourceId };
  }

  async function assertHistory(f: Awaited<ReturnType<typeof fixture>>) {
    const owner = await f.s.prisma.webhookEvent.findUniqueOrThrow({
      where: { id: f.ownerId },
    });
    expect(owner).toEqual({
      ...f.owner,
      sourceDispositionId: expect.any(String),
      sourceDispositionReceiptId: f.ownerId,
    });
    expect(
      await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: f.claim.id },
      }),
    ).toEqual(f.claim);
    expect(
      await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: f.intent.id },
      }),
    ).toEqual(f.intent);
  }

  it('releases real ordering only with proof and never replays exact pre/post-install mirrors', async () => {
    const f = await fixture();
    const { s } = f;
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const metrics = new QueueMetricsService(
      s.prisma as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    const mirrorId = await s.ingest({
      chatId: f.chatId,
      messageId: f.messageId,
      text: f.text,
      at: f.at,
      botId: s.bots[1]!.id,
    });
    const nextMessageId = `new-source-${randomUUID()}`;
    const nextId = await s.ingest({
      chatId: f.chatId,
      messageId: nextMessageId,
      text: 'A new same-user message must still undergo normal length moderation',
      botId: s.bots[0]!.id,
    });
    const independentId = await s.ingest({
      chatId: f.independentChatId,
      messageId: `independent-${randomUUID()}`,
      text: 'An independent chat must progress before the old source is released',
    });
    await runReceipts(s, [independentId]);
    await s.pause();
    expect(
      (
        await s.prisma.webhookEvent.findUniqueOrThrow({
          where: { id: nextId },
        })
      ).status,
    ).not.toBe('PROCESSED');
    expect(handler.mock.calls.some(([update]) => update.message?.messageId === f.messageId)).toBe(
      false,
    );
    const selector = s.outbox as unknown as {
      findOrderedWebhookHeadsForChats(ids: readonly string[]): Promise<Map<string, { id: string }>>;
      selectEnqueueCandidates(now: Date): Promise<Array<{ id: string }>>;
    };
    const heldHead = (await selector.findOrderedWebhookHeadsForChats([f.chatId])).get(f.chatId);
    expect([f.ownerId, mirrorId]).toContain(heldHead?.id);
    const effectsBefore = s.effects.length;
    const installed = await install(f);
    expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
    expect(await materialize(s, mirrorId)).toBe('APPLIED_WITH_PROOF');
    expect((await selector.findOrderedWebhookHeadsForChats([f.chatId])).get(f.chatId)?.id).toBe(
      nextId,
    );
    await runReceipts(s, [nextId]);
    expect(s.effects.slice(effectsBefore)).toEqual([
      expect.objectContaining({
        method: 'delete',
        path: '/messages',
        messageId: nextMessageId,
      }),
    ]);
    expect(await s.legacyHolds.isMemberHeld(f.chatId, 'fixture-user')).toBe(false);
    expect(await s.legacyHolds.isGlobalUserHeld('fixture-user')).toBe(false);
    expect(
      await s.prisma.webhookLegacyRecovery.count({
        where: { chatId: f.chatId },
      }),
    ).toBe(0);
    const retention = s.outbox as unknown as {
      deleteCompletedWebhookBatch(cutoff: Date): Promise<unknown>;
      deleteLegacyHeldWebhookBatch(cutoff: Date): Promise<unknown>;
      deleteTerminalFailedWebhookBatch(cutoff: Date): Promise<unknown>;
    };
    const retentionCutoff = new Date(Date.now() + 86_400_000);
    await retention.deleteCompletedWebhookBatch(retentionCutoff);
    await retention.deleteLegacyHeldWebhookBatch(retentionCutoff);
    await retention.deleteTerminalFailedWebhookBatch(retentionCutoff);
    await assertHistory(f);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } }),
    ).toMatchObject({
      status: 'NO_REPLAY_HELD',
      sourceDispositionReceiptId: mirrorId,
    });
    const lateId = await s.ingest({
      chatId: f.chatId,
      messageId: f.messageId,
      text: f.text,
      at: f.at,
      botId: s.bots[2]!.id,
    });
    await runReceipts(s, [lateId]);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: lateId },
      }),
    ).toMatchObject({
      status: 'NO_REPLAY_HELD',
      sourceDispositionId: expect.any(String),
      sourceDispositionReceiptId: lateId,
      processedAt: null,
    });
    for (const id of [f.ownerId, mirrorId, lateId]) await s.moderation.processWebhookEvent(id);
    expect(handler.mock.calls.some(([update]) => update.message?.messageId === f.messageId)).toBe(
      false,
    );
    expect(s.effects).toHaveLength(effectsBefore + 1);
    await expect(
      s.max.deleteMessage(f.chatId, f.messageId, {
        immediate: true,
        botId: s.bots[3]!.id,
      }),
    ).rejects.toThrow();
    expect(s.effects).toHaveLength(effectsBefore + 1);
    await assertHistory(f);
    expect(await materialize(s, f.ownerId)).toBe('ALREADY_APPLIED_SAME_PROOF');
    await expect(
      s.prisma.$executeRaw(Prisma.sql`
      UPDATE webhook_source_abandonments SET subject_user_id = 'other' WHERE id = ${installed.sourceId}
    `),
    ).rejects.toThrow();
    await expect(
      s.prisma.$executeRaw(Prisma.sql`
      DELETE FROM webhook_source_receipt_dispositions WHERE receipt_id = ${f.ownerId}
    `),
    ).rejects.toThrow();
    expect(await metrics.getLagSnapshot()).toMatchObject({
      oldestReceivedEventId: null,
      oldestQueuedEventId: null,
      effectiveLagSec: 0,
      operationalLagSec: 0,
      readinessWaitingCount: 0,
    });
    expect(await s.prisma.$queryRaw(buildWebhookOperationalLagQuery())).toEqual([]);
    expect((await selector.findOrderedWebhookHeadsForChats([f.chatId])).has(f.chatId)).toBe(false);
    const selected = await selector.selectEnqueueCandidates(new Date());
    expect(selected.some((row) => [f.ownerId, mirrorId, lateId].includes(row.id))).toBe(false);
    expect(s.failures).toEqual([]);
  });

  it.each([0, 2, 10])(
    'holds a flat forward with %i photos while a new outer message and linked author progress',
    async (photoCount) => {
      const f = await fixture(photoCount);
      const { s } = f;
      const link = f.raw.message.link!;
      expect(f.candidate.source).toEqual({
        chatId: f.chatId,
        messageId: f.messageId,
        userId: 'fixture-user',
        sourceAt: new Date(f.at),
      });
      // FLAG: This harness proves real ingress, SQL ordering and caption moderation.
      // Native image/OCR consumers require their separate final-source guard coverage.
      expect(s.mediaCoverage).toBe('ingress-and-caption-rules-without-native-photo-or-ocr');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const mirrorId = await storeRaw(s, f.raw, s.bots[1]!.id);
      expect(
        await inspectSourceAbandonmentReceiptCandidate(s.prisma, mirrorId, f.candidate),
      ).toMatchObject({ scopeKind: 'EXACT_SOURCE' });
      await install(f);
      expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
      expect(await materialize(s, mirrorId)).toBe('APPLIED_WITH_PROOF');
      const lateId = await storeRaw(s, f.raw, s.bots[2]!.id);
      await runReceipts(s, [lateId]);
      await s.pause();
      for (const id of [mirrorId, lateId])
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'NO_REPLAY_HELD',
          sourceDispositionId: expect.any(String),
          sourceDispositionReceiptId: id,
          processedAt: null,
        });
      expect(handler.mock.calls.some(([update]) => update.message?.messageId === f.messageId)).toBe(
        false,
      );
      expect(s.effects).toEqual([]);
      expect(await s.legacyHolds.isMessageHeld(f.chatId, f.messageId)).toBe(true);
      expect(await s.legacyHolds.isMessageHeld(link.chat_id, link.message.mid)).toBe(false);
      for (const userId of ['fixture-user', link.sender.user_id]) {
        expect(await s.legacyHolds.isMemberHeld(f.chatId, userId)).toBe(false);
        expect(await s.legacyHolds.isMemberHeld(link.chat_id, userId)).toBe(false);
        expect(await s.legacyHolds.isGlobalUserHeld(userId)).toBe(false);
      }
      const next = structuredClone(f.raw);
      next.message.body.mid = `new-outer-${randomUUID()}`;
      next.timestamp = Date.now();
      next.message.timestamp = next.timestamp;
      expect(next.message.link).toEqual(link);
      const nextId = await storeRaw(s, next);
      expect(await materialize(s, nextId)).toBe('NOT_HELD');
      const originalAuthorRaw = {
        update_type: 'message_created',
        timestamp: Date.now(),
        message: {
          sender: link.sender,
          recipient: { chat_id: link.chat_id, chat_type: 'chat' },
          timestamp: Date.now(),
          body: {
            mid: link.message.mid,
            text: 'A linked author remains subject to normal moderation',
          },
        },
      };
      originalAuthorRaw.message.timestamp = originalAuthorRaw.timestamp;
      const linkedId = await storeRaw(s, originalAuthorRaw);
      expect(await materialize(s, linkedId)).toBe('NOT_HELD');
      await runReceipts(s, [nextId, linkedId]);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: '/messages', messageId: next.message.body.mid }),
          expect.objectContaining({ path: '/messages', messageId: link.message.mid }),
        ]),
      );
      expect(s.effects).toHaveLength(2);
      for (const id of [nextId, linkedId])
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'PROCESSED',
          sourceDispositionId: null,
          sourceDispositionReceiptId: null,
        });
      await expect(
        s.max.deleteMessage(f.chatId, f.messageId, { immediate: true, botId: s.bots[3]!.id }),
      ).rejects.toThrow();
      expect(s.effects).toHaveLength(2);
      await assertHistory(f);
      expect(s.failures).toEqual([]);
    },
  );

  it.each(['share', 'reply', 'image', 'video', 'forward-without-sender'] as const)(
    'holds the exact modern %s source and edited mirrors while a distinct same-user message progresses',
    async (content) => {
      const f = await fixture(undefined, content);
      const { s } = f;
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const mirrorId = await storeRaw(s, f.raw, s.bots[1]!.id);
      expect(
        await inspectSourceAbandonmentReceiptCandidate(s.prisma, mirrorId, f.candidate),
      ).toMatchObject({ scopeKind: 'EXACT_SOURCE' });
      const next = structuredClone(f.raw);
      next.message.body.mid = `new-${content}-${randomUUID()}`;
      next.timestamp = Date.now();
      next.message.timestamp = next.timestamp;
      const nextId = await storeRaw(s, next);
      await install(f);
      expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
      expect(await materialize(s, mirrorId)).toBe('APPLIED_WITH_PROOF');
      const edited = structuredClone(f.raw);
      edited.update_type = 'message_edited';
      edited.timestamp = Date.now();
      const editId = await storeRaw(s, edited, s.bots[2]!.id);
      await runReceipts(s, [editId, nextId]);
      await s.pause();
      for (const id of [mirrorId, editId])
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'NO_REPLAY_HELD',
          sourceDispositionReceiptId: id,
          processedAt: null,
        });
      expect(handler.mock.calls.some(([update]) => update.message?.messageId === f.messageId)).toBe(
        false,
      );
      expect(s.effects).toEqual([
        expect.objectContaining({
          method: 'delete',
          path: '/messages',
          messageId: next.message.body.mid,
        }),
      ]);
      expect(await s.legacyHolds.isMemberHeld(f.chatId, 'fixture-user')).toBe(false);
      expect(await s.legacyHolds.isGlobalUserHeld('fixture-user')).toBe(false);
      if (content === 'reply' || content === 'forward-without-sender') {
        const link = f.raw.message.link!;
        expect(await s.legacyHolds.isMessageHeld(link.chat_id, link.message.mid)).toBe(false);
        if (content === 'reply') {
          expect(await s.legacyHolds.isMemberHeld(link.chat_id, link.sender.user_id)).toBe(false);
          expect(await s.legacyHolds.isGlobalUserHeld(link.sender.user_id)).toBe(false);
        } else expect(link).not.toHaveProperty('sender');
      }
      await assertHistory(f);
      expect(s.failures).toEqual([]);
    },
  );

  it('refuses unsupported owner shapes and never projects malformed exact-source mirrors', async () => {
    const f = await fixture(2);
    const { s } = f;
    await s.prisma.chatSettings.update({
      where: { chatId: f.chatId },
      data: { adminBanCommandName: 'особое' },
    });
    const faults = [
      'direct-image-with-link',
      'direct-video-malformed',
      'unknown-link-type',
      'nested',
      'unknown-attachment',
      'unknown-payload',
      'linked-video',
      'eleven-photos',
      'direct-command',
      'linked-command',
      'configured-linked-command',
      'forged-normalized-text',
      'linked-author-as-outer',
    ];
    const invalid: Array<{ raw: Record<string, unknown>; normalized: Prisma.InputJsonValue }> = [];
    for (const fault of faults) {
      const raw = structuredClone(f.raw);
      const link = raw.message.link!;
      if (fault === 'direct-image-with-link' || fault === 'direct-video-malformed') {
        if (fault === 'direct-video-malformed') delete raw.message.link;
        Object.assign(raw.message.body, {
          attachments: [
            {
              type: fault === 'direct-image-with-link' ? 'image' : 'video',
              payload: {
                photo_id: 1,
                url: 'https://i.oneme.ru/direct-fixture',
              },
            },
          ],
        });
      }
      if (fault === 'unknown-link-type') link.type = 'unknown';
      if (fault === 'nested') Object.assign(link.message, { link: { type: 'forward' } });
      if (fault === 'unknown-attachment') link.message.attachments[0]!.type = 'share';
      if (fault === 'unknown-payload')
        Object.assign(link.message.attachments[0]!.payload, { hidden: 'unknown' });
      if (fault === 'linked-video') link.message.attachments[0]!.type = 'video';
      if (fault === 'eleven-photos')
        link.message.attachments = Array.from({ length: 11 }, () => link.message.attachments[0]!);
      if (fault === 'direct-command') raw.message.body.text = '/ban';
      if (fault === 'linked-command') link.message.text = 'бан';
      if (fault === 'configured-linked-command') link.message.text = 'особое';
      const update = new WebhookParser().parse(raw, { botId: f.owner.botId! });
      if (fault === 'forged-normalized-text') update.message!.text = 'forged caption';
      if (fault === 'linked-author-as-outer') update.message!.senderId = link.sender.user_id;
      const normalized = JSON.parse(JSON.stringify(update));
      invalid.push({ raw, normalized });
      await s.prisma.webhookEvent.update({
        where: { id: f.ownerId },
        data: { rawPayload: raw, normalizedPayload: normalized },
      });
      const reasons: string[] = [];
      expect(
        await inspectSourceAbandonmentCandidate(s.prisma, f.ownerId, f.selection, (reason) =>
          reasons.push(reason),
        ),
      ).toBeNull();
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons).not.toContain('source_started_claim_unproved');
      expect(
        await inspectSourceAbandonmentReceiptCandidate(s.prisma, f.ownerId, f.candidate),
      ).toBeNull();
    }
    await s.prisma.webhookEvent.update({
      where: { id: f.ownerId },
      data: {
        rawPayload: f.owner.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: f.owner.normalizedPayload as Prisma.InputJsonValue,
      },
    });
    await install(f);
    expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
    for (const { raw, normalized } of invalid) {
      // FLAG: Preserve malformed ingress as stored evidence; no recovery helper may
      // repair its payload or infer a positive receipt from an outer identity match.
      const id = randomUUID();
      await s.prisma.webhookEvent.create({
        data: {
          id,
          dedupKey: id,
          botId: f.owner.botId,
          semanticKey: buildWebhookSemanticEventKey(normalized),
          rawPayload: raw as Prisma.InputJsonValue,
          normalizedPayload: normalized,
        },
      });
      s.receiptIds.push(id);
      expect(await materialize(s, id)).toBe('BLOCKED_UNKNOWN');
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'RECEIVED',
        processedAt: null,
        sourceDispositionId: null,
        sourceDispositionReceiptId: null,
      });
    }
    expect(s.effects).toEqual([]);
    await assertHistory(f);
  });

  it('contains an unsealed source while withholding ordering release', async () => {
    const f = await fixture();
    const { s } = f;
    const installed = await install(f, false);
    expect(await s.legacyHolds.isMessageHeld(f.chatId, f.messageId)).toBe(true);
    expect(await materialize(s, f.ownerId)).toBe('BLOCKED_UNKNOWN');
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({
        where: { id: f.ownerId },
      }),
    ).toEqual(f.owner);
    await expect(s.max.deleteMessage(f.chatId, f.messageId, { immediate: true })).rejects.toThrow();
    expect(s.effects).toEqual([]);
    await seal(s, installed.certificateId);
    expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
    await assertHistory(f);
  });

  it('pins exact owner and claim evidence against mutation or retention deletion', async () => {
    const f = await fixture();
    const { s } = f;
    await install(f);
    await expect(
      s.prisma.webhookExecutionClaim.update({
        where: { id: f.claim.id },
        data: {
          leaseToken: 'unexpected-live-claim',
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
    await expect(
      s.prisma.webhookExecutionClaim.delete({ where: { id: f.claim.id } }),
    ).rejects.toThrow();
    await expect(s.prisma.webhookEvent.delete({ where: { id: f.ownerId } })).rejects.toThrow();
    await expect(
      s.prisma.webhookEvent.update({ where: { id: f.ownerId }, data: { errorMessage: 'changed' } }),
    ).rejects.toThrow();
    expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
    expect(await s.legacyHolds.isMessageHeld(f.chatId, f.messageId)).toBe(true);
    await assertHistory(f);
    expect(s.effects).toEqual([]);
  });

  it('leaves observed deletion and due followup journals unchanged through public recovery paths', async () => {
    const f = await fixture();
    const { s } = f;
    const followup = await s.prisma.moderationRuleFollowup.create({
      data: {
        id: randomUUID(),
        intentId: f.intent.id,
        reasonKey: 'fixture-before-abandonment',
        chatId: f.chatId,
        messageId: f.messageId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_TOO_LONG',
        sourceAt: new Date(f.at),
        deadlineAt: new Date(f.at + 300_000),
        policySha256: 'c'.repeat(64),
        envelope: { version: 1, fixture: true },
        status: 'READY',
      },
    });
    await install(f);
    await s.intents.attemptIntent(f.intent.id);
    await s.intents.executeLeasedIntent(f.intent.id, 'a-stale-queued-lease');
    await s.intents.enqueueCurrentIntentWakeupStrict(f.intent.id);
    await s.intents.sweepDueIntents();
    expect(await s.ruleFollowups.attempt(followup.id)).toBe(false);
    await s.ruleFollowups.sweep();
    expect(
      await s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: f.intent.id } }),
    ).toEqual(f.intent);
    expect(
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: followup.id } }),
    ).toEqual(followup);
    expect(await s.deleteQueue.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
    expect(s.effects).toEqual([]);
  });

  it('preserves an unknown member-effect fence while allowing a distinct same-user message', async () => {
    const f = await fixture();
    const { s } = f;
    s.ambiguousNextMemberMutation();
    await expect(
      s.max.banMember(f.chatId, 'fixture-user', {
        immediate: true,
        botId: s.bots[0]!.id,
      }),
    ).rejects.toThrow('Ambiguous MAX BAN_MEMBER');
    const ledger = await s.prisma.maxActionLedgerEntry.findMany({
      where: { chatId: f.chatId },
    });
    expect(ledger).toEqual([
      expect.objectContaining({
        actionType: 'BAN_MEMBER',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      }),
    ]);
    await install(f);
    expect(await materialize(s, f.ownerId)).toBe('APPLIED_WITH_PROOF');
    await expect(
      s.max.kickMember(f.chatId, 'fixture-user', {
        immediate: true,
        botId: s.bots[1]!.id,
      }),
    ).rejects.toThrow('Retained member action requires settlement');
    const messageId = `new-after-member-unknown-${randomUUID()}`;
    const id = await s.ingest({
      chatId: f.chatId,
      messageId,
      text: 'New source remains governed by ordinary message length policy',
    });
    await runReceipts(s, [id]);
    expect(s.effects.filter((e) => e.path === `/chats/${f.chatId}/members`)).toHaveLength(1);
    expect(s.effects.filter((e) => e.path === '/messages')).toEqual([
      expect.objectContaining({ method: 'delete', messageId }),
    ]);
    expect(
      await s.prisma.maxActionLedgerEntry.findMany({
        where: { id: { in: ledger.map((row) => row.id) } },
      }),
    ).toEqual(ledger);
    expect(await s.legacyHolds.isMemberHeld(f.chatId, 'fixture-user')).toBe(false);
    expect(await s.legacyHolds.isGlobalUserHeld('fixture-user')).toBe(false);
    await assertHistory(f);
  });

  it('reads old legacy preview and positive-proof hashes without the additive modern columns', async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
    const s = h;
    await s.pause();
    const [chatId] = await s.seedCatalog(1);
    const [migration] = await s.prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC LIMIT 1`;
    const at = migration!.at.getTime() - 5000;
    const ownerId = await s.ingest({
      chatId: chatId!,
      messageId: `legacy-compat-${randomUUID()}`,
      text: 'Original legacy fixture source',
      at,
    });
    const owner = await s.prisma.webhookEvent.update({
      where: { id: ownerId },
      data: {
        status: 'FAILED',
        createdAt: new Date(at + 1000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    await s.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: owner.semanticKey!,
        webhookEventId: ownerId,
        enforced: false,
        createdAt: owner.createdAt,
      },
    });
    const candidate = await inspectLegacyRecoveryCandidate(s.prisma, ownerId, [s.bots[0]!.id]);
    expect(candidate).not.toBeNull();
    // Construct the exact pre-migration wire shape independently from new snapshot helpers.
    const oldOwner = Object.fromEntries(
      Object.entries(candidate!.owner).filter(
        ([key]) => !['sourceDispositionId', 'sourceDispositionReceiptId'].includes(key),
      ),
    );
    const oldHash = (value: unknown) =>
      createHash('sha256')
        .update(JSON.stringify(canonical(value)))
        .digest('hex');
    const previewSha256 = oldHash({
      version: 1,
      candidates: [
        {
          ownerDigest: oldHash(oldOwner),
          claimDigest: oldHash(candidate!.claim),
          source: candidate!.source,
          rawPayloadDigest: candidate!.rawPayloadDigest,
          normalizedPayloadDigest: candidate!.normalizedPayloadDigest,
        },
      ],
      children: [],
    });
    expect(buildLegacyRecoveryPreviewDigest([candidate!], [])).toBe(previewSha256);
    const sourceSha = 'c'.repeat(40);
    const imageId = `sha256:${'d'.repeat(64)}`;
    const previousOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    let certificateId: string;
    try {
      const certificate = await createLegacyColdCertificate(s.prisma, {
        version: 1,
        sourceSha,
        imageId,
        previewSha256,
        transitionJournalSha256: oldHash('legacy-compat-journal'),
        queueFenceNonce: 'native-legacy-compatibility-only',
        roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
          (serviceName) => ({
            serviceName,
            containerId: oldHash(serviceName),
            sourceSha,
            imageId,
            stopped: true,
          }),
        ),
      });
      certificateId = certificate.id;
      legacyCertificateIds.push(certificateId);
      await installAndSealLegacyRecoveryBatch(s.prisma, certificateId, [candidate!], []);
    } finally {
      if (previousOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
      else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = previousOffline;
    }
    const proof = await s.prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
      where: { receiptId: ownerId },
    });
    const oldReceipt = Object.fromEntries(
      Object.entries(oldOwner).filter(
        ([key]) => !['legacyDispositionId', 'legacyDispositionReceiptId'].includes(key),
      ),
    );
    expect(proof.sourceDigest).toBe(oldHash(oldReceipt));
    const recovery = await s.prisma.webhookLegacyRecovery.findUniqueOrThrow({
      where: { ownerWebhookEventId: ownerId },
    });
    expect(recovery.ownerSnapshot).not.toHaveProperty('sourceDispositionId');
    expect(recovery.ownerSnapshot).not.toHaveProperty('sourceDispositionReceiptId');
    expect(await s.legacyHolds.materializeReceipt(ownerId)).toBe('ALREADY_APPLIED_SAME_PROOF');
    expect(
      await readLegacyRecoveryInstallation(s.prisma, certificateId!, {
        sourceSha,
        imageId,
        previewSha256,
        recoveries: 1,
        children: 0,
      }),
    ).toMatchObject({ state: 'SEALED' });
    expect(s.effects).toEqual([]);
  });
});
