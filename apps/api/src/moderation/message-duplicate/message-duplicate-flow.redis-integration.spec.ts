import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { MaxUpdate } from '@maxim/contracts';
import type { ChatSettings } from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';
import type { DuplicateModerationActionRequest } from '../duplicate-moderation.actions';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { PhotoDuplicateAnalysisService } from '../photo-duplicate/photo-duplicate-analysis.service';
import { PhotoDuplicateHistoryStore } from '../photo-duplicate/photo-duplicate-history.store';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintService,
} from '../photo-duplicate/photo-fingerprint';
import { RedisCounterService } from '../redis-counter.service';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicateMediaService } from './message-duplicate-media.service';
import { MessageDuplicateProcessor } from './message-duplicate.processor';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import { MessageDuplicateService } from './message-duplicate.service';
import { duplicateSettings } from './message-duplicate-test-fixtures';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(redisUrl);
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

async function createFlow(overrides: Partial<ChatSettings> = {}) {
  const suffix = randomUUID();
  const chatId = `-${randomBytes(6).readUIntBE(0, 6)}`;
  const config = new ConfigService({ REDIS_URL: redisUrl });
  const inspector = new Redis(redisUrl);
  const redis = new RedisCounterService(config);
  const photoStore = new PhotoDuplicateHistoryStore(config);
  const ordering = new MessageDuplicateOrderingStore(config);
  const queue = new Queue<MessageDuplicateJob>(`test-message-duplicate-${suffix}`, {
    connection: { url: redisUrl },
  });
  const keys = new Set<string>();
  const replace = redis.replaceRevisionedSetMembershipsBeforeDeadline.bind(redis);
  jest.spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline').mockImplementation((input) => {
    keys.add(input.stateKey);
    input.membershipKeys.forEach((key) => keys.add(key));
    return replace(input);
  });
  const set = redis.setStringWithTtl.bind(redis);
  jest.spyOn(redis, 'setStringWithTtl').mockImplementation((key, value, ttl) => {
    keys.add(key);
    return set(key, value, ttl);
  });
  const setAbsent = redis.setStringIfAbsentWithTtl.bind(redis);
  jest.spyOn(redis, 'setStringIfAbsentWithTtl').mockImplementation((key, value, ttl) => {
    keys.add(key);
    return setAbsent(key, value, ttl);
  });
  for (const part of [
    'pending',
    'expiry',
    'members',
    'sequence',
    'completed',
    'lock',
    'action-eligibility',
  ]) {
    keys.add(`message-duplicate:ordering:v1:${shortHash(chatId)}:${part}`);
  }
  const settings = {
    ...duplicateSettings(overrides),
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[], rules: null },
  };
  const start = Date.now() - 10000;
  const policyValue = {
    mode: 'full',
    revision: 1,
    effectiveAtMs: start - 604800000,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  const policy = { resolve: jest.fn(async () => policyValue) };
  const photoPolicy = { resolveEffectivePolicy: jest.fn(async () => ({ enforce: false })) };
  const rows = new Map<string, MaxUpdate>();
  const remote = new Map<string, Record<string, unknown>>();
  const images = new Map<string, Buffer>();
  const deleted: string[] = [];
  const sanctions: Array<{ messageId: string; action: string }> = [];
  const records = new Map<
    string,
    { input: EnsureModerationDeleteIntentInput; at: Date; deletedAt: Date | null }
  >();
  const intents = {
    ensureIntentWithMessageActionClaim: jest.fn(
      async ({ intent }: { intent: EnsureModerationDeleteIntentInput }) => {
        const id = `intent:${intent.messageId}`;
        if (!records.has(id)) records.set(id, { input: intent, at: new Date(), deletedAt: null });
        return { claim: 'claimed', intent: { intentId: id, rollout: 'execute' } };
      },
    ),
  };
  const max = {
    getChatMemberAccess: jest.fn(async (_chatId: string, userId: string) => ({
      userId,
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(
      async (_chatId: string, messageId: string) => remote.get(messageId) ?? null,
    ),
    deleteMessage: jest.fn(async (_chatId: string, messageId: string) => {
      remote.delete(messageId);
      deleted.push(messageId);
      records.get(`intent:${messageId}`)!.deletedAt = new Date();
      return { success: true };
    }),
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const update = rows.get(where.id);
        return update ? { status: 'PROCESSED', botId: 'bot', normalizedPayload: update } : null;
      }),
    },
    moderationEvent: { findFirst: jest.fn(async () => null) },
    moderationDeleteIntentReason: {
      findMany: jest.fn(async ({ where }: { where: { intentId: string } }) => {
        const record = records.get(where.intentId);
        return record
          ? [
              {
                ruleCode: record.input.ruleCode,
                reasonKey: record.input.reasonKey,
                metadata: record.input.event?.metadata,
              },
            ]
          : [];
      }),
    },
    moderationDeleteIntent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const record = records.get(where.id);
        return record
          ? {
              chatId,
              messageId: record.input.messageId,
              subjectUserId: record.input.subjectUserId,
              remoteDeleteSucceededAt: record.deletedAt,
              reasons: [{ metadata: record.input.event?.metadata, createdAt: record.at }],
            }
          : null;
      }),
    },
  };
  const bots = {
    isKnownBotUserId: (userId: string) => userId === '999',
    getDefaultBotId: () => 'bot',
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const governor = { decide: jest.fn(async () => ({ action: 'allow' })) };
  const history = new MessageDuplicateHistoryService(redis);
  const guard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    photoPolicy as never,
    policy as never,
    history,
    config,
  );
  const enforcement = new MessageDuplicateEnforcementService(
    intents as never,
    policy as never,
    photoPolicy as never,
    guard,
  );
  const downloads = jest.fn(async (url: string) => {
    const bytes = images.get(url);
    if (!bytes) throw new Error('Synthetic photo source unavailable');
    return { bytes, format: url.endsWith('.webp') ? 'webp' : 'png' };
  });
  const photos = new PhotoDuplicateAnalysisService(
    { download: downloads } as never,
    new PhotoFingerprintService(),
    photoStore,
  );
  const media = new MessageDuplicateMediaService(
    prisma as never,
    redis,
    photos,
    policy as never,
    history,
    enforcement,
    bots as never,
    governor as never,
    config,
    photoPolicy as never,
    max as never,
  );
  const execute = jest.fn(async (request: DuplicateModerationActionRequest) => {
    const id = `intent:${request.messageId}`;
    if (!records.get(id)?.deletedAt) {
      if (!(await request.authorizeDelete())) return;
      const allowed = await guard.assertIntentStillActionable({
        intentId: id,
        chatId,
        messageId: request.messageId,
        subjectUserId: request.userId,
        botId: 'bot',
      });
      if (allowed !== 'allowed') return;
      await max.deleteMessage(chatId, request.messageId);
    }
    if (
      request.outcome.kind === 'decision' &&
      request.authorizeSanction &&
      (await request.authorizeSanction())
    ) {
      await request.beforeSanctionMutation?.();
      sanctions.push({ messageId: request.messageId, action: request.outcome.decision.action });
    }
  });
  const processor = new MessageDuplicateProcessor(
    {
      processMessageDuplicateJob: (
        job: MessageDuplicateJob,
        lease: Parameters<MessageDuplicateMediaService['process']>[1],
      ) => media.process(job, lease, execute),
    } as never,
    ordering,
  );
  const service = new MessageDuplicateService(
    policy as never,
    history,
    enforcement,
    new MessageDuplicateEnqueueService(queue, ordering),
  );
  const png = await sharp(
    Buffer.from(Array.from({ length: 32 * 24 * 3 }, (_, index) => (index * 17) % 256)),
    { raw: { width: 32, height: 24, channels: 3 } },
  )
    .png()
    .toBuffer();
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  const different = await sharp(png).negate().png().toBuffer();
  let next = 0;
  const prepare = (
    options: {
      id?: string;
      text?: string;
      photo?: 'png' | 'webp' | 'different';
      missingUrl?: boolean;
      userId?: number;
      time?: number;
      editedFrom?: number;
    } = {},
  ) => {
    const id = options.id ?? `message-${++next}`;
    const time = options.time ?? start + next * 100;
    const photoId = `${suffix}:${id}`;
    const url = `https://i.oneme.ru/${photoId}.${options.photo === 'webp' ? 'webp' : 'png'}`;
    const attachments = options.photo
      ? [{ type: 'image', payload: { photo_id: photoId, ...(options.missingUrl ? {} : { url }) } }]
      : [];
    const raw = {
      update_type: options.editedFrom === undefined ? 'message_created' : 'message_edited',
      timestamp: time,
      message: {
        sender: { user_id: options.userId ?? 123, name: 'Test' },
        recipient: { chat_id: Number(chatId), chat_type: 'chat' },
        timestamp: options.editedFrom ?? time,
        body: { mid: id, text: options.text ?? '', attachments },
      },
    };
    const update = new WebhookParser().parse(raw);
    const receipt = `${suffix}:${id}:${time}`;
    rows.set(receipt, update);
    remote.set(id, {
      ...raw.message,
      body: {
        ...raw.message.body,
        attachments: options.photo ? [{ type: 'image', payload: { photo_id: photoId, url } }] : [],
      },
    });
    if (options.photo) {
      images.set(
        url,
        options.photo === 'different' ? different : options.photo === 'webp' ? webp : png,
      );
      keys.add(
        `photo-duplicate:history:v2:fingerprint-cache:${shortHash(PHOTO_FINGERPRINT_ALGORITHM_VERSION)}:${shortHash(photoId)}`,
      );
    }
    return { update, receipt, id, time };
  };
  const ingest = async (item: ReturnType<typeof prepare>) => {
    await service.observe({
      update: item.update,
      webhookEventId: item.receipt,
      eventTimestampMs: item.time,
      settings,
      botId: 'bot',
      actionEligible: true,
      track: true,
      executeFullAction: execute,
    });
    return (await queue.getJobs(['delayed'])).find(
      (job) => job.data.webhookEventId === item.receipt,
    );
  };
  return {
    prepare,
    ingest,
    processor,
    settings,
    deleted,
    sanctions,
    downloads,
    intents,
    records,
    max,
    inspector,
    keys,
    policyValue,
    immunity,
    governor,
    history,
    async close() {
      await queue.obliterate();
      await queue.close();
      if (keys.size) await inspector.del(...keys);
      await ordering.onModuleDestroy();
      await photoStore.onModuleDestroy();
      await redis.onModuleDestroy();
      await inspector.quit();
    },
  };
}

(localRedis ? describe : describe.skip)(
  'message duplicate flow with real Redis, ordering and image fingerprints',
  () => {
    let flow: Awaited<ReturnType<typeof createFlow>>;
    afterEach(async () => {
      await flow?.close();
    });

    it('deletes the second photo-only message, even with a new ID and lossless encoding', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      expect(flow.downloads).not.toHaveBeenCalled();
      const second = flow.prepare({ photo: 'webp' });
      const job = (await flow.ingest(second))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      await flow.ingest(second);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    it('deletes the second identical short text without a media job', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'Hello!' });
      const second = flow.prepare({ text: '  HELLO!  ' });
      expect(await flow.ingest(first)).toBeUndefined();
      expect(await flow.ingest(second)).toBeUndefined();
      expect(flow.deleted).toEqual([second.id]);
    });

    it('retains both originals when repeated pictures are interleaved', async () => {
      flow = await createFlow();
      const items = [
        flow.prepare({ photo: 'png' }),
        flow.prepare({ photo: 'different' }),
        flow.prepare({ photo: 'webp' }),
        flow.prepare({ photo: 'different' }),
      ];
      for (const item of items) await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([items[2]!.id, items[3]!.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(4);
    });

    it('preserves different pictures, changed captions, other authors and the original', async () => {
      flow = await createFlow();
      for (const item of [
        flow.prepare({ photo: 'png' }),
        flow.prepare({ photo: 'different' }),
        flow.prepare({ photo: 'png', text: 'Different caption' }),
        flow.prepare({ photo: 'png', userId: 456 }),
      ])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([]);
    });

    it('resumes a photo deletion after URL recovery and a transient intent persistence failure', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png', missingUrl: true });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    it('resumes deletion when its per-message proof cache disappears before retry', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      const proofKeys = [...flow.keys].filter((key) =>
        key.startsWith('message-duplicate:media-hash:'),
      );
      await flow.inspector.del(...proofKeys);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
    });

    it('recovers a cached pending delete under image-analysis pressure without decoding again', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      flow.governor.decide.mockResolvedValue({ action: 'pause' });
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    it.each(['corrupt', 'expired'] as const)(
      'recovers the next matching pair after a %s candidate',
      async (kind) => {
        flow = await createFlow();
        const old = flow.prepare({ photo: 'png' });
        await flow.processor.process((await flow.ingest(old))!);
        const key = [...flow.keys].find((key) => key.startsWith('message-duplicate:candidate:'))!;
        await flow.inspector.set(
          key,
          kind === 'corrupt'
            ? 'x'.repeat(2048)
            : JSON.stringify({
                webhookEventId: old.receipt,
                messageId: old.id,
                eventTimestampMs: old.time - 604800000,
              }),
        );
        const first = flow.prepare({ photo: 'png' });
        const second = flow.prepare({ photo: 'webp' });
        await flow.processor.process((await flow.ingest(first))!);
        await flow.processor.process((await flow.ingest(second))!);
        expect(flow.deleted).toEqual([second.id]);
      },
    );

    it('respects an explicitly allowed repeat and applies WARN/MUTE/BAN only to subsequent duplicates', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 2,
        duplicateMuteMaxCount: 3,
        duplicateBanMaxCount: 4,
      });
      const items = Array.from({ length: 5 }, () => flow.prepare({ photo: 'png' }));
      for (const item of items) {
        const job = (await flow.ingest(item))!;
        await flow.processor.process(job);
        await flow.ingest(item);
        await flow.processor.process(job);
      }
      expect(flow.deleted).toEqual(items.slice(2).map((item) => item.id));
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'MUTE', 'BAN']);
    });

    it('does not turn an edit of one photo message into a second publication', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      const edited = flow.prepare({
        id: first.id,
        photo: 'png',
        time: first.time + 100,
        editedFrom: first.time,
      });
      expect(edited.update.message!.createdAt).toBe(new Date(edited.time).toISOString());
      await flow.processor.process((await flow.ingest(edited))!);
      expect(flow.deleted).toEqual([]);
      const second = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(second))!);
      expect(flow.deleted).toEqual([second.id]);
    });

    it.each(['off', 'admin', 'immunity', 'edited', 'downgrade-during-check'] as const)(
      'checks %s again at final dispatch',
      async (reason) => {
        flow = await createFlow();
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const second = flow.prepare({ photo: 'png' });
        const job = (await flow.ingest(second))!;
        if (reason === 'off') flow.policyValue.mode = 'off';
        if (reason === 'downgrade-during-check')
          flow.max.getChatMemberAccess.mockImplementation(async (_chatId, userId) => {
            flow.policyValue.mode = 'off';
            return { userId, isAdmin: false, isOwner: false };
          });
        if (reason === 'admin')
          flow.max.getChatMemberAccess.mockResolvedValue({
            userId: '123',
            isAdmin: true,
            isOwner: false,
          });
        if (reason === 'immunity') flow.immunity.consumeForMessage.mockResolvedValue('granted');
        if (reason === 'edited')
          flow.prepare({
            id: second.id,
            photo: 'png',
            text: 'Changed after ingestion',
            time: second.time + 1,
            editedFrom: second.time,
          });
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
      },
    );
  },
);
