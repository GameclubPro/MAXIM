import { persistVoiceSource } from '../moderation/voice-webhook-source';
import { randomUUID } from 'node:crypto';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { markMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { MaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { Queue, type ConnectionOptions } from 'bullmq';
import {
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  type MaxActionJob,
} from '../max/max-client.service';
import { Prisma, type ChannelSettings } from '../prisma/prisma-client';
import { ChannelAutoPostScanManager } from '../moderation/channel-auto-post-runtime';
import { ChannelPostDemandRuntime } from '../moderation/channel-post-demand-runtime';
import { createRecoveryGovernorFixture } from '../system/background-runtime-governor.spec-support';
import { RequiredSubscriptionExecutionRejectedError } from '../moderation/required-subscription-execution-guard.service';
import { ChannelPostSignatureService } from '../admin/channel-post-signature.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import {
  markMaxPreDispatchGuardRejected,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
} from '../max/max-action-pre-dispatch-guard';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import {
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from '../moderation/message-limits-delete-guard.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native current-rule authorization across mirrored bot delivery', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });
  async function fixture(bots = 4) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
    return h;
  }

  it.each([19, 20, 21])(
    'enforces the visible length boundary once across four bots (%i characters)',
    async (length) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1, { maxMessageLength: 20 });
      const messageId = `visible-length-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: '👨‍👩‍👧‍👦'.repeat(length),
          }),
        ),
      );
      await s.drain();
      if (length > 20) await waitForUserDelete(s, chatId!, messageId);
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toHaveLength(length > 20 ? 1 : 0);
      if (length <= 20) expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      const receipts = await s.prisma.webhookEvent.findMany({
        where: { id: { in: ids } },
        select: { status: true },
      });
      expect(receipts).toHaveLength(4);
      expect(
        receipts.every(
          (receipt) => receipt.status === 'PROCESSED' || receipt.status === 'DUPLICATE',
        ),
      ).toBe(true);
      expect(s.failures).toEqual([]);
    },
  );

  it.each(['forward', 'reply', 'forward-preview'])(
    'does not strike or delete short visible %s content across four bots',
    async (type) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1, {
        messageLimitsBanEnabled: true,
        messageLimitsWarnEnabled: true,
      });
      const messageId = `visible-forward-${randomUUID()}`;
      const at = Date.now();
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: type === 'reply' ? 'Да' : '',
            link: {
              type: type === 'reply' ? 'reply' : 'forward',
              message: {
                mid: 'a-long-unrelated-message-id',
                text:
                  type === 'reply'
                    ? 'x'.repeat(100)
                    : type === 'forward-preview'
                      ? 'Привет https://i.oneme.ru/i?r=preview'
                      : 'Привет',
                attachments: [
                  type === 'forward-preview'
                    ? {
                        type: 'media',
                        payload: { media_type: 'image', url: 'https://i.oneme.ru/i?r=preview' },
                      }
                    : { type: 'photo', payload: { token: 'a-long-unrelated-photo-token' } },
                ],
              },
            },
          }),
        ),
      );
      await s.drain();
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(0);
      expect(s.failures).toEqual([]);
    },
  );

  it.each(['off', 'shadow', 'on'] as const)(
    'deletes links from an omitted member once and progresses mirrored receipts (%s)',
    async (mode) => {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 4, mode });
      const s = h;
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiSpamEnabled: false,
        linkPolicy: 'BLOCKLIST_ONLY',
        linkPolicyRevision: 1,
        linkPolicyEffectiveAt: new Date(Date.now() - 60_000),
      });
      const member = s.max.getChatMemberAccess.bind(s.max);
      jest
        .spyOn(s.max, 'getChatMemberAccess')
        .mockImplementation((chat, user, options) =>
          user === 'fixture-user' ? Promise.resolve(null) : member(chat, user, options),
        );
      const roster = jest.spyOn(s.max, 'getChatAdminAccesses');
      const messageId = `link-missing-member-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: 'https://blocked.example/path',
          }),
        ),
      );
      await s.drain();
      await waitForUserDelete(s, chatId!, messageId);
      expect(roster).toHaveBeenCalledWith(chatId, expect.objectContaining({ bypassCache: true }));
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toHaveLength(1);
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        include: { reasons: true },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.reasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleCode: 'LINK_BLOCKED_DELETE' })]),
      );
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      const next = await s.ingest({
        chatId: chatId!,
        messageId: `after-link-${randomUUID()}`,
        text: 'ordinary text',
      });
      await s.drain();
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: next } })).toMatchObject({
        status: 'PROCESSED',
      });
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toHaveLength(1);
      expect(s.failures).toEqual([]);
    },
  );

  it('backs off an unavailable author roster without dispatch or repeated immediate retries', async () => {
    const s = await fixture(2);
    const effectiveAt = new Date(Date.now() - 60_000);
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      antiSpamEnabled: false,
      linkPolicy: 'BLOCKLIST_ONLY',
      linkPolicyRevision: 1,
      linkPolicyEffectiveAt: effectiveAt,
    });
    const messageId = `link-roster-unavailable-${randomUUID()}`;
    const at = source(s, chatId!, messageId, 'https://blocked.example/path');
    const ensured = await s.intents.ensureIntent(
      {
        chatId: chatId!,
        messageId,
        subjectUserId: 'fixture-user',
        sourceMessageAt: at,
        originBotId: s.bots[0]!.id,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        reasonKey: 'link',
        ruleCode: 'LINK_BLOCKED_DELETE',
        event: {
          userId: 'fixture-user',
          eventType: 'MESSAGE',
          metadata: { linkPolicyRevision: 1, linkPolicyEffectiveAt: effectiveAt.toISOString() },
        },
      },
      { enqueue: false },
    );
    if (!ensured.intentId) throw new Error('Expected an executable link intent');
    await s.prisma.moderationDeleteIntent.update({
      where: { id: ensured.intentId },
      data: { attemptCount: 4000 },
    });
    const member = s.max.getChatMemberAccess.bind(s.max);
    jest
      .spyOn(s.max, 'getChatMemberAccess')
      .mockImplementation((chat, user, options) =>
        user === 'fixture-user' ? Promise.resolve(null) : member(chat, user, options),
      );
    const roster = jest
      .spyOn(s.max, 'getChatAdminAccesses')
      .mockRejectedValue(
        Object.assign(new Error('Roster unavailable'), { response: { status: 503 } }),
      );
    const before = Date.now();
    expect(
      await s.intents.attemptIntent(ensured.intentId, { deferGuardFailure: true }),
    ).toMatchObject({ status: 'RETRYABLE', confirmed: false });
    const actual = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: ensured.intentId },
    });
    expect(actual.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(before + 240_000);
    expect(actual.attemptCount).toBe(4001);
    expect(actual.deleteDispatchStartedAt).toBeNull();
    expect(actual.remoteDeleteSucceededAt).toBeNull();
    expect(s.effects).toEqual([]);
    await s.intents.attemptIntent(ensured.intentId, { deferGuardFailure: true });
    expect(roster).toHaveBeenCalledTimes(1);
    expect(s.messages.has(messageId)).toBe(true);
  });

  it('deletes sticker cooldown violations and later muted stickers across mirrored receipts', async () => {
    h = await createMultibotHarness({
      databaseUrl,
      redisUrl,
      bots: 2,
      mode: 'on',
      recoverAutomaticMuteHistory: true,
    });
    const s = h;
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      antiSpamEnabled: false,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
      messageLimitsWarnEnabled: false,
      messageLimitsMuteEnabled: true,
      messageLimitsBanEnabled: false,
    });
    const sendSticker = async (messageId: string) => {
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: '',
            attachments: [{ type: 'sticker', payload: { code: 'fixture-sticker' } }],
          }),
        ),
      );
      await s.drain();
      return ids;
    };
    const first = `sticker-allowed-${randomUUID()}`;
    await sendSticker(first);
    expect(s.effects).toEqual([]);

    const violations = Array.from({ length: 3 }, () => `sticker-violation-${randomUUID()}`);
    for (const messageId of violations) {
      await sendSticker(messageId);
      await waitForUserDelete(s, chatId!, messageId);
    }
    const mute = await s.prisma.moderationEvent.findFirstOrThrow({
      where: { chatId, userId: 'fixture-user', action: 'MUTE' },
    });
    expect(mute.ruleCode).toBe('STICKER_RATE_LIMIT');
    expect(mute.metadata).toEqual(expect.objectContaining({ sanctionApplied: true }));

    const muted = `sticker-muted-${randomUUID()}`;
    const ids = await sendSticker(muted);
    await waitForUserDelete(s, chatId!, muted);
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId: muted } },
      include: { reasons: true },
    });
    expect(intent.reasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleCode: 'MUTE_ACTIVE_DELETE',
          metadata: expect.objectContaining({ moderationDeleteVerified: true }),
        }),
      ]),
    );
    for (const messageId of violations) expect(s.messages.has(messageId)).toBe(false);
    expect(s.messages.has(muted)).toBe(false);
    // FLAG: A new automatic mute enrolls prior observed messages in its immutable 30-minute window.
    expect(s.messages.has(first)).toBe(false);
    const cleanup = await s.prisma.automaticMuteCleanup.findUniqueOrThrow({
      where: { eventId: mute.id },
    });
    expect(cleanup.status).toBe('SCANNED');
    const deletions = s.effects.filter((effect) => effect.method === 'delete');
    expect(deletions).toHaveLength(5);
    for (const id of ids) await s.moderation.processWebhookEvent(id);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual(deletions);
    expect(s.failures).toEqual([]);
  });

  it('routes durable demand through the background scheduler within its channel budget', async () => {
    const s = await fixture(2);
    for (const bot of s.bots)
      s.setBotPermissions(bot.id, ['read_all_messages', 'write', 'edit_message', 'delete_message']);
    const [chatId] = await s.seedCatalog(2, {}, 'CHANNEL');
    const messageId = `scheduled-demand-${randomUUID()}`;
    const receipt = await s.ingest({
      chatId: chatId!,
      messageId,
      text: 'Exact post outside latest page',
      senderless: true,
    });
    const scheduler = s.moderation as unknown as {
      backgroundTasksEnabled: boolean;
      channelAutoPostScanMaxChannels: number;
      resolveChannelAutoPostExecutionPlan: () => Promise<{
        batchSize: number;
        maxNewMessagesPerScan: number;
        interChannelDelayMs: number;
      }>;
      processChannelAutoPostButtons: () => Promise<void>;
    };
    scheduler.backgroundTasksEnabled = true;
    scheduler.channelAutoPostScanMaxChannels = 2;
    jest
      .spyOn(scheduler, 'resolveChannelAutoPostExecutionPlan')
      .mockResolvedValue({ batchSize: 2, maxNewMessagesPerScan: 1, interChannelDelayMs: 0 });
    const list = jest.spyOn(s.max, 'listMessages').mockResolvedValue([]);
    await scheduler.processChannelAutoPostButtons();
    expect(s.effects.filter((e) => e.method === 'put' && e.messageId === messageId)).toHaveLength(
      1,
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(await s.prisma.channelPostDemand.count({ where: { chatId } })).toBe(0);
    expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt } })).status).toBe(
      'RECEIVED',
    );
  });

  it.each(['healthy', 'manual', 'max', 'queue', 'cpu', 'io', 'background-share'] as const)(
    'admits channel demand through the real governor during %s recovery',
    async (pressure) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(2, {}, 'CHANNEL');
      const messageId = `recovery-demand-${randomUUID()}`;
      const receipt = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Pending channel action',
        senderless: true,
      });
      const { governor, snapshot } = createRecoveryGovernorFixture(s.config);
      if (pressure === 'manual')
        Object.assign(snapshot.mode, {
          source: 'manual',
          manualMode: 'degrade',
          condition: 'manual',
          reason: 'maintenance',
        });
      if (pressure === 'max')
        Object.assign(snapshot.mode, {
          condition: 'max_api',
          reason: 'MAX degraded',
        });
      if (pressure === 'queue') snapshot.queues.operationalLagSec = 3;
      if (pressure === 'cpu') snapshot.systemPressure.loadRatio1m = 1.3;
      if (pressure === 'io') snapshot.systemPressure.ioWaitRatio = 0.5;
      if (pressure === 'background-share') snapshot.backgroundShare = 0.8;
      Object.assign(s.moderation, {
        backgroundTasksEnabled: true,
        channelAutoPostScanMaxChannels: 2,
        channelAutoPostScanManager: new ChannelAutoPostScanManager({
          scanIntervalMs: 30_000,
          scanMaxChannels: 2,
          idleBackoffMaxMs: 300_000,
          repairSweepMs: 60_000,
          rateLimitBackoffMs: 60_000,
          throttleBackoffMaxMs: 300_000,
        }),
        backgroundRuntimeGovernorService: governor,
      });
      const scheduler = s.moderation as unknown as {
        processChannelAutoPostButtons: () => Promise<void>;
      };
      const read = jest.spyOn(s.max, 'getExactMessageRow');
      const list = jest.spyOn(s.max, 'listMessages').mockResolvedValue([]);
      await scheduler.processChannelAutoPostButtons();
      const admitted = pressure === 'healthy' || pressure === 'background-share';
      expect(s.effects.filter((e) => e.method === 'put' && e.messageId === messageId)).toHaveLength(
        admitted ? 1 : 0,
      );
      expect(await s.prisma.channelPostDemand.count({ where: { chatId } })).toBe(admitted ? 0 : 1);
      if (!admitted) {
        expect(read).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      } else {
        expect(await s.prisma.auditLog.findFirst({ where: { chatId } })).toMatchObject({
          payload: expect.objectContaining({ source: 'poll', schedulingOrigin: 'durable_demand' }),
        });
      }
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt } })).status,
      ).toBe('RECEIVED');
    },
  );

  it.each(['healthy', 'queue', 'cpu', 'manual', 'max', 'transport', 'unavailable'] as const)(
    'rechecks channel pressure on the next scheduler tick without bypassing %s admission',
    async (next) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const messageId = `pressure-pulse-${randomUUID()}`;
      await s.ingest({ chatId: chatId!, messageId, text: 'Pending action', senderless: true });
      const { governor, snapshot } = createRecoveryGovernorFixture(s.config);
      Object.assign(snapshot.mode, { mode: 'normal', condition: 'healthy', reason: 'healthy' });
      snapshot.queues.operationalLagSec = 5;
      Object.assign(s.moderation, {
        backgroundTasksEnabled: true,
        channelAutoPostScanMaxChannels: 2,
        channelAutoPostScanManager: new ChannelAutoPostScanManager({
          scanIntervalMs: 30_000,
          scanMaxChannels: 2,
          idleBackoffMaxMs: 300_000,
          repairSweepMs: 60_000,
          rateLimitBackoffMs: 60_000,
          throttleBackoffMaxMs: 300_000,
        }),
        backgroundRuntimeGovernorService: governor,
      });
      const scheduler = s.moderation as unknown as {
        channelAutoPostBackoffUntilMs: number;
        processChannelAutoPostButtons: () => Promise<void>;
      };
      const read = jest.spyOn(s.max, 'getExactMessageRow');
      const list = jest.spyOn(s.max, 'listMessages').mockResolvedValue([]);
      await scheduler.processChannelAutoPostButtons();
      expect(read).not.toHaveBeenCalled();
      expect(list).not.toHaveBeenCalled();
      snapshot.queues.operationalLagSec = next === 'queue' ? 5 : 0;
      if (next === 'cpu') snapshot.systemPressure.loadRatio1m = 1.3;
      if (next === 'manual')
        Object.assign(snapshot.mode, {
          mode: 'degrade',
          source: 'manual',
          manualMode: 'degrade',
          condition: 'manual',
        });
      if (next === 'max') Object.assign(snapshot.mode, { mode: 'degrade', condition: 'max_api' });
      const transportDeadline = Date.now() + 60_000;
      if (next === 'transport') scheduler.channelAutoPostBackoffUntilMs = transportDeadline;
      if (next === 'unavailable')
        jest.spyOn(governor, 'decide').mockRejectedValue(new Error('offline'));
      // FLAG: Each invocation represents a scheduled tick; real store/source clocks stay unchanged.
      await scheduler.processChannelAutoPostButtons();
      const admitted = next === 'healthy';
      expect(
        s.effects.filter((effect) => effect.method === 'put' && effect.messageId === messageId),
      ).toHaveLength(admitted ? 1 : 0);
      expect(await s.prisma.channelPostDemand.count({ where: { chatId } })).toBe(admitted ? 0 : 1);
      if (!admitted) {
        expect(read).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      }
      if (next === 'transport')
        expect(scheduler.channelAutoPostBackoffUntilMs).toBe(transportDeadline);
    },
  );

  it('retires durable demand after a confirmed webhook edit without another MAX read', async () => {
    const s = await fixture(2);
    const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
    const messageId = `completed-demand-${randomUUID()}`;
    await s.ingest({
      chatId: chatId!,
      messageId,
      text: 'Already decorated fixture',
      senderless: true,
    });
    const marker = await s.prisma.channelAutoPostAttachMarker.create({
      data: {
        chatId: chatId!,
        messageId,
        source: 'webhook',
        status: 'SUCCEEDED',
        botId: s.bots[1]!.id,
        deliveryMode: 'edit_message',
      },
    });
    const runtime = (s.moderation as unknown as { channelPostDemand: ChannelPostDemandRuntime })
      .channelPostDemand;
    const read = jest.spyOn(s.max, 'getExactMessageRow');
    const access = jest.spyOn(s.max, 'getCurrentChatMemberAccess');
    await runtime.process(
      {
        channelSettings: await s.prisma.channelSettings.findUniqueOrThrow({ where: { chatId } }),
        adminUserIds: [],
      },
      1,
      30_000,
    );
    expect(read).not.toHaveBeenCalled();
    expect(access).not.toHaveBeenCalled();
    expect(s.effects).toEqual([]);
    expect(await s.prisma.channelPostDemand.count({ where: { chatId } })).toBe(0);
    expect(
      await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where: { id: marker.id } }),
    ).toEqual(marker);
  });

  it.each([
    'allowed',
    'access_lost',
    'held',
    'settings_off',
    'source_missing',
    'first_read_failed',
  ] as const)(
    'services exact durable post demand before webhook execution, guard=%s',
    async (guard) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const blockedId = `a-demand-${randomUUID()}`,
        laterId = `b-demand-${randomUUID()}`;
      const ids = [];
      for (const messageId of [blockedId, laterId])
        ids.push(
          await s.ingest({ chatId: chatId!, messageId, text: 'Durable fixture', senderless: true }),
        );
      const marker = await s.prisma.channelAutoPostAttachMarker.create({
        data: {
          chatId: chatId!,
          messageId: blockedId,
          source: 'webhook',
          botId: s.bots[1]!.id,
          lockToken: randomUUID(),
          lockedAt: new Date(),
          deliveryMode: 'edit_message',
          lastError: 'Retained unknown effect fixture',
        },
      });
      const runtime = (s.moderation as unknown as { channelPostDemand: ChannelPostDemandRuntime })
        .channelPostDemand;
      const context = {
        channelSettings: await s.prisma.channelSettings.findUniqueOrThrow({ where: { chatId } }),
        adminUserIds: [],
      };
      const list = jest.spyOn(s.max, 'listMessages').mockResolvedValue([]);
      expect(await s.prisma.channelPostDemand.count({ where: { chatId } })).toBe(2);
      if (guard === 'first_read_failed') {
        const failure = Object.assign(new Error('Source temporarily unavailable'), {
          response: { status: 503 },
        });
        jest.spyOn(s.max, 'getExactMessageRow').mockRejectedValueOnce(failure);
        await expect(runtime.process(context, 3, 30_000)).rejects.toBe(failure);
      } else await runtime.process(context, 1, 30_000);
      expect(s.effects).toEqual([]);
      if (guard === 'access_lost') for (const bot of s.bots) s.denyBot(bot.id);
      if (guard === 'held') {
        const holds = s.moderation as unknown as {
          legacyHolds: { isMessageHeld: (c: string, m: string) => Promise<boolean> };
        };
        jest
          .spyOn(holds.legacyHolds, 'isMessageHeld')
          .mockImplementation(async (_, id) => id === laterId);
      }
      if (guard === 'source_missing') s.messages.delete(laterId);
      if (guard === 'settings_off') {
        context.channelSettings = await s.prisma.channelSettings.update({
          where: { chatId },
          data: {
            commentsEnabled: false,
            postSignatureEnabled: false,
            postSuggestionsEnabled: false,
            quickButtonsEnabled: false,
          },
        });
      }
      if (guard === 'source_missing')
        await expect(runtime.process(context, 1, 30_000)).rejects.toMatchObject({
          response: { status: 404 },
        });
      else if (guard === 'access_lost')
        await expect(runtime.process(context, 1, 30_000)).rejects.toMatchObject({
          response: { status: 403, data: { code: 'chat.denied' } },
        });
      else await runtime.process(context, 1, 30_000);
      expect(s.effects.filter((e) => e.method === 'put')).toHaveLength(
        guard === 'allowed' || guard === 'first_read_failed' ? 1 : 0,
      );
      expect(s.effects.every((e) => e.method === 'put' && e.messageId === laterId)).toBe(true);
      expect(
        await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where: { id: marker.id } }),
      ).toEqual(marker);
      expect(list).not.toHaveBeenCalled();
      expect(
        (await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } })).every(
          (r) => r.status === 'RECEIVED',
        ),
      ).toBe(true);
      if (guard === 'source_missing')
        expect(
          await s.prisma.channelPostDemand.count({ where: { chatId, messageId: laterId } }),
        ).toBe(1);
    },
  );

  it.each([
    [404, undefined],
    [403, undefined],
    [404, 'message.not.found'],
    [404, 'chat.not.found'],
    [403, 'chat.denied'],
    [429, undefined],
    [503, undefined],
  ] as const)(
    'preserves channel grants after exact post lookup failure %s/%s and processes its sibling',
    async (status, code) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const missingId = `a-missing-${randomUUID()}`;
      const laterId = `b-readable-${randomUUID()}`;
      for (const messageId of [missingId, laterId])
        await s.ingest({
          chatId: chatId!,
          messageId,
          text: 'Source lookup fixture',
          senderless: true,
        });
      // FLAG: Install the real lifecycle writer. A fixture without it hid the production
      // regression in which one missing message removed the channel's durable grants.
      const accessLoss = new ManagedEntityAccessLossService(s.prisma as never, s.links, s.cache);
      const removal = jest.spyOn(accessLoss, 'recordIfManagedEntityAccessLost');
      Object.assign(s.moderation, { managedEntityAccessLossService: accessLoss });
      await s.prisma.managedEntityAccessEdge.createMany({
        data: s.bots.map((bot) => ({
          chatId: chatId!,
          userId: 'fixture-channel-admin',
          botId: bot.id,
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          checkedAt: new Date(),
        })),
      });
      const edges = () =>
        s.prisma.managedEntityAccessEdge.findMany({
          where: { chatId },
          orderBy: { botId: 'asc' },
        });
      const edgesBefore = await edges();
      const memberships = () =>
        s.prisma.chatBotMembership.findMany({
          where: { chatId },
          orderBy: { botId: 'asc' },
        });
      const before = await memberships();
      const channelBefore = await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
      const runtime = (s.moderation as unknown as { channelPostDemand: ChannelPostDemandRuntime })
        .channelPostDemand;
      const context = {
        channelSettings: await s.prisma.channelSettings.findUniqueOrThrow({ where: { chatId } }),
        adminUserIds: [],
      };
      const failure = Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, ...(code ? { data: { code } } : {}) },
      });
      jest.spyOn(s.max, 'getExactMessageRow').mockRejectedValueOnce(failure);
      let rejected: unknown;
      try {
        await runtime.process(context, 1, 30_000);
      } catch (error) {
        rejected = error;
      }
      expect(await memberships()).toEqual(before);
      expect(await edges()).toEqual(edgesBefore);
      expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toEqual(
        channelBefore,
      );
      expect(removal).not.toHaveBeenCalled();
      expect(rejected).toBe(failure);
      expect(s.effects).toEqual([]);
      expect(
        await s.prisma.channelPostDemand.count({ where: { chatId, messageId: missingId } }),
      ).toBe(1);
      await runtime.process(context, 1, 30_000);
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(1);
      expect(s.effects[0]).toMatchObject({ method: 'put', messageId: laterId });
      expect(
        await s.prisma.channelPostDemand.count({ where: { chatId, messageId: laterId } }),
      ).toBe(0);
    },
  );

  it.each(['allowed', 'access_lost', 'held'] as const)(
    'polls a later channel post while an earlier marker stays leased, guard=%s',
    async (guard) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const settings = await s.prisma.channelSettings.findUniqueOrThrow({ where: { chatId } });
      const at = Date.now();
      const blockedId = `poll-blocked-${randomUUID()}`;
      const laterId = `poll-later-${randomUUID()}`;
      for (const [index, id] of [blockedId, laterId].entries()) {
        s.messages.set(id, {
          timestamp: at + index,
          recipient: { chat_id: chatId, chat_type: 'channel' },
          body: { mid: id, text: 'Independent channel post' },
        });
      }
      const marker = await s.prisma.channelAutoPostAttachMarker.create({
        data: {
          chatId: chatId!,
          messageId: blockedId,
          source: 'webhook',
          botId: s.bots[1]!.id,
          lockToken: randomUUID(),
          lockedAt: new Date(),
          deliveryMode: 'edit_message',
          lastError: 'Retained unknown effect fixture',
        },
      });
      jest
        .spyOn(s.max, 'listMessages')
        .mockImplementation(async () => [s.messages.get(laterId)!, s.messages.get(blockedId)!]);
      const poller = s.moderation as unknown as {
        channelAutoPostScanManager: ChannelAutoPostScanManager;
        processManagedChannelAutoPostButtons: (
          channel: { channelSettings: ChannelSettings; adminUserIds: string[] },
          options: { maxNewMessagesPerScan: number },
        ) => Promise<void>;
      };
      const channel = { channelSettings: settings, adminUserIds: [] };
      await poller.processManagedChannelAutoPostButtons(channel, { maxNewMessagesPerScan: 1 });
      expect(s.effects).toEqual([]);
      if (guard === 'access_lost') for (const bot of s.bots) s.denyBot(bot.id);
      if (guard === 'held') {
        const holds = s.moderation as unknown as {
          legacyHolds: { isMessageHeld: (chatId: string, messageId: string) => Promise<boolean> };
        };
        jest
          .spyOn(holds.legacyHolds, 'isMessageHeld')
          .mockImplementation(async (_, id) => id === laterId);
      }
      poller.channelAutoPostScanManager.states.get(chatId!)!.nextScanAtMs = 0;
      await poller.processManagedChannelAutoPostButtons(channel, { maxNewMessagesPerScan: 1 });
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(
        guard === 'allowed' ? 1 : 0,
      );
      expect(
        s.effects.every((effect) => effect.method === 'put' && effect.messageId === laterId),
      ).toBe(true);
      expect(
        await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where: { id: marker.id } }),
      ).toEqual(marker);
      expect(poller.channelAutoPostScanManager.states.get(chatId!)?.latestTimestampMs).toBe(0);
      if (guard === 'allowed') {
        expect(
          await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({
            where: { chatId_messageId: { chatId: chatId!, messageId: laterId } },
          }),
        ).toMatchObject({ status: 'SUCCEEDED', deliveryMode: 'edit_message' });
      }
      expect(s.failures).toEqual([]);
    },
  );

  it.each(['profile', 'vcard'] as const)(
    'adds channel actions to a %s contact once across mirrored bots',
    async (kind) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const vcard = 'BEGIN:VCARD\nVERSION:3.0\nFN:Test Contact\nEND:VCARD';
      const payload =
        kind === 'profile'
          ? { max_info: { user_id: 123456789, name: 'Test Contact', is_bot: false } }
          : { vcf_info: vcard, name: 'Test Contact' };
      const expected =
        kind === 'profile'
          ? { contact_id: '123456789', name: 'Test Contact' }
          : { vcf_info: vcard, name: 'Test Contact' };
      const messageId = `contact-actions-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            senderless: true,
            text: '',
            attachments: [{ type: 'contact', payload }],
          }),
        ),
      );
      await s.drain();
      expect(s.effects).toHaveLength(1);
      expect(s.effects[0]).toMatchObject({
        method: 'put',
        messageId,
        body: {
          attachments: [
            { type: 'contact', payload: expected },
            expect.objectContaining({ type: 'inline_keyboard' }),
          ],
        },
      });
      expect(s.messages.get(messageId)).toMatchObject({ body: { text: '' } });
      expect(
        await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: chatId!, messageId } },
        }),
      ).toMatchObject({ status: 'SUCCEEDED', deliveryMode: 'edit_message' });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(s.effects).toHaveLength(1);
      expect(s.failures).toEqual([]);
    },
  );

  it.each([false, true])(
    'signs a manually published channel post exactly once through mirrored receipts, senderless=%s',
    async (senderless) => {
      const s = await fixture(2);
      for (const bot of s.bots) {
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      }
      s.allowAdminUser('fixture-user');
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      await s.prisma.channelSettings.update({
        where: { chatId: chatId! },
        data: {
          commentsEnabled: false,
          postSignatureEnabled: true,
          postSignaturePresentation: 'SIGNATURE',
          postSignatureText: 'Наш канал',
          postSignatureUrl: 'https://max.ru/fixture-channel',
        },
      });
      Object.assign(s.moderation, {
        channelPostSignatureService: new ChannelPostSignatureService(
          s.prisma as never,
          s.max,
          s.links,
        ),
      });
      const messageId = `manual-signature-${randomUUID()}`;
      const attachments = [{ type: 'image', payload: { token: 'fixture-image' } }];
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            senderless,
            text: 'Ручной пост',
            attachments,
          }),
        ),
      );
      await s.drain();
      const edits = s.effects.filter((effect) => effect.method === 'put');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.body).toMatchObject({
        text: 'Ручной пост\n\n<a href="https://max.ru/fixture-channel">Наш канал</a>',
        format: 'html',
        attachments,
      });
      expect(s.effects.filter((effect) => effect.method !== 'put')).toEqual([]);
      expect(
        await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: chatId!, messageId } },
        }),
      ).toMatchObject({ status: 'SUCCEEDED', deliveryMode: 'edit_message' });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(s.effects).toHaveLength(1);
      expect(s.failures).toEqual([]);
    },
  );

  it.each(
    (['off', 'shadow', 'canary', 'on'] as const).flatMap((mode) =>
      (['audio', 'voice'] as const).map((type) => ({ mode, type })),
    ),
  )(
    'deletes one mirrored textless $type message with durable rollout $mode',
    async ({ mode, type }) => {
      const s = await fixture(4);
      Object.assign(s.intents, { mode });
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        voiceMessagesEnabled: false,
      });
      const messageId = `voice-${randomUUID()}`;
      const lookup = jest
        .spyOn(s.max, 'getExactMessageRow')
        .mockRejectedValue(new MaxExactMessageLookupMissingIdError());
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: '',
            attachments: [{ type, payload: { url: 'https://media.invalid/fixture.opus' } }],
          }),
        ),
      );
      await s.drain();
      await waitForUserDelete(s, chatId!, messageId);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(s.effects.filter((effect) => effect.method !== 'delete')).toEqual([]);
      expect(lookup).not.toHaveBeenCalled();
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        include: { reasons: true },
      });
      expect(intent.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleCode: 'VOICE_BLOCKED_DELETE',
            metadata: expect.objectContaining({ moderationDeleteVerified: true }),
          }),
        ]),
      );
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
      expect(receipts.filter((row) => row.status === 'DUPLICATE')).toHaveLength(3);
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `voice-next-${randomUUID()}`,
        text: 'Next',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(s.failures).toEqual([]);
    },
  );

  it.each(
    (['mute', 'night', 'manual'] as const).flatMap((restriction) =>
      ['audio', 'voice', 'audio_message', 'ptt', 'image', 'video', 'file', 'sticker', 'text']
        .map((type) => ({ restriction, type, mode: 'canary' }))
        .concat(['off', 'shadow', 'on'].map((mode) => ({ restriction, type: 'audio', mode }))),
    ),
  )(
    'deletes allowed $type under $restriction with rollout $mode and exact source authority',
    async ({ restriction, type, mode }) => {
      const s = await fixture(2);
      Object.assign(s.intents, { mode });
      const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        voiceMessagesEnabled: true,
        nightModeEnabled: restriction === 'night',
        nightModeTimezone: 'UTC',
        nightModeStartTimeMinutes: (minute + 1440 - 60) % 1440,
        nightModeEndTimeMinutes: (minute + 60) % 1440,
        nightModeForceCloseEnabled: restriction === 'manual',
        nightModeForceCloseForever: restriction === 'manual',
      });
      if (restriction === 'mute') {
        await s.prisma.moderationEvent.create({
          data: {
            chatId: chatId!,
            userId: 'fixture-user',
            eventType: 'MEMBER_ACTION',
            ruleCode: 'MANUAL_MUTE',
            action: 'MUTE',
            operator: 'ADMIN',
            score: 1,
            createdAt: new Date(Date.now() - 1_000),
            metadata: { mutePermanent: true },
          },
        });
      }
      const nativeVoice = ['audio', 'voice', 'audio_message', 'ptt'].includes(type);
      const lookup = jest.spyOn(s.max, 'getExactMessageRow');
      if (nativeVoice) lookup.mockRejectedValue(new MaxExactMessageLookupMissingIdError());
      const messageId = `restricted-voice-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: type === 'text' ? 'Ordinary text' : '',
            attachments: type === 'text' ? [] : [{ type, payload: { token: 'local-fixture' } }],
          }),
        ),
      );
      await s.drain();
      await waitForUserDelete(s, chatId!, messageId);
      if (nativeVoice) expect(lookup).not.toHaveBeenCalled();
      else expect(lookup).toHaveBeenCalled();
      const ruleCode =
        restriction === 'mute'
          ? 'MUTE_ACTIVE_DELETE'
          : restriction === 'night'
            ? 'NIGHT_MODE_DELETE'
            : 'MANUAL_GROUP_CLOSE_DELETE';
      expect(
        await s.prisma.moderationEvent.findMany({
          where: { chatId, messageId, action: 'DELETE_MESSAGE' },
          select: { ruleCode: true },
        }),
      ).toEqual([{ ruleCode }]);
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(s.effects.filter((e) => e.method === 'delete')).toHaveLength(1);
      expect(s.effects.filter((e) => e.method !== 'delete')).toEqual([]);
      lookup.mockRestore();
      const nextMessageId = `after-restriction-${randomUUID()}`;
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: nextMessageId,
        text: 'Next',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(s.failures).toEqual([]);
    },
  );

  it.each(
    (['mute', 'night', 'manual'] as const).flatMap((restriction) =>
      (['source_revoked', 'restriction_removed'] as const).map((change) => ({
        restriction,
        change,
      })),
    ),
  )(
    'preserves voice after $change under $restriction before dispatch',
    async ({ restriction, change }) => {
      const s = await fixture(2);
      const minute = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        voiceMessagesEnabled: true,
        nightModeEnabled: restriction === 'night',
        nightModeTimezone: 'UTC',
        nightModeStartTimeMinutes: (minute + 1380) % 1440,
        nightModeEndTimeMinutes: (minute + 60) % 1440,
        nightModeForceCloseEnabled: restriction === 'manual',
        nightModeForceCloseForever: restriction === 'manual',
      });
      if (restriction === 'mute')
        await s.prisma.moderationEvent.create({
          data: {
            chatId: chatId!,
            userId: 'fixture-user',
            eventType: 'MEMBER_ACTION',
            ruleCode: 'MANUAL_MUTE',
            action: 'MUTE',
            operator: 'ADMIN',
            score: 1,
            createdAt: new Date(Date.now() - 1_000),
            metadata: { mutePermanent: true },
          },
        });
      jest
        .spyOn(s.max, 'getExactMessageRow')
        .mockRejectedValue(new MaxExactMessageLookupMissingIdError());
      const ensure = s.intents.ensureAndAttempt.bind(s.intents);
      let changed = false;
      jest.spyOn(s.intents, 'ensureAndAttempt').mockImplementation(async (input, options) => {
        if (!changed) {
          changed = true;
          if (change === 'source_revoked') {
            await persistVoiceSource(
              s.prisma,
              { kind: 'invalidate', chatId: chatId!, messageId: input.messageId },
              'edit',
            );
          } else if (restriction === 'mute') {
            await s.prisma.moderationEvent.create({
              data: {
                chatId: chatId!,
                userId: 'fixture-user',
                eventType: 'MEMBER_ACTION',
                ruleCode: 'MANUAL_UNMUTE',
                action: 'NONE',
                operator: 'ADMIN',
                score: 1,
              },
            });
          } else {
            await s.prisma.chatSettings.update({
              where: { chatId: chatId! },
              data: {
                nightModeEnabled: false,
                nightModeForceCloseEnabled: false,
              },
            });
          }
        }
        return ensure(input, options);
      });
      const messageId = `revoked-state-voice-${randomUUID()}`;
      await s.ingest({ chatId: chatId!, messageId, text: '', attachments: [{ type: 'audio' }] });
      await s.drain();
      expect(changed).toBe(true);
      expect(s.effects).toEqual([]);
      expect(s.messages.has(messageId)).toBe(true);
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        include: { reasons: true },
      });
      expect(intent.status).toBe('FAILED_TERMINAL');
      expect(intent.remoteDeleteSucceededAt).toBeNull();
      expect(
        intent.reasons.every(
          (reason) =>
            (reason.metadata as Record<string, unknown>)?.moderationDeleteVerified !== true,
        ),
      ).toBe(true);
      expect(s.failures).toEqual([]);
    },
  );

  it.each([
    'allowed',
    'administrator',
    'policy_changed_before_delete',
    'edited_before_delete',
  ] as const)('preserves a voice message when %s denies deletion', async (variant) => {
    const s = await fixture(2);
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      voiceMessagesEnabled: variant === 'allowed',
    });
    if (variant === 'administrator') s.allowAdminUser('fixture-user');
    let changed = false;
    const ensure = s.intents.ensureAndAttempt.bind(s.intents);
    if (variant === 'policy_changed_before_delete' || variant === 'edited_before_delete') {
      jest.spyOn(s.intents, 'ensureAndAttempt').mockImplementation(async (input, options) => {
        if (input.ruleCode === 'VOICE_BLOCKED_DELETE' && !changed) {
          changed = true;
          if (variant === 'policy_changed_before_delete') {
            await s.prisma.chatSettings.update({
              where: { chatId: chatId! },
              data: { voiceMessagesEnabled: true },
            });
          } else {
            await s.ingest({
              chatId: chatId!,
              messageId: input.messageId,
              text: 'Corrected',
              type: 'message_edited',
            });
          }
        }
        return ensure(input, options);
      });
    }
    const messageId = `preserved-voice-${randomUUID()}`;
    await s.ingest({
      chatId: chatId!,
      messageId,
      text: '',
      attachments: [{ type: 'audio', payload: { url: 'https://media.invalid/fixture.opus' } }],
    });
    await s.drain();
    expect(changed).toBe(
      variant === 'policy_changed_before_delete' || variant === 'edited_before_delete',
    );
    expect(s.messages.has(messageId)).toBe(true);
    expect(s.effects).toEqual([]);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId, action: 'DELETE_MESSAGE' },
      }),
    ).toBe(0);
    expect(s.failures).toEqual([]);
  });

  it('records a qualified DELETE whose deadline elapses before persistence as expired and permits the next same-chat event', async () => {
    const s = await fixture(2);
    const [chatId] = await s.seedCatalog(1, {
      slowModeEnabled: true,
      slowModeIntervalSeconds: 10,
      trafficPolicyEffectiveAt: new Date(Date.now() - 1000),
    });
    await s.ingest({ chatId: chatId!, messageId: `cooldown-first-${randomUUID()}`, text: 'First' });
    await s.drain();
    expect(s.effects).toEqual([]);
    const at = Date.now();
    const messageId = `expired-delete-${randomUUID()}`;
    const ensure = s.intents.ensureIntent.bind(s.intents);
    const persistence = jest
      .spyOn(s.intents, 'ensureIntent')
      .mockImplementationOnce(async (input, options) => {
        expect(input.ruleCode).toBe('SLOW_MODE_DELETE');
        expect(input.executeAt).toBeUndefined();
        const deadline = new Date(input.retryUntilAt!).getTime();
        expect(deadline).toBe(at + 10_000);
        expect(Date.now()).toBeLessThan(deadline);
        // FLAG: Let the real clock expire the original authority after qualification.
        // Keep native stores, persisted evidence and every runtime guard unchanged.
        await new Promise((resolve) => setTimeout(resolve, deadline - Date.now() + 20));
        return ensure(input, options);
      });
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const id = await s.ingest({ chatId: chatId!, messageId, at, text: 'Second' });
    await s.drain();
    expect(persistence).toHaveBeenCalled();
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
    });
    expect(intent).toMatchObject({
      status: 'EXPIRED',
      attemptCount: 0,
      remoteDeleteSucceededAt: null,
      deleteDispatchStartedAt: null,
    });
    expect(intent.retryUntilAt.getTime()).toBe(at + 10_000);
    expect(intent.executeAt).toEqual(intent.retryUntilAt);
    expect(s.effects).toEqual([]);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
      'PROCESSED',
    );
    await s.moderation.processWebhookEvent(id);
    expect(handler).toHaveBeenCalledTimes(1);
    const nextId = await s.ingest({
      chatId: chatId!,
      messageId: `fresh-after-expiry-${randomUUID()}`,
      text: 'Short text',
    });
    await s.drain();
    expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status).toBe(
      'PROCESSED',
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(s.effects).toEqual([]);
  });

  it.each([false, true])(
    'preserves an existing future deletion when an expired immediate reason arrives, retention=%s',
    async (retentionOwned) => {
      const s = await fixture(2);
      const [chatId] = await s.seedCatalog(1);
      const messageId = `future-delete-${randomUUID()}`;
      const executeAt = new Date(Date.now() + 120_000);
      const existing = await s.prisma.moderationDeleteIntent.create({
        data: {
          id: randomUUID(),
          chatId: chatId!,
          messageId,
          subjectUserId: 'fixture-user',
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: s.bots[0]!.id,
          routingPolicy: 'delete_capable',
          retentionOwned,
          executeAt,
          nextAttemptAt: executeAt,
          retryUntilAt: new Date(executeAt.getTime() + 60_000),
          reasons: {
            create: {
              id: randomUUID(),
              reasonKey: 'existing-future',
              ruleCode: retentionOwned ? 'MESSAGE_RETENTION_DELETE' : 'MESSAGE_TOO_LONG_DELETE',
            },
          },
        },
        include: { reasons: true },
      });
      await s.intents.ensureIntent({
        chatId: chatId!,
        messageId,
        reasonKey: 'expired-incoming',
        ruleCode: 'SLOW_MODE_DELETE',
        subjectUserId: 'fixture-user',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: s.bots[0]!.id,
        retryUntilAt: new Date(Date.now() - 1000),
      });
      expect(
        await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: existing.id },
          include: { reasons: true },
        }),
      ).toEqual(existing);
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['recover', 'access_lost', 'held'] as const)(
    'persists an initial channel route quota wait without blocking the next post: %s',
    async (recovery) => {
      const s = await fixture(1);
      s.setBotPermissions(s.bots[0]!.id, [
        'read_all_messages',
        'write',
        'edit_message',
        'delete_message',
      ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const read = s.max.getCurrentChatMemberAccess.bind(s.max);
      let refusals = 0;
      jest.spyOn(s.max, 'getCurrentChatMemberAccess').mockImplementation(async (id, options) => {
        if (options?.sourceTag === MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST && refusals === 0) {
          refusals += 1;
          throw new MaxApiInternalRateLimitError('Fixture initial channel route quota', 250);
        }
        return read(id, options);
      });
      await s.pause();
      const messageId = `route-wait-${randomUUID()}`;
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Channel post',
        senderless: true,
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      await s.ingress.preparePersistedWebhookEvent(id);
      await expect(s.moderation.processWebhookEvent(id)).resolves.toBeUndefined();
      expect(refusals).toBe(1);
      expect(s.effects).toEqual([]);
      expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROCESSED',
      );
      const where = { chatId_messageId: { chatId: chatId!, messageId } };
      expect(await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where })).toMatchObject(
        {
          status: 'IN_PROGRESS',
          deliveryMode: 'edit_message',
          lockedAt: null,
          lockToken: null,
          botId: s.bots[0]!.id,
          replacementMessageId: null,
          replacementSendStartedAt: null,
        },
      );
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `route-next-${randomUUID()}`,
        text: 'Next post',
        senderless: true,
      });
      await s.ingress.preparePersistedWebhookEvent(nextId);
      await s.moderation.processWebhookEvent(nextId);
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      const before = s.effects.filter((effect) => effect.method === 'put').length;
      expect(before).toBe(1);
      await s.prisma.channelAutoPostAttachMarker.update({
        where,
        data: { updatedAt: new Date(Date.now() - 360_000) },
      });
      if (recovery === 'access_lost') s.denyBot(s.bots[0]!.id);
      else if (recovery === 'held')
        jest.spyOn((s.moderation as any).legacyHolds, 'isMessageHeld').mockResolvedValue(true);
      await (s.moderation as any).channelAutoPostLegacyRecovery.runIfDue();
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(
        before + (recovery === 'recover' ? 1 : 0),
      );
      expect(s.effects.filter((effect) => effect.method !== 'put')).toEqual([]);
      expect((await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where })).status).toBe(
        recovery === 'recover' ? 'SUCCEEDED' : 'IN_PROGRESS',
      );
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    'forged',
    'http',
    'method',
    'send_attempted',
    'member_attempted',
    'lost_lease',
    'replacement_evidence',
    'commit_failed',
    'existing_lease',
    'late_attempt',
  ] as const)('refuses an unsafe initial channel route handoff: %s', async (failure) => {
    const s = await fixture(1);
    s.setBotPermissions(s.bots[0]!.id, [
      'read_all_messages',
      'write',
      'edit_message',
      'delete_message',
    ]);
    const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
    await s.pause();
    const messageId = `unsafe-route-${randomUUID()}`;
    const where = { chatId_messageId: { chatId: chatId!, messageId } };
    const id = await s.ingest({
      chatId: chatId!,
      messageId,
      text: 'Channel post',
      senderless: true,
    });
    const read = s.max.getCurrentChatMemberAccess.bind(s.max);
    const local = new MaxApiInternalRateLimitError('Fixture route refusal', 250);
    let failureError: unknown = local;
    if (failure === 'forged')
      failureError = Object.assign(new Error('Fixture route refusal'), {
        code: local.code,
        preDispatch: true,
        name: local.name,
      });
    if (failure === 'http')
      Object.assign(local, { response: { status: 429 }, config: { method: 'get' } });
    if (failure === 'method') Object.assign(local, { config: { method: 'post' } });
    if (failure === 'send_attempted') markMaxMessageSendAttempted(local);
    if (failure === 'member_attempted') markMaxMemberMutationAttempted(local);
    jest.spyOn(s.max, 'getCurrentChatMemberAccess').mockImplementation(async (chat, options) => {
      if (options?.sourceTag === MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST) throw failureError;
      return read(chat, options);
    });
    const store = (s.moderation as any).replacementAttachMarkerStore;
    const handoff = store.deferChannelRouteBeforeDispatch.bind(store);
    jest
      .spyOn(store, 'deferChannelRouteBeforeDispatch')
      .mockImplementation(async (params: unknown, error: unknown) => {
        if (failure === 'commit_failed') throw new Error('Fixture durable handoff unavailable');
        if (failure === 'late_attempt') markMaxMessageSendAttempted(local);
        if (failure === 'lost_lease' || failure === 'replacement_evidence') {
          await s.prisma.channelAutoPostAttachMarker.update({
            where,
            data:
              failure === 'lost_lease'
                ? { lockToken: 'other-worker' }
                : { replacementSendStartedAt: new Date() },
          });
        }
        return handoff(params, error);
      });
    if (failure === 'existing_lease') {
      await s.prisma.channelAutoPostAttachMarker.create({
        data: {
          chatId: chatId!,
          messageId,
          source: 'webhook',
          botId: s.bots[0]!.id,
          status: 'IN_PROGRESS',
          deliveryMode: 'edit_message',
          lockToken: 'existing-owner',
          lockedAt: new Date(),
        },
      });
    }
    await s.ingress.preparePersistedWebhookEvent(id);
    await expect(s.moderation.processWebhookEvent(id)).rejects.toThrow();
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { kind: 'EXECUTION', webhookEventId: id },
    });
    expect(claim.businessStartedAt).not.toBeNull();
    expect(claim.completedAt).toBeNull();
    expect(claim.commandResult).toBeNull();
    expect(s.effects).toEqual([]);
    const marker = await s.prisma.channelAutoPostAttachMarker.findUnique({ where });
    if (['forged', 'http', 'method', 'send_attempted', 'member_attempted'].includes(failure))
      expect(marker).toBeNull();
    else {
      expect(marker?.status).toBe('IN_PROGRESS');
      if (failure === 'existing_lease') expect(marker?.lockToken).toBe('existing-owner');
      if (failure === 'lost_lease') expect(marker?.lockToken).toBe('other-worker');
      if (failure === 'replacement_evidence')
        expect(marker?.replacementSendStartedAt).not.toBeNull();
    }
  });

  it.each(['recover', 'access_lost', 'held'] as const)(
    'commits a rejected channel edit handoff and advances the same channel, recovery=%s',
    async (recovery) => {
      const s = await fixture(2);
      for (const bot of s.bots)
        s.setBotPermissions(bot.id, [
          'read_all_messages',
          'write',
          'edit_message',
          'delete_message',
        ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      const verify = s.links.verifyChatExecutionProof.bind(s.links);
      let refused = 0;
      const rejection = jest
        .spyOn(s.links, 'verifyChatExecutionProof')
        .mockImplementation(async (input) => {
          if (input.purpose === 'edit_message') {
            refused += 1;
            return false;
          }
          return verify(input);
        });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `edit-handoff-${randomUUID()}`;
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Channel post',
        senderless: true,
      });
      await s.drain();
      expect(refused).toBe(1);
      expect(s.effects).toEqual([]);
      expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROCESSED',
      );
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { kind: 'EXECUTION', webhookEventId: id },
        }),
      ).toMatchObject({
        status: 'COMPLETED',
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      const where = { chatId_messageId: { chatId: chatId!, messageId } };
      expect(await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where })).toMatchObject(
        {
          status: 'IN_PROGRESS',
          deliveryMode: 'edit_message',
          lockedAt: null,
          lockToken: null,
          replacementMessageId: null,
          replyMessageId: null,
          replacementSendStartedAt: null,
        },
      );
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `edit-next-${randomUUID()}`,
        text: 'Next post',
        senderless: true,
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      rejection.mockRestore();
      await s.prisma.channelAutoPostAttachMarker.update({
        where,
        data: { updatedAt: new Date(Date.now() - 360_000) },
      });
      if (recovery === 'access_lost') {
        for (const bot of s.bots) s.denyBot(bot.id);
      } else if (recovery === 'held') {
        jest.spyOn((s.moderation as any).legacyHolds, 'isMessageHeld').mockResolvedValue(true);
      }
      await (s.moderation as any).channelAutoPostLegacyRecovery.runIfDue();
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(
        recovery === 'recover' ? 1 : 0,
      );
      expect(s.effects.filter((effect) => effect.method !== 'put')).toEqual([]);
      expect((await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({ where })).status).toBe(
        recovery === 'recover' ? 'SUCCEEDED' : 'IN_PROGRESS',
      );
      expect(handler).toHaveBeenCalledTimes(2);
    },
  );

  it('recovers an independent channel while a durable edit gets a missing-ID response', async () => {
    const s = await fixture(2);
    for (const bot of s.bots)
      s.setBotPermissions(bot.id, ['read_all_messages', 'write', 'edit_message', 'delete_message']);
    const chats = await s.seedCatalog(2, {}, 'CHANNEL');
    const verify = s.links.verifyChatExecutionProof.bind(s.links);
    const rejection = jest
      .spyOn(s.links, 'verifyChatExecutionProof')
      .mockImplementation((input) =>
        input.purpose === 'edit_message' ? Promise.resolve(false) : verify(input),
      );
    const receiptIds: string[] = [];
    for (const [index, chatId] of chats.entries()) {
      receiptIds.push(
        await s.ingest({
          chatId,
          messageId: `isolated-edit-${index}`,
          text: 'Channel post',
          senderless: true,
        }),
      );
    }
    await s.drain();
    rejection.mockRestore();
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    for (const id of receiptIds) await s.moderation.processWebhookEvent(id);
    expect(handler).not.toHaveBeenCalled();
    expect(s.effects).toEqual([]);
    await s.prisma.channelAutoPostAttachMarker.updateMany({
      where: { chatId: { in: chats } },
      data: { updatedAt: new Date(Date.now() - 360_000) },
    });
    const edit = s.max.editMessageInlineKeyboard.bind(s.max);
    const attempts = jest
      .spyOn(s.max, 'editMessageInlineKeyboard')
      .mockImplementation((chatId, ...args) => {
        if (chatId === chats[0]) return Promise.reject(new MaxExactMessageLookupMissingIdError());
        return edit(chatId, ...args);
      });
    const recovery = (
      s.moderation as unknown as {
        channelAutoPostLegacyRecovery: import('../moderation/channel-auto-post-legacy-recovery').ChannelAutoPostLegacyRecovery;
      }
    ).channelAutoPostLegacyRecovery;
    await expect(recovery.runIfDue()).resolves.toMatchObject({
      status: 'deferred',
      stopCurrentTick: false,
      mutationAttempts: 2,
    });
    expect(attempts).toHaveBeenCalledTimes(2);
    expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(1);
    expect(s.effects.filter((effect) => effect.method !== 'put')).toEqual([]);
    for (const [index, chatId] of chats.entries()) {
      const marker = await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId: `isolated-edit-${index}` } },
      });
      expect(marker.status).toBe(index === 0 ? 'IN_PROGRESS' : 'SUCCEEDED');
      expect(marker.deliveryMode).toBe('edit_message');
      expect(marker.replacementSendStartedAt).toBeNull();
      expect(marker.replacementMessageId).toBeNull();
      expect(marker.replyMessageId).toBeNull();
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['forged', 'ambiguous', 'lost_lease', 'replacement_evidence'] as const)(
    'retains the started channel owner without a safe edit handoff: %s',
    async (failure) => {
      const s = await fixture(1);
      s.setBotPermissions(s.bots[0]!.id, [
        'read_all_messages',
        'write',
        'edit_message',
        'delete_message',
      ]);
      const [chatId] = await s.seedCatalog(1, {}, 'CHANNEL');
      await s.pause();
      const messageId = `unsafe-edit-${randomUUID()}`;
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Channel post',
        senderless: true,
      });
      if (failure === 'ambiguous') s.ambiguousNextEdit();
      else
        jest.spyOn(s.max, 'editMessageInlineKeyboard').mockImplementation(async () => {
          if (failure !== 'forged') {
            await s.prisma.channelAutoPostAttachMarker.update({
              where: { chatId_messageId: { chatId: chatId!, messageId } },
              data:
                failure === 'lost_lease'
                  ? { lockToken: 'other-worker' }
                  : { replacementSendStartedAt: new Date() },
            });
          }
          const error = Object.assign(
            new Error('MAX action executor proof changed during quota wait'),
            { code: 'max_action_executor_proof_rejected' },
          );
          throw failure === 'forged'
            ? error
            : markMaxPreDispatchGuardRejected(error, MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE);
        });
      await s.ingress.preparePersistedWebhookEvent(id);
      await expect(s.moderation.processWebhookEvent(id)).rejects.toThrow();
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(claim.businessStartedAt).not.toBeNull();
      expect(claim.completedAt).toBeNull();
      expect(claim.commandResult).toBeNull();
      expect(s.effects.filter((effect) => effect.method === 'put')).toHaveLength(
        failure === 'ambiguous' ? 1 : 0,
      );
      expect(
        (
          await s.prisma.channelAutoPostAttachMarker.findUniqueOrThrow({
            where: { chatId_messageId: { chatId: chatId!, messageId } },
          })
        ).status,
      ).toBe('IN_PROGRESS');
    },
  );
  function source(
    s: MultibotHarness,
    chatId: string,
    messageId: string,
    text = 'Long harmless content that exceeds twenty characters',
  ) {
    const at = Date.now();
    s.messages.set(messageId, {
      sender: { user_id: 'fixture-user', is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: at,
      body: { mid: messageId, text },
    });
    return new Date(at);
  }

  async function waitForUserDelete(s: MultibotHarness, chatId: string, messageId: string) {
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId } },
        include: { reasons: true },
      });
      if (
        intent.status === 'SUCCEEDED' &&
        intent.remoteDeleteSucceededAt &&
        intent.reasons.some(
          (reason) =>
            (reason.metadata as Record<string, unknown> | null)?.moderationDeleteVerified === true,
        )
      ) {
        expect(s.messages.has(messageId)).toBe(false);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Guarded user DELETE did not commit its exact verified receipt');
  }

  async function priorLengthViolations(s: MultibotHarness, chatId: string, count: number) {
    await s.prisma.violation.createMany({
      data: Array.from({ length: count }, () => ({
        chatId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
      })),
    });
  }

  it.each(['peer', 'all-refused'] as const)(
    'keeps legacy DELETE executor rejection bounded and following events live: %s',
    async (outcome) => {
      const s = await fixture(2);
      Object.assign(s.intents, { mode: 'off' });
      // Deliberate compatibility fixture: real ordinary rules now always use durable execution.
      jest.spyOn(s.intents, 'getRolloutForInput').mockReturnValue('off');
      const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
      await priorLengthViolations(s, chatId!, 1);
      const verify = s.links.verifyChatExecutionProof.bind(s.links);
      const rejected = new Set<string>();
      jest.spyOn(s.links, 'verifyChatExecutionProof').mockImplementation(async (input) => {
        if (
          input.purpose === 'delete_message' &&
          (outcome === 'all-refused' || input.botId === s.bots[0]!.id)
        ) {
          rejected.add(input.botId);
          return false;
        }
        return verify(input);
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `legacy-executor-${randomUUID()}`;
      const at = Date.now();
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        botId: s.bots[0]!.id,
        at,
        text: 'Long harmless text must use the final executor guard',
      });
      await s.drain();
      expect(rejected.size).toBe(outcome === 'peer' ? 1 : 2);
      expect(s.failures).toEqual([]);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(
        outcome === 'peer' ? 1 : 0,
      );
      // FLAG: Rollout-off legacy deletion has no durable own-reason sanction receipt,
      // even when a peer confirms DELETE. Neither path may invent a strike or notice.
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROCESSED',
      );
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `legacy-next-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: at + 1,
        text: 'Next event',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(
        outcome === 'peer' ? 1 : 0,
      );
    },
  );

  it('records one strike and warning when the queue worker finishes the own DELETE before its inline caller', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const warnings = jest.spyOn((s.moderation as any).logger, 'warn');
    const messageId = `worker-first-${randomUUID()}`;
    const ensureIntent = s.intents.ensureIntentWithRuleFollowup.bind(s.intents);
    let workerWon = false;
    jest
      .spyOn(s.intents, 'ensureIntentWithRuleFollowup')
      .mockImplementation(async (input, sha, envelope) => {
        const ensured = await ensureIntent(input, sha, envelope);
        const registered = ensured.followupId
          ? await s.prisma.moderationRuleFollowup.findUnique({ where: { id: ensured.followupId } })
          : null;
        if (input.messageId === messageId && registered) {
          await s.intents.sweepDueIntents();
          const until = Date.now() + 5_000;
          while (Date.now() < until) {
            const current = await s.prisma.moderationDeleteIntent.findUnique({
              where: { id: registered!.intentId },
              select: { status: true },
            });
            if (current?.status === 'SUCCEEDED') {
              workerWon = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!workerWon) throw new Error('Expected the real DELETE queue worker to win the race');
        }
        return ensured;
      });
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          botId: bot.id,
          at,
          text: 'Valid long text remains bound to the same source after queue completion',
        }),
      ),
    );
    await s.drain();
    expect(workerWon).toBe(true);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(1);
    expect(
      warnings.mock.calls.filter(
        ([, message]) => message === 'Failed to send message limits warning message',
      ),
    ).toEqual([]);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
  });

  it('observes the exact active sweep worker receipt before recording one strike and warning', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const messageId = `sweep-first-${randomUUID()}`;
    const ensureIntent = s.intents.ensureIntentWithRuleFollowup.bind(s.intents);
    const deleteMessage = s.max.deleteMessage.bind(s.max);
    const attemptIntent = s.intents.attemptIntent.bind(s.intents);
    let sweepStarted = false;
    let inlineSawActiveLease = false;
    jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (...args) => {
      sweepStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return deleteMessage(...args);
    });
    jest.spyOn(s.intents, 'attemptIntent').mockImplementation(async (...args) => {
      const result = await attemptIntent(...args);
      if (result.kind === 'pending' && result.status === 'IN_PROGRESS') inlineSawActiveLease = true;
      return result;
    });
    jest
      .spyOn(s.intents, 'ensureIntentWithRuleFollowup')
      .mockImplementation(async (input, sha, envelope) => {
        const ensured = await ensureIntent(input, sha, envelope);
        if (input.messageId === messageId) {
          expect(ensured.followupId).not.toBeNull();
          await s.intents.sweepDueIntents();
          const until = Date.now() + 5_000;
          while (!sweepStarted && Date.now() < until)
            await new Promise((resolve) => setTimeout(resolve, 5));
          if (!sweepStarted)
            throw new Error('Expected the real SQL sweeper to start the DELETE worker');
        }
        return ensured;
      });
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          botId: bot.id,
          at,
          text: 'Valid long text authorizes only its own completed sweeping worker receipt',
        }),
      ),
    );
    await s.drain();
    expect(inlineSawActiveLease).toBe(true);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it.each(['on', 'canary', 'shadow', 'off'] as const)(
    'keeps an unknown DELETE fenced and the next event live in %s',
    async (mode) => {
      const s = await fixture(4);
      Object.assign(s.intents, { mode });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const [chatId] = await s.seedCatalog(1, { messageLimitsBanEnabled: true });
      await priorLengthViolations(s, chatId!, 3);
      const messageId = `unknown-delete-${randomUUID()}`;
      s.ambiguousNextDelete();
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: 'Long unchanged content cannot borrow an unknown DELETE as sanction proof',
          }),
        ),
      );
      await s.drain();
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        include: { reasons: true },
      });
      expect(intent.status).toBe('AMBIGUOUS');
      expect(intent.deleteDispatchStartedAt).not.toBeNull();
      expect(
        intent.reasons.every(
          (reason) =>
            (reason.metadata as Record<string, unknown> | null)?.moderationDeleteVerified !== true,
        ),
      ).toBe(true);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(3);
      expect(
        await s.prisma.moderationEvent.count({
          where: { chatId, messageId, action: { in: ['WARN', 'MUTE', 'BAN'] } },
        }),
      ).toBe(0);
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
      ).toHaveLength(1);
      expect(
        s.effects.filter(
          (effect) =>
            effect.path.endsWith('/members') ||
            (effect.method === 'post' && effect.path === '/messages'),
        ),
      ).toEqual([]);
      expect(s.failures).toEqual([]);
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      const owner = receipts.find((row) => row.status === 'PROCESSED')!;
      await s.moderation.processWebhookEvent(owner.id);
      expect(handler).toHaveBeenCalledTimes(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `after-unknown-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: at + 1,
        text: 'Next event',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    },
  );

  it.each(['timeout', '503'] as const)(
    'hands a persisted %s source-read retry to the worker without blocking the next event',
    async (failure) => {
      const s = await fixture(4);
      Object.assign(s.intents, { mode: 'canary' });
      const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
      await priorLengthViolations(s, chatId!, 1);
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `guard-retry-${randomUUID()}`;
      let inline = false;
      let originalRetryUntil: Date | undefined;
      let unavailable = true;
      const ensure = s.intents.ensureAndAttempt.bind(s.intents);
      jest.spyOn(s.intents, 'ensureAndAttempt').mockImplementation(async (input, options) => {
        originalRetryUntil = (
          await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
            where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
          })
        ).retryUntilAt;
        inline = true;
        try {
          return await ensure(input, options);
        } finally {
          inline = false;
        }
      });
      const sourceRead = s.max.getExactMessageRow.bind(s.max);
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
        if (inline && unavailable)
          throw Object.assign(
            new Error('Fixture guarded source GET unavailable'),
            failure === 'timeout'
              ? { code: 'ECONNABORTED', config: { method: 'get' } }
              : { response: { status: 503 } },
          );
        return sourceRead(...args);
      });
      const at = Date.now();
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        botId: s.bots[0]!.id,
        at,
        text: 'A long message with a durable retry and its original deadline',
      });
      await s.drain();
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
      });
      expect(intent).toMatchObject({
        status: 'RETRYABLE',
        deleteDispatchStartedAt: null,
        remoteDeleteSucceededAt: null,
        leaseToken: null,
      });
      expect(intent.retryUntilAt).toEqual(originalRetryUntil);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
        'PROCESSED',
      );
      await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `after-guard-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: at + 1,
        text: 'Next event',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      unavailable = false;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, intent.nextAttemptAt.getTime() - Date.now()) + 20),
      );
      // The real sweeper must select this reason outside the base canary.
      expect(await s.intents.sweepDueIntents()).toBeGreaterThan(0);
      await waitForUserDelete(s, chatId!, messageId);
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(
        (await s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.id } }))
          .retryUntilAt,
      ).toEqual(intent.retryUntilAt);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.failures).toEqual([]);
    },
  );

  it('enforces a closed chat outside the base canary through its durable current-policy guard', async () => {
    const s = await fixture(4);
    Object.assign(s.intents, { mode: 'canary' });
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    });
    const messageId = `closed-canary-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({ chatId: chatId!, messageId, botId: bot.id, at, text: 'Closed chat message' }),
      ),
    );
    await s.drain();
    await waitForUserDelete(s, chatId!, messageId);
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
      include: { reasons: true },
    });
    expect(intent.status).toBe('SUCCEEDED');
    expect(intent.reasons.map((reason) => reason.ruleCode)).toContain('MANUAL_GROUP_CLOSE_DELETE');
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it.each([1, 4, 9, 3, 6, 12])(
    'does not strike or sanction a corrected length source across %i bots',
    async (bots) => {
      const s = await fixture(bots);
      const [chatId] = await s.seedCatalog(1, { messageLimitsBanEnabled: true });
      const messageId = `corrected-${randomUUID()}`;
      const original = s.max.deleteMessage.bind(s.max);
      jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (chat, mid, options) => {
        const row = s.messages.get(mid);
        if (row) (row.body as Record<string, unknown>).text = 'fixed';
        return original(chat, mid, options);
      });
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            text: 'Too long at ingress but fixed before the final selected-peer check',
            botId: bot.id,
          }),
        ),
      );
      await s.drain();
      expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.moderationEvent.count({
          where: { chatId, action: { in: ['WARN', 'MUTE', 'BAN'] } },
        }),
      ).toBe(0);
    },
  );

  it.each(['WARN', 'BAN'] as const)(
    'continues a valid %s through a surviving peer after the original executor loses access',
    async (action) => {
      const s = await fixture(9);
      const [chatId] = await s.seedCatalog(1, {
        messageLimitsWarnEnabled: action === 'WARN',
        messageLimitsBanEnabled: action === 'BAN',
        messageLimitsMuteEnabled: false,
      });
      const priorCount = action === 'WARN' ? 1 : 3;
      await priorLengthViolations(s, chatId!, priorCount);
      const originBotId = s.bots[0]!.id;
      let demoted = false;
      const deleteMessage = s.max.deleteMessage.bind(s.max);
      const authorAccess = s.max.getChatMemberAccess.bind(s.max);
      jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (chat, mid, options) => {
        if (!demoted) {
          demoted = true;
          await s.demote(chat, originBotId);
        }
        return deleteMessage(chat, mid, options);
      });
      jest.spyOn(s.max, 'getChatMemberAccess').mockImplementation(async (chat, user, options) => {
        // The demoted token cannot be reused for post-delete author verification either.
        if (demoted && options?.botId === originBotId)
          throw Object.assign(new Error('Demoted origin cannot verify current author'), {
            response: { status: 403, data: { code: 'chat.denied' } },
          });
        return authorAccess(chat, user, options);
      });
      const checks = jest.spyOn(s.sanctionGuard, 'assertAllowed');
      const recordObservation = s.globalPolicy.recordObservation.bind(s.globalPolicy);
      let confirmedBeforeReputation = false;
      const reputation = jest
        .spyOn(s.globalPolicy, 'recordObservation')
        .mockImplementation(async (input) => {
          if (input.reason === 'SANCTION_BAN')
            confirmedBeforeReputation = s.effects.some((effect) =>
              effect.path.endsWith('/members'),
            );
          return recordObservation(input);
        });
      const messageId = `fallback-${action}-${randomUUID()}`;
      const at = Date.now();
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            text: 'Valid long text keeps the same rule authority after the first bot loses access',
            botId: bot.id,
            at,
          }),
        ),
      );
      await s.drain();
      expect(
        await s.prisma.moderationDeleteIntent.findUnique({
          where: { chatId_messageId: { chatId: chatId!, messageId } },
          select: { status: true, lastErrorCode: true, lastError: true },
        }),
      ).toEqual({ status: 'SUCCEEDED', lastErrorCode: null, lastError: null });
      const deletes = s.effects.filter(
        (effect) => effect.method === 'delete' && effect.path === '/messages',
      );
      expect(deletes).toHaveLength(1);
      expect(deletes[0]?.botId).not.toBe(originBotId);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(priorCount + 1);
      expect(await s.prisma.moderationEvent.count({ where: { chatId, messageId, action } })).toBe(
        1,
      );
      const memberActions = s.effects.filter((effect) => effect.path.endsWith('/members'));
      expect(memberActions).toHaveLength(action === 'BAN' ? 1 : 0);
      expect(
        reputation.mock.calls.filter(([input]) => input.reason === 'SANCTION_BAN'),
      ).toHaveLength(action === 'BAN' ? 1 : 0);
      if (action === 'BAN') expect(confirmedBeforeReputation).toBe(true);
      const notices = s.effects.filter(
        (effect) => effect.method === 'post' && effect.path === '/messages',
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.botId).not.toBe(originBotId);
      expect(checks.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(checks.mock.calls.every(([proof]) => proof.botId !== originBotId)).toBe(true);
    },
  );

  it('revokes a legacy word BAN after its own DELETE when the actual legacy sanction setting changes', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, {
      maxMessageLengthEnabled: false,
      stopWordsPolicy: Prisma.DbNull,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBanEnabled: true,
      messageLimitsWarnEnabled: false,
      messageLimitsMuteEnabled: false,
    });
    await s.prisma.violation.createMany({
      data: Array.from({ length: 3 }, () => ({
        chatId: chatId!,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
      })),
    });
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(settings.stopWordsPolicy).toBeNull();
    const banMember = s.max.banMember.bind(s.max);
    let changed = false;
    jest.spyOn(s.max, 'banMember').mockImplementation(async (chat, user, options) => {
      changed = true;
      await s.prisma.chatSettings.update({
        where: { chatId: chat },
        data: { messageLimitsBanEnabled: false },
      });
      return banMember(chat, user, options);
    });
    const reputation = jest.spyOn(s.globalPolicy, 'recordObservation');
    const messageId = `legacy-word-ban-revoked-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'casino',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    expect(changed).toBe(true);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(
      s.effects.filter(
        (effect) =>
          effect.path.endsWith('/members') ||
          (effect.method === 'post' && effect.path === '/messages'),
      ),
    ).toEqual([]);
    expect(reputation.mock.calls.filter(([input]) => input.reason === 'SANCTION_BAN')).toEqual([]);
    expect(
      await s.prisma.spammerObservation.count({ where: { chatId, reason: 'SANCTION_BAN' } }),
    ).toBe(0);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'BAN' } }),
    ).toBe(0);
  });

  it('revokes a warning after policy changes between its handoff and final transport guard', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const sendMessage = s.max.sendMessage.bind(s.max);
    let changed = false;
    jest.spyOn(s.max, 'sendMessage').mockImplementation(async (chat, text, options, dispatch) => {
      if (!changed) {
        changed = true;
        await s.prisma.chatSettings.update({
          where: { chatId: chat },
          data: { messageLimitsWarnEnabled: false },
        });
      }
      return sendMessage(chat, text, options, dispatch);
    });
    const messageId = `warning-revoked-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'Still too long at the exact DELETE boundary',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    expect(changed).toBe(true);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toEqual([]);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(0);
  });

  it('keeps an unknown warning SEND fenced when a surviving peer retries the same durable action', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true });
    await priorLengthViolations(s, chatId!, 1);
    const sendMessage = s.max.sendMessage.bind(s.max);
    let captured: Parameters<typeof s.max.sendMessage> | undefined;
    jest.spyOn(s.max, 'sendMessage').mockImplementation(async (...args) => {
      captured = args;
      return sendMessage(...args);
    });
    s.ambiguousNextSend();
    const messageId = `warning-unknown-${randomUUID()}`;
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId: chatId!,
          messageId,
          text: 'Valid warning whose remote SEND response is lost',
          botId: bot.id,
          at,
        }),
      ),
    );
    await s.drain();
    const notices = s.effects.filter(
      (effect) => effect.method === 'post' && effect.path === '/messages',
    );
    expect(notices).toHaveLength(1);
    if (!captured) throw new Error('Expected guarded warning handoff');
    expect(captured[3]?.ledgerContext?.moderationRuleNotice).toMatchObject({
      version: 1,
      chatId,
      messageId,
      userId: 'fixture-user',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
    });
    const row = await s.prisma.maxActionLedgerEntry.findFirstOrThrow({
      where: { chatId, actionType: 'SEND_MESSAGE', status: 'AMBIGUOUS' },
    });
    const firstBotId = notices[0]!.botId;
    await s.demote(chatId!, firstBotId);
    const survivingBotId = s.bots.find((bot) => bot.id !== firstBotId)!.id;
    const retry: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      chatId: chatId!,
      botId: survivingBotId,
      text: captured[1],
      options: captured[2],
      ledgerContext: captured[3]?.ledgerContext,
      trafficClass: captured[3]?.trafficClass,
      actionHealthLane: captured[3]?.actionHealthLane,
      sourceTag: captured[3]?.sourceTag,
      idempotencyKey: row.jobId,
      attempt: 2,
      createdAt: row.createdAt.toISOString(),
    };
    await expect(s.max.executeActionJob(retry)).rejects.toThrow(/no longer executable|ambiguous/iu);
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(await s.prisma.maxActionLedgerEntry.findUnique({ where: { id: row.id } })).toMatchObject(
      {
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      },
    );
  });

  it('terminates an expired legacy mute deletion despite unavailable GET and a future retry deadline', async () => {
    const s = await fixture(2);
    const [chatId] = await s.seedCatalog(1, { maxMessageLengthEnabled: false });
    const sourceMessageAt = new Date(Date.now() - 360_000);
    const retryUntilAt = new Date(Date.now() + 86_400_000);
    const mute = await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_MUTE',
        action: 'MUTE',
        operator: 'ADMIN',
        score: 1,
        createdAt: new Date(sourceMessageAt.getTime() - 1_000),
        metadata: { mutePermanent: true },
      },
    });
    const lookup = jest
      .spyOn(s.max, 'getExactMessageRow')
      .mockRejectedValue(new MaxExactMessageLookupMissingIdError());
    const messageId = `expired-legacy-mute-${randomUUID()}`;
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      retryUntilAt,
      reasonKey: 'MUTE_ACTIVE_DELETE',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: { muteEventId: mute.id } },
    });
    expect(result.kind).toBe('terminal');
    expect(lookup).not.toHaveBeenCalled();
    expect(s.effects).toEqual([]);
    const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { chatId_messageId: { chatId: chatId!, messageId } },
    });
    expect(intent).toMatchObject({
      status: 'FAILED_TERMINAL',
      sourceMessageAt,
      retryUntilAt,
      deleteDispatchStartedAt: null,
      remoteDeleteSucceededAt: null,
    });
    await s.intents.attemptIntent(intent.id);
    expect(lookup).not.toHaveBeenCalled();
    expect(s.effects).toEqual([]);
    lookup.mockRestore();
    const nextMessageId = `fresh-after-expired-mute-${randomUUID()}`;
    const nextId = await s.ingest({ chatId: chatId!, messageId: nextMessageId, text: 'Next' });
    await s.drain();
    await waitForUserDelete(s, chatId!, nextMessageId);
    expect((await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status).toBe(
      'PROCESSED',
    );
    expect(s.failures).toEqual([]);
  });

  it('persists exact reason ownership: a rejected stopword cannot inherit a valid length DELETE', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1);
    const messageId = `mixed-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const future = new Date(Date.now() + 60_000);
    const stale = await s.intents.ensureIntent({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      executeAt: future,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'stopwords:stale',
      ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
      event: {
        userId: 'fixture-user',
        eventType: 'MESSAGE',
        metadata: {
          stopWordsPolicyVersion: 1,
          stopWordsSourceSha256: 'removed-source',
          stopWordsRuleId: 'removed-rule',
          stopWordsRevision: 0,
        },
      },
    });
    if (!stale.intentId) throw new Error('Expected durable mixed-reason intent');
    await s.intents.ensureIntent({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      executeAt: future,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'length:current',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE' },
    });
    await s.prisma.moderationDeleteIntent.update({
      where: { id: stale.intentId },
      data: { executeAt: new Date(0), nextAttemptAt: new Date(0) },
    });
    const result = await s.intents.attemptIntent(stale.intentId);
    expect(result).toMatchObject({ kind: 'confirmed', verifiedReasonKeys: ['length:current'] });
    const reasons = await s.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: stale.intentId },
      orderBy: { reasonKey: 'asc' },
    });
    expect(reasons.find((r) => r.reasonKey === 'length:current')?.metadata).toMatchObject({
      moderationDeleteVerified: true,
    });
    expect(reasons.find((r) => r.reasonKey === 'stopwords:stale')?.metadata).not.toMatchObject({
      moderationDeleteVerified: true,
    });
    expect(
      await s.prisma.moderationEvent.findMany({
        where: { chatId, action: 'DELETE_MESSAGE' },
        select: { ruleCode: true },
      }),
    ).toEqual([{ ruleCode: 'MESSAGE_TOO_LONG_DELETE' }]);
  });

  it('revokes a durable frequency deletion after policy change without altering counters', async () => {
    const s = await fixture(12);
    const [chatId] = await s.seedCatalog(1, { antiSpamEnabled: true });
    const messageId = `burst-${randomUUID()}`;
    const at = source(s, chatId!, messageId, 'plain message');
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const binding = bindMessageLimitEvidence(settings, at.getTime(), 'MESSAGE_RATE_LIMIT');
    await s.prisma.chatSettings.update({ where: { chatId }, data: { antiSpamEnabled: false } });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'burst',
      ruleCode: 'MESSAGE_RATE_LIMIT_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: binding },
    });
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
    expect(await s.redis.exists(`message:anti-spam-burst:v2:${chatId}:fixture-user:5:6`)).toBe(0);
  });

  it('stores no active-mute receipt when its expiry elapses before a valid length DELETE dispatch', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const muteExpiresAt = new Date(Date.now() + 2_000);
    const mute = await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_MUTE',
        action: 'MUTE',
        operator: 'ADMIN',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
        metadata: { muteExpiresAt: muteExpiresAt.toISOString(), mutePermanent: false },
      },
    });
    const messageId = `mute-expiry-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const future = new Date(Date.now() + 60_000);
    const base = {
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first' as const,
      executeAt: future,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
    };
    const queued = await s.intents.ensureIntent({
      ...base,
      reasonKey: 'mute:expires',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: { muteEventId: mute.id } },
    });
    if (!queued.intentId) throw new Error('Expected durable expiring mixed-reason intent');
    await s.intents.ensureIntent({
      ...base,
      reasonKey: 'length:survives',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE' },
    });
    const authorizeState = s.stateGuard.authorize.bind(s.stateGuard);
    let heldStatePermit = false;
    jest.spyOn(s.stateGuard, 'authorize').mockImplementation(async (params) => {
      const permit = await authorizeState(params);
      if (typeof permit === 'object') {
        heldStatePermit = true;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, permit.deadlineAtMs - Date.now() + 5)),
        );
      }
      return permit;
    });
    await s.prisma.moderationDeleteIntent.update({
      where: { id: queued.intentId },
      data: { executeAt: new Date(0), nextAttemptAt: new Date(0) },
    });
    expect(await s.intents.attemptIntent(queued.intentId)).toMatchObject({
      kind: 'confirmed',
      verifiedReasonKeys: ['length:survives'],
    });
    expect(heldStatePermit).toBe(true);
    const reasons = await s.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: queued.intentId },
    });
    expect(
      reasons.find((reason) => reason.reasonKey === 'length:survives')?.metadata,
    ).toMatchObject({ moderationDeleteVerified: true });
    expect(
      reasons.find((reason) => reason.reasonKey === 'mute:expires')?.metadata,
    ).not.toMatchObject({ moderationDeleteVerified: true });
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId, ruleCode: 'MUTE_ACTIVE_DELETE' },
      }),
    ).toBe(0);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
    ).toHaveLength(1);
  });

  it('keeps positive and absent own-reason probes bounded by unique indexes with more than 10,000 retained intents', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const prefix = `guard-history-${randomUUID()}`;
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intents
        (id, chat_id, message_id, subject_user_id, source_message_at, status,
          execute_at, next_attempt_at, retry_until_at, completed_at, created_at, updated_at)
      SELECT ${prefix} || '-' || i, ${chatId}, 'history-' || i, 'fixture-user',
        CURRENT_TIMESTAMP - INTERVAL '30 days', 'SUCCEEDED'::"ModerationDeleteIntentStatus",
        CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP - INTERVAL '30 days',
        CURRENT_TIMESTAMP - INTERVAL '30 days' + INTERVAL '5 minutes',
        CURRENT_TIMESTAMP - INTERVAL '30 days' + INTERVAL '1 minute',
        CURRENT_TIMESTAMP - INTERVAL '30 days', CURRENT_TIMESTAMP - INTERVAL '30 days'
      FROM generate_series(1, 12001) AS i
    `);
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intent_reasons
        (id, intent_id, reason_key, user_id, rule_code, metadata)
      SELECT ${prefix} || '-reason-' || i, ${prefix} || '-' || i,
        'length:past', 'fixture-user', 'MESSAGE_TOO_LONG_DELETE',
        '{"moderationDeleteVerified":true}'::jsonb
      FROM generate_series(1, 12001) AS i
    `);
    // A retained intent can contain several independent reasons. Populate its full
    // bounded reason set so the planner cannot pass by filtering a one-row intent index.
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_delete_intent_reasons
        (id, intent_id, reason_key, user_id, rule_code, metadata)
      SELECT ${prefix} || '-extra-reason-' || i, ${`${prefix}-12001`},
        'other:' || i, 'fixture-user', 'MESSAGE_TOO_LONG_DELETE',
        '{"moderationDeleteVerified":true}'::jsonb
      FROM generate_series(1, 63) AS i
    `);
    await s.prisma.$executeRaw`ANALYZE moderation_delete_intents`;
    await s.prisma.$executeRaw`ANALYZE moderation_delete_intent_reasons`;
    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const assertBounded = (plans: { 'QUERY PLAN': { Plan: PlanNode }[] }[], index: string) => {
      expect(JSON.stringify(plans)).toContain(index);
      const walk = (node: PlanNode): void => {
        if (node['Relation Name']) {
          expect(node['Node Type']).not.toBe('Seq Scan');
          expect(
            Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0),
          ).toBeLessThanOrEqual(1);
        }
        for (const child of node.Plans ?? []) walk(child);
      };
      walk(plans[0]!['QUERY PLAN'][0]!.Plan);
    };
    for (const messageId of ['history-12001', 'absent-message']) {
      const plans = await s.prisma.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, status, subject_user_id, source_message_at FROM moderation_delete_intents
        WHERE chat_id = ${chatId} AND message_id = ${messageId}
      `);
      assertBounded(plans, 'moderation_delete_intents_chat_message_key');
    }
    for (const reasonKey of ['length:past', 'absent-reason']) {
      const plans = await s.prisma.$queryRaw<{ 'QUERY PLAN': { Plan: PlanNode }[] }[]>(Prisma.sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT rule_code, user_id, metadata FROM moderation_delete_intent_reasons
        WHERE intent_id = ${`${prefix}-12001`} AND reason_key = ${reasonKey}
      `);
      assertBounded(plans, 'moderation_delete_intent_reasons_intent_reason_key');
    }
    expect(s.effects).toEqual([]);
  });

  it.each([
    'authority-rejected',
    'source-unavailable',
    'membership-unavailable',
    'source-timeout',
    'author-rate-limit',
    'author-local-limit',
    'source-local-limit',
  ] as const)(
    'completes one canonical handler and its mirrors for initial subscription %s',
    async (reason) => {
      const s = await fixture();
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: { requiredSubscriptionEnabled: true, requiredSubscriptionChannelIds: [targetId!] },
      });
      // The initial observation says missing; the real final guard refreshes membership
      // through the local MAX fixture and sees that the participant has now joined.
      const membership = jest
        .spyOn(s.membership, 'getMembershipResolution')
        .mockResolvedValueOnce({ membership: false, fresh: true });
      if (reason === 'membership-unavailable')
        membership.mockResolvedValue({ membership: null, fresh: false });
      if (reason === 'author-rate-limit')
        jest.spyOn(s.max, 'getChatMemberAccess').mockRejectedValueOnce(
          Object.assign(new Error('Initial author GET rate limited'), {
            response: { status: 429 },
            config: { method: 'get' },
          }),
        );
      if (reason === 'author-local-limit')
        jest
          .spyOn(s.max, 'getChatMemberAccess')
          .mockRejectedValueOnce(
            new MaxApiInternalRateLimitError('Initial author local limiter', 250),
          );
      if (reason === 'source-local-limit')
        jest
          .spyOn(s.max, 'getExactMessageRow')
          .mockRejectedValueOnce(
            new MaxApiInternalRateLimitError('Initial source local limiter', 250),
          );
      if (reason === 'source-timeout')
        jest.spyOn(s.max, 'getExactMessageRow').mockRejectedValueOnce(
          Object.assign(new Error('Initial source GET timeout'), {
            code: 'ECONNABORTED',
            config: { method: 'get' },
          }),
        );
      if (reason === 'source-unavailable') {
        jest.spyOn(s.max, 'getExactMessageRow').mockRejectedValueOnce(
          Object.assign(new Error('Fixture source unavailable'), {
            response: { status: 404, data: {} },
          }),
        );
      }
      const authorize = jest.spyOn(s.subscriptionGuard, 'authorize');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const activeMute = jest.spyOn(s.moderation as any, 'handleActiveMuteMessage');
      const messageId = `subscription-rejected-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: 'Subscription changed',
          }),
        ),
      );
      await s.drain();
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ initialQualification: true }),
      );
      if (reason === 'authority-rejected') {
        expect(membership).toHaveBeenCalledWith(
          targetId,
          'fixture-user',
          'moderation_required_subscription',
          { forceRefresh: true, allowStaleOnError: false },
        );
      }
      expect(handler).toHaveBeenCalledTimes(1);
      expect(activeMute).not.toHaveBeenCalled();
      expect(s.failures).toEqual([]);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId, ruleCode: 'REQUIRED_SUBSCRIPTION' },
        }),
      ).toBe(0);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(0);
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        enforced: true,
        businessStartedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        leaseToken: null,
        leaseExpiresAt: null,
      });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.effects).toEqual([]);
      membership.mockResolvedValue({ membership: true, fresh: true });
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `following-initial-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: Date.now(),
        text: 'Next event after unavailable initial evidence',
      });
      await s.drain();
      expect(
        (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
      ).toBe('PROCESSED');
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.effects).toEqual([]);
    },
  );

  it.each(['membership-restored', 'policy-disabled'] as const)(
    'finishes canonical delivery when subscription %s after the notice handoff',
    async (change) => {
      const s = await fixture();
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: [targetId!],
          requiredSubscriptionWarnEnabled: false,
          requiredSubscriptionMuteEnabled: false,
          requiredSubscriptionBanEnabled: false,
          deleteBotMessagesEnabled: false,
        },
      });
      let noticeDelivered = false;
      jest.spyOn(s.membership, 'getMembershipResolution').mockImplementation(async () => ({
        membership: change === 'membership-restored' && noticeDelivered,
        fresh: true,
      }));
      const getMembers = s.max.getChatMembersAccess.bind(s.max);
      jest.spyOn(s.max, 'getChatMembersAccess').mockImplementation(async (...args) => {
        const members = await getMembers(...args);
        // The transport guard reads target members independently of the lookup service.
        if (args[0] === targetId && !(change === 'membership-restored' && noticeDelivered)) {
          members.delete('fixture-user');
        }
        return members;
      });
      const sendMessage = s.max.sendMessage.bind(s.max);
      jest.spyOn(s.max, 'sendMessage').mockImplementation(async (...args) => {
        const result = await sendMessage(...args);
        // Change current authority only after the real local MAX transport finishes.
        // The coordinator must durably hand off its notice before the delete guard runs.
        if (!noticeDelivered && args[0] === chatId) {
          noticeDelivered = true;
          if (change === 'policy-disabled') {
            await s.prisma.chatSettings.update({
              where: { chatId: chatId! },
              data: { requiredSubscriptionEnabled: false },
            });
            await s.cache.invalidate(chatId!);
          }
        }
        return result;
      });
      const messageId = `subscription-after-notice-${randomUUID()}`;
      const snapshot = async () => ({
        events: await s.prisma.moderationEvent.findMany({
          where: { chatId, messageId },
          orderBy: { id: 'asc' },
        }),
        claims: await s.prisma.moderationViolationMessageClaim.findMany({
          where: { chatId, messageId, ruleCode: 'REQUIRED_SUBSCRIPTION' },
          orderBy: { id: 'asc' },
        }),
        violations: await s.prisma.violation.findMany({
          where: { chatId },
          orderBy: { id: 'asc' },
        }),
        actions: await s.prisma.maxActionLedgerEntry.findMany({
          where: { chatId },
          orderBy: { id: 'asc' },
        }),
      });
      let beforeRejection: Awaited<ReturnType<typeof snapshot>> | undefined;
      const rejected: unknown[] = [];
      const authorize = s.subscriptionGuard.authorize.bind(s.subscriptionGuard);
      jest.spyOn(s.subscriptionGuard, 'authorize').mockImplementation(async (params) => {
        if (noticeDelivered && params.messageId === messageId) {
          beforeRejection = await snapshot();
        }
        try {
          return await authorize(params);
        } catch (error) {
          rejected.push(error);
          throw error;
        }
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const activeMute = jest.spyOn(s.moderation as any, 'handleActiveMuteMessage');
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId: chatId!,
            messageId,
            botId: bot.id,
            at,
            text: 'Subscription authority changes after its notice',
          }),
        ),
      );
      await s.drain();
      expect(noticeDelivered).toBe(true);
      expect(rejected).toEqual([expect.any(RequiredSubscriptionExecutionRejectedError)]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(activeMute).not.toHaveBeenCalled();
      expect(s.failures).toEqual([]);
      expect(s.effects).toEqual([expect.objectContaining({ method: 'post', path: '/messages' })]);
      expect(beforeRejection?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleCode: 'REQUIRED_SUBSCRIPTION_NOTICE_PLAN' }),
        ]),
      );
      expect(beforeRejection?.claims).toHaveLength(1);
      expect(beforeRejection?.violations).toHaveLength(1);
      expect(await snapshot()).toEqual(beforeRejection);
      // Handling this feature also keeps duplicate authorization revoked for this source.
      expect(
        await s.prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId, ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED' },
        }),
      ).toBe(1);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId, messageId } })).toBe(0);
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.map((row) => row.status).sort()).toEqual([
        'DUPLICATE',
        'DUPLICATE',
        'DUPLICATE',
        'PROCESSED',
      ]);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        enforced: true,
        businessStartedAt: expect.any(Date),
        completedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        leaseToken: null,
        leaseExpiresAt: null,
      });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(await snapshot()).toEqual(beforeRejection);
      expect(s.effects).toHaveLength(1);
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `subscription-following-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: at + 1,
        text: 'A later independent event in the same chat can progress',
      });
      await s.drain();
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } }),
      ).toMatchObject({
        status: 'PROCESSED',
      });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.effects).toHaveLength(1);
    },
  );

  it.each(
    ['still-missing', 'membership-restored', 'policy-disabled', 'queue-unavailable'].flatMap(
      (outcome) =>
        [
          'membership',
          'source404',
          'final-membership',
          'author429',
          'author-local-limit',
          'source-local-limit',
        ].map((failure) => [outcome, failure]),
    ),
  )(
    'hands off unavailable post-notice evidence durably and resumes only DELETE when %s %s',
    async (outcome, failure) => {
      const s = await fixture();
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: [targetId!],
          requiredSubscriptionWarnEnabled: false,
          requiredSubscriptionMuteEnabled: false,
          requiredSubscriptionBanEnabled: false,
          deleteBotMessagesEnabled: false,
        },
      });
      let noticeDelivered = false;
      let unavailable = true;
      let membership = false;
      jest.spyOn(s.membership, 'getMembershipResolution').mockImplementation(async () => {
        const committed =
          failure === 'final-membership' &&
          (await s.prisma.moderationDeleteIntent.findUnique({
            where: { chatId_messageId: { chatId: chatId!, messageId } },
            select: { id: true },
          }));
        return (failure === 'membership' || committed) && noticeDelivered && unavailable
          ? { membership: null, fresh: false }
          : { membership, fresh: true };
      });
      const getMembers = s.max.getChatMembersAccess.bind(s.max);
      jest.spyOn(s.max, 'getChatMembersAccess').mockImplementation(async (...args) => {
        const members = await getMembers(...args);
        if (args[0] === targetId && !membership) members.delete('fixture-user');
        return members;
      });
      const sendMessage = s.max.sendMessage.bind(s.max);
      jest.spyOn(s.max, 'sendMessage').mockImplementation(async (...args) => {
        const result = await sendMessage(...args);
        if (args[0] === chatId) noticeDelivered = true;
        return result;
      });
      const getAuthor = s.max.getChatMemberAccess.bind(s.max);
      jest.spyOn(s.max, 'getChatMemberAccess').mockImplementation(async (...args) => {
        if (failure === 'author-local-limit' && noticeDelivered && unavailable)
          throw new MaxApiInternalRateLimitError('Post-notice author local limiter', 250);
        if (failure === 'author429' && noticeDelivered && unavailable)
          throw Object.assign(new Error('Post-notice author GET rate limited'), {
            response: { status: 429 },
            config: { method: 'get' },
          });
        return getAuthor(...args);
      });
      const getSource = s.max.getExactMessageRow.bind(s.max);
      jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
        if (failure === 'source-local-limit' && noticeDelivered && unavailable)
          throw new MaxApiInternalRateLimitError('Post-notice source local limiter', 250);
        if (failure === 'source404' && noticeDelivered && unavailable)
          throw Object.assign(new Error('Fixture post-notice source unavailable'), {
            response: { status: 404, data: {} },
          });
        return getSource(...args);
      });
      // FLAG: Hold the real DELETE queue, not webhook execution. Its exact durable
      // obligation must outlive the handler and must not block the next same-chat event.
      await s.deleteQueue.pause();
      const unavailableQueue =
        outcome === 'queue-unavailable'
          ? jest
              .spyOn(s.deleteQueue, 'add')
              .mockRejectedValue(new Error('Fixture queue unavailable'))
          : undefined;
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `subscription-membership-unavailable-${randomUUID()}`;
      const at = Date.now();
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({ chatId: chatId!, messageId, botId: bot.id, at, text: 'Subscription fixture' }),
        ),
      );
      const waitForReceipts = async (receiptIds: string[]) => {
        const until = Date.now() + 10_000;
        while (Date.now() < until) {
          await s.pumpOnce();
          const pending = await s.prisma.webhookEvent.count({
            where: { id: { in: receiptIds }, status: { notIn: ['PROCESSED', 'DUPLICATE'] } },
          });
          if (pending === 0) return;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Subscription handoff blocked canonical receipt settlement');
      };
      await waitForReceipts(ids);
      expect(noticeDelivered).toBe(true);
      expect(s.failures).toEqual([]);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.effects).toEqual([expect.objectContaining({ method: 'post', path: '/messages' })]);
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        include: { reasons: true },
      });
      expect(intent).toMatchObject({
        status: 'PENDING',
        attemptCount: 0,
        deleteDispatchStartedAt: null,
        remoteDeleteSucceededAt: null,
        reasons: [expect.objectContaining({ ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE' })],
      });
      expect(intent.retryUntilAt.getTime()).toBe(at + 300_000);
      if (
        ['final-membership', 'author-local-limit', 'source-local-limit'].includes(failure!) &&
        outcome === 'still-missing'
      ) {
        // FLAG: A worker read outage retains SQL retry authority without reopening the webhook.
        if (failure === 'final-membership')
          await expect(s.intents.attemptIntent(intent.id)).rejects.toThrow();
        else
          await expect(s.intents.attemptIntent(intent.id)).resolves.toMatchObject({
            confirmed: false,
            kind: 'pending',
            status: 'RETRYABLE',
          });
        const deferred = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        expect(deferred).toMatchObject({
          status: 'RETRYABLE',
          attemptCount: 1,
          deleteDispatchStartedAt: null,
          remoteDeleteSucceededAt: null,
          leaseToken: null,
        });
        expect(deferred.retryUntilAt).toEqual(intent.retryUntilAt);
        expect(deferred.nextAttemptAt).not.toBeNull();
        expect(s.effects).toHaveLength(1);
      }
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
      });
      expect(claim).toMatchObject({
        status: 'COMPLETED',
        leaseToken: null,
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      for (const id of ids) await s.moderation.processWebhookEvent(id);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.effects).toHaveLength(1);

      unavailable = false;
      membership = true;
      const nextId = await s.ingest({
        chatId: chatId!,
        messageId: `subscription-following-handoff-${randomUUID()}`,
        botId: s.bots[0]!.id,
        at: at + 1,
        text: 'Next event while the first DELETE remains queued',
      });
      await waitForReceipts([nextId]);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(s.effects).toHaveLength(1);
      const shouldDelete = outcome === 'still-missing' || outcome === 'queue-unavailable';
      if (shouldDelete) membership = false;
      if (outcome === 'policy-disabled') {
        membership = false;
        await s.prisma.chatSettings.update({
          where: { chatId: chatId! },
          data: { requiredSubscriptionEnabled: false },
        });
      }
      if (
        ['final-membership', 'author-local-limit', 'source-local-limit'].includes(failure!) &&
        outcome === 'still-missing'
      ) {
        const retry = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: intent.id },
        });
        const delay = Math.max(0, retry.nextAttemptAt!.getTime() - Date.now()) + 20;
        expect(delay).toBeLessThan(10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await s.intents.sweepDueIntents();
      }
      await s.deleteQueue.resume();
      if (unavailableQueue) {
        unavailableQueue.mockRestore();
        await s.intents.sweepDueIntents();
      }
      await s.drain();
      const settled = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      expect(settled.status).toBe(shouldDelete ? 'SUCCEEDED' : 'FAILED_TERMINAL');
      expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(
        shouldDelete ? 1 : 0,
      );
      expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(s.failures).toEqual([]);
    },
  );

  it.each(
    (
      [
        'source',
        'membership',
        'author-rate-limit',
        'author-local-limit',
        'source-local-limit',
      ] as const
    ).flatMap((boundary) =>
      (['missing', 'joined', 'disabled', 'expired'] as const).map((outcome) => ({
        boundary,
        outcome,
      })),
    ),
  )(
    'defers a subscription $boundary outage to durable guarded actions: $outcome',
    async ({ boundary, outcome }) => {
      const s = await fixture();
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: {
          requiredSubscriptionEnabled: true,
          requiredSubscriptionChannelIds: [targetId!],
          requiredSubscriptionWarnEnabled: false,
          requiredSubscriptionMuteEnabled: false,
          requiredSubscriptionBanEnabled: false,
          deleteBotMessagesEnabled: false,
        },
      });
      let missing = true;
      let sourceReads = 0;
      let unavailable = true;
      const timeout =
        boundary === 'author-local-limit' || boundary === 'source-local-limit'
          ? new MaxApiInternalRateLimitError('Fixture local read limiter', 250)
          : Object.assign(new Error('Fixture read unavailable'), {
              ...(boundary === 'author-rate-limit'
                ? { response: { status: 429 } }
                : { code: 'ECONNABORTED' }),
              config: {
                method: 'get',
                url: boundary === 'author-rate-limit' ? `/chats/${chatId}/members` : '/messages',
              },
            });
      const getAuthor = s.max.getChatMemberAccess.bind(s.max);
      jest.spyOn(s.max, 'getChatMemberAccess').mockImplementation(async (...args) => {
        if (
          (boundary === 'author-rate-limit' || boundary === 'author-local-limit') &&
          args[0] === chatId &&
          sourceReads >= 1 &&
          unavailable
        )
          throw timeout;
        return getAuthor(...args);
      });
      jest
        .spyOn(s.membership, 'getMembershipResolution')
        .mockImplementation(async () =>
          boundary === 'membership' && unavailable && sourceReads >= 2
            ? { membership: null, fresh: false }
            : { membership: !missing, fresh: true },
        );
      const getMembers = s.max.getChatMembersAccess.bind(s.max);
      jest.spyOn(s.max, 'getChatMembersAccess').mockImplementation(async (...args) => {
        if (boundary === 'membership' && unavailable && sourceReads >= 2 && args[0] === targetId)
          throw timeout;
        const members = await getMembers(...args);
        if (args[0] === targetId && missing) members.delete('fixture-user');
        return members;
      });
      const actionQueue = new Queue<MaxActionJob>(`subscription-timeout-${randomUUID()}`, {
        connection: s.redis as unknown as ConnectionOptions,
      });
      try {
        await actionQueue.waitUntilReady();
        Object.assign(s.max, { dispatchEnabled: true, actionQueue });
        await s.deleteQueue.pause();
        const getSource = s.max.getExactMessageRow.bind(s.max);

        jest.spyOn(s.max, 'getExactMessageRow').mockImplementation(async (...args) => {
          sourceReads += 1;
          if (
            (boundary === 'source' || boundary === 'source-local-limit') &&
            sourceReads >= 2 &&
            unavailable
          )
            throw timeout;
          return getSource(...args);
        });
        const handler = jest.spyOn(s.moderation, 'handleUpdate');
        const at = Date.now();
        const messageId = `source-timeout-${randomUUID()}`;
        const ids = await Promise.all(
          s.bots.map((bot) =>
            s.ingest({
              chatId: chatId!,
              messageId,
              botId: bot.id,
              at,
              text: 'Subscription timeout fixture',
            }),
          ),
        );
        const waitReceipts = async (receiptIds: string[]) => {
          const until = Date.now() + 10000;
          while (Date.now() < until) {
            await s.pumpOnce();
            if (
              (await s.prisma.webhookEvent.count({
                where: { id: { in: receiptIds }, status: { notIn: ['PROCESSED', 'DUPLICATE'] } },
              })) === 0
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error('Deferred source read blocked the next webhook');
        };
        await waitReceipts(ids);
        expect(s.failures).toEqual([]);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(s.effects).toEqual([]);
        const [queued] = await actionQueue.getJobs(['waiting']);
        expect(queued).toBeDefined();
        expect(queued!.data.ledgerContext?.requiredSubscriptionNotice).toMatchObject({
          sourceAtMs: at,
          deadlineAtMs: at + 300000,
        });
        const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: chatId!, messageId } },
        });
        expect(intent).toMatchObject({
          status: 'PENDING',
          attemptCount: 0,
          deleteDispatchStartedAt: null,
          remoteDeleteSucceededAt: null,
        });
        expect(intent.retryUntilAt.getTime()).toBe(at + 300000);
        // FLAG: The independent executor must refuse POST while source or membership is unknown.
        await expect((s.max as any).executeImmediateActionJob(queued!.data)).rejects.toBe(timeout);
        expect(s.effects).toEqual([]);
        for (const id of ids) await s.moderation.processWebhookEvent(id);
        expect(handler).toHaveBeenCalledTimes(1);
        unavailable = false;
        missing = false;
        const nextId = await s.ingest({
          chatId: chatId!,
          messageId: `after-timeout-${randomUUID()}`,
          botId: s.bots[0]!.id,
          at: at + 1,
          text: 'Next same-chat event',
        });
        await waitReceipts([nextId]);
        expect(handler).toHaveBeenCalledTimes(2);
        if (outcome !== 'joined') missing = true;
        if (outcome === 'disabled')
          await s.prisma.chatSettings.update({
            where: { chatId: chatId! },
            data: { requiredSubscriptionEnabled: false },
          });
        const clock =
          outcome === 'expired' ? jest.spyOn(Date, 'now').mockReturnValue(at + 300001) : null;
        try {
          const execution = (s.max as any).executeImmediateActionJob(queued!.data);
          if (outcome === 'missing') await execution;
          else await expect(execution).rejects.toThrow();
        } finally {
          clock?.mockRestore();
        }
        expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(
          outcome === 'missing' ? 1 : 0,
        );
        expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(0);
        expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        await actionQueue.obliterate({ force: true });
        await actionQueue.close();
      }
    },
  );

  it.each([404, 503])(
    'preserves persisted subscription evidence after a later source GET %s',
    async (status) => {
      const s = await fixture(1);
      const [chatId, targetId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: { requiredSubscriptionEnabled: true, requiredSubscriptionChannelIds: [targetId!] },
      });
      jest
        .spyOn(s.membership, 'getMembershipResolution')
        .mockResolvedValue({ membership: false, fresh: true });
      const getSource = s.max.getExactMessageRow.bind(s.max);
      const sourceError = Object.assign(new Error('Fixture later source unavailable'), {
        response: { status, data: {} },
      });
      jest
        .spyOn(s.max, 'getExactMessageRow')
        .mockImplementationOnce(getSource)
        .mockRejectedValue(sourceError);
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `subscription-later-unavailable-${randomUUID()}`;
      const id = await s.ingest({
        chatId: chatId!,
        messageId,
        botId: s.bots[0]!.id,
        at: Date.now(),
        text: 'Later source unavailable',
      });
      if (status === 404) await s.drain();
      else await expect(s.drain()).rejects.toBe(sourceError);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.failures).toHaveLength(status === 404 ? 0 : 1);
      expect(s.effects).toEqual([]);
      expect(
        await s.prisma.violation.count({ where: { chatId, ruleCode: 'REQUIRED_SUBSCRIPTION' } }),
      ).toBe(1);
      const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
      expect(receipt.status).toBe(status === 404 ? 'PROCESSED' : 'FAILED');
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: id },
      });
      expect(claim.businessStartedAt).not.toBeNull();
      if (status === 404) {
        // FLAG: A proven notice refusal completes this source without fabricating any
        // remote effect or erasing feature evidence. It must not replay the handler.
        expect(claim.status).toBe('COMPLETED');
        expect(claim.completedAt).not.toBeNull();
        expect(claim.commandResult).toEqual(
          expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        );
        await s.moderation.processWebhookEvent(id);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(s.effects).toEqual([]);
        const nextId = await s.ingest({
          chatId: chatId!,
          messageId: `subscription-following-refusal-${randomUUID()}`,
          botId: s.bots[0]!.id,
          at: Date.now(),
          text: 'Following event can progress after the notice refusal',
        });
        await s.drain();
        expect(
          (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } })).status,
        ).toBe('PROCESSED');
        expect(handler).toHaveBeenCalledTimes(2);
      } else {
        expect(claim.status).not.toBe('COMPLETED');
        expect(claim.completedAt).toBeNull();
        expect(claim.commandResult).not.toEqual(
          expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        );
      }
    },
  );

  it('requires fresh missing membership for a queued subscription deletion', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1, {
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['target-fixture'],
    });
    const messageId = `subscription-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'subscription',
      ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
      event: {
        userId: 'fixture-user',
        eventType: 'MESSAGE',
        metadata: {
          requiredSubscriptionGuardVersion: 1,
          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
            settings,
            'REQUIRED_SUBSCRIPTION',
          ),
          requiredSubscriptionSourceAtMs: at.getTime(),
          requiredSubscriptionDeadlineAtMs: at.getTime() + 300_000,
        },
      },
    });
    // The real membership service reads the fixture HTTP member list: this participant joined.
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
  });

  it('revokes a queued active-mute deletion after a durable manual release', async () => {
    const s = await fixture();
    const [chatId] = await s.seedCatalog(1);
    const mute = await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_MUTE',
        action: 'MUTE',
        operator: 'ADMIN',
        score: 1,
        createdAt: new Date(Date.now() - 1_000),
        metadata: { mutePermanent: true },
      },
    });
    const messageId = `unmuted-${randomUUID()}`;
    const at = source(s, chatId!, messageId);
    await s.prisma.moderationEvent.create({
      data: {
        chatId: chatId!,
        userId: 'fixture-user',
        eventType: 'MEMBER_ACTION',
        ruleCode: 'MANUAL_UNMUTE',
        action: 'NONE',
        operator: 'ADMIN',
        score: 1,
      },
    });
    const result = await s.intents.ensureAndAttempt({
      chatId: chatId!,
      messageId,
      subjectUserId: 'fixture-user',
      sourceMessageAt: at,
      originBotId: s.bots[0]!.id,
      routingPolicy: 'origin_first',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      reasonKey: 'mute',
      ruleCode: 'MUTE_ACTIVE_DELETE',
      event: { userId: 'fixture-user', eventType: 'MESSAGE', metadata: { muteEventId: mute.id } },
    });
    expect(result.kind).toBe('terminal');
    expect(s.effects.filter((e) => e.method === 'delete')).toEqual([]);
  });
});
