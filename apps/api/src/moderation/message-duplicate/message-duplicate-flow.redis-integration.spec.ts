import { MaxBotContextService } from '../../max/max-bot-context.service';
import {
  parseMessageDuplicateBinding,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import {
  extractDuplicateMessageContent,
  digestDuplicateContent,
} from './message-duplicate-content';
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
import {
  duplicateRevocationKey,
  MessageDuplicateAuthorizationService,
} from './message-duplicate-authorization.service';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';

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
  const cachePhotos = photoStore.cachePhotoFingerprints.bind(photoStore);
  jest.spyOn(photoStore, 'cachePhotoFingerprints').mockImplementation((entries, ttl) => {
    entries.forEach(({ photoId }) =>
      keys.add(
        `photo-duplicate:history:v2:fingerprint-cache:${shortHash(PHOTO_FINGERPRINT_ALGORITHM_VERSION)}:${shortHash(photoId)}`,
      ),
    );
    return cachePhotos(entries, ttl);
  });
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
    ...duplicateSettings({ duplicatePhotoEnabled: true, ...overrides }),
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
  const rows = new Map<string, MaxUpdate>();
  const remote = new Map<string, Record<string, unknown>>();
  const images = new Map<string, Buffer>();
  const deleted: string[] = [];
  const sanctions: Array<{ messageId: string; action: string }> = [];
  const records = new Map<
    string,
    {
      input: EnsureModerationDeleteIntentInput;
      at: Date;
      deletedAt: Date | null;
      verifiedReceiptMetadata: Record<string, unknown> | null;
    }
  >();
  const durableClaims = new Map<string, { id: string; createdAt: Date; [key: string]: unknown }>();
  const claimedMessages = new Set<string>();
  const intents = {
    claimMessageActionBeforeQualification: jest.fn(async ({ messageId }: { messageId: string }) => {
      const resumed = claimedMessages.has(messageId);
      claimedMessages.add(messageId);
      return resumed ? 'resumed' : 'claimed';
    }),
    releaseUnmaterializedMessageAction: jest.fn(
      async ({
        claim,
        binding,
      }: {
        claim: { messageId: string };
        binding: MessageDuplicateBinding;
      }) => {
        if (records.has(`intent:${claim.messageId}`) || !claimedMessages.delete(claim.messageId))
          return false;
        for (const eventTimestampMs of new Set([
          binding.eventTimestampMs,
          binding.authorization!.eventTimestampMs,
        ])) {
          const key = duplicateRevocationKey(chatId, claim.messageId, eventTimestampMs);
          durableClaims.set(key, { id: key, createdAt: new Date() });
        }
        return true;
      },
    ),
    ensureIntentWithMessageActionClaim: jest.fn(
      async ({ intent }: { intent: EnsureModerationDeleteIntentInput }) => {
        const id = `intent:${intent.messageId}`;
        if (!records.has(id))
          records.set(id, {
            input: intent,
            at: new Date(),
            deletedAt: null,
            verifiedReceiptMetadata: null,
          });
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
      const record = records.get(`intent:${messageId}`)!;
      record.deletedAt = new Date();
      record.verifiedReceiptMetadata = {
        ...(record.input.event?.metadata as Record<string, unknown>),
        moderationDeleteVerified: true,
      };
      return { success: true };
    }),
  };
  const prisma = {
    moderationViolationMessageClaim: {
      createMany: jest.fn(
        async ({ data }: { data: Array<{ dedupeKey: string; [key: string]: unknown }> }) => {
          let count = 0;
          for (const row of data) {
            if (durableClaims.has(row.dedupeKey)) continue;
            durableClaims.set(row.dedupeKey, { ...row, id: row.dedupeKey, createdAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { dedupeKey: string } }) =>
          durableClaims.get(where.dedupeKey) ?? null,
      ),
    },
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
      findUnique: jest.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: { reasons?: { where?: { reasonKey?: string } } };
        }) => {
          const record = records.get(where.id);
          if (!record) return null;
          const reasonKey = select?.reasons?.where?.reasonKey;
          return {
            chatId,
            messageId: record.input.messageId,
            subjectUserId: record.input.subjectUserId,
            remoteDeleteSucceededAt: record.deletedAt,
            reasons:
              reasonKey && reasonKey !== record.input.reasonKey
                ? []
                : [
                    {
                      metadata: record.verifiedReceiptMetadata ?? record.input.event?.metadata,
                      createdAt: record.at,
                    },
                  ],
          };
        },
      ),
    },
  };
  const bots = {
    isKnownBotUserId: (userId: string) => userId === '999',
    getDefaultBotId: () => 'bot',
    resolveExecutableBotId: (botId: string) => (botId === 'bot' ? botId : null),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const governor = { decide: jest.fn(async () => ({ action: 'allow' })) };
  const history = new MessageDuplicateHistoryService(redis);
  const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
  const admission = new MessageDuplicateAdmissionService(prisma as never);
  const guard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    policy as never,
    history,
    config,
    authorization,
  );
  const enforcement = new MessageDuplicateEnforcementService(
    intents as never,
    policy as never,
    guard,
  );
  const downloads = jest.fn(async (url: string) => {
    const bytes = images.get(url);
    if (!bytes) throw new Error('Synthetic photo source unavailable');
    return { bytes, format: new URL(url).pathname.endsWith('.webp') ? 'webp' : 'png' };
  });
  const photos = new PhotoDuplicateAnalysisService(
    { download: downloads } as never,
    new PhotoFingerprintService({ canonicalOnly: true }),
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
    max as never,
    new MaxBotContextService(),
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
    new MessageDuplicateEnqueueService(queue, ordering, admission),
    authorization,
  );
  const png = await sharp(
    Buffer.from(Array.from({ length: 32 * 24 * 3 }, (_, index) => (index * 17) % 256)),
    { raw: { width: 32, height: 24, channels: 3 } },
  )
    .png()
    .toBuffer();
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  const different = await sharp(png).negate().png().toBuffer();
  const variants = await Promise.all(
    [0, 1, 2, 3].map(async (index) => {
      const image = await sharp(png)
        .rotate(index * 90)
        .png()
        .toBuffer();
      return {
        png: image,
        webp: await sharp(image).webp({ lossless: true }).toBuffer(),
        different: await sharp(image).negate().png().toBuffer(),
      };
    }),
  );
  let next = 0;
  const prepare = (
    options: {
      id?: string;
      text?: string;
      markup?: Record<string, unknown>[];
      buttons?: Record<string, unknown>[][];
      photo?: 'png' | 'webp' | 'different';
      photoId?: string;
      photoCount?: number;
      reversePhotos?: boolean;
      changedPhotoIndex?: number;
      missingUrl?: boolean;
      userId?: number;
      time?: number;
      editedFrom?: number;
    } = {},
  ) => {
    const id = options.id ?? `message-${++next}`;
    const time = options.time ?? start + next * 100;
    const photoId = `${suffix}:${options.photoId ?? id}`;
    const url = `https://i.oneme.ru/${suffix}:${id}.${options.photo === 'webp' ? 'webp' : 'png'}`;
    const attachments = options.photo
      ? Array.from({ length: options.photoCount ?? 1 }, (_, index) => ({
          type: 'image',
          payload: {
            photo_id: `${photoId}:${index}`,
            ...(options.missingUrl ? {} : { url: `${url}?item=${index}` }),
          },
        }))
      : [];
    const keyboard = options.buttons
      ? [{ type: 'inline_keyboard', payload: { buttons: options.buttons } }]
      : [];
    const raw = {
      update_type: options.editedFrom === undefined ? 'message_created' : 'message_edited',
      timestamp: time,
      message: {
        sender: { user_id: options.userId ?? 123, name: 'Test' },
        recipient: { chat_id: Number(chatId), chat_type: 'chat' },
        timestamp: options.editedFrom ?? time,
        body: {
          mid: id,
          text: options.text ?? '',
          ...(options.markup ? { markup: options.markup } : {}),
          attachments: [...attachments, ...keyboard],
        },
      },
    };
    const update = new WebhookParser().parse(raw);
    const receipt = `${suffix}:${id}:${time}`;
    rows.set(receipt, update);
    remote.set(id, {
      ...raw.message,
      body: {
        ...raw.message.body,
        attachments: [
          ...(options.photo
            ? Array.from({ length: options.photoCount ?? 1 }, (_, index) => ({
                type: 'image',
                payload: { photo_id: `${photoId}:${index}`, url: `${url}?item=${index}` },
              }))
            : []),
          ...keyboard,
        ],
      },
    });
    if (options.photo) {
      images.set(
        url,
        options.photo === 'different' ? different : options.photo === 'webp' ? webp : png,
      );
      for (let index = 0; index < (options.photoCount ?? 1); index += 1) {
        const variant =
          variants[
            (options.reversePhotos ? (options.photoCount ?? 1) - index - 1 : index) %
              variants.length
          ]!;
        images.set(
          `${url}?item=${index}`,
          variant[options.changedPhotoIndex === index ? 'different' : options.photo!],
        );
      }
    }
    return { update, receipt, id, time };
  };
  const ingest = async (item: ReturnType<typeof prepare>, actionEligible = true) => {
    await service.observeLifecycle(item.update);
    await service.observe({
      update: item.update,
      webhookEventId: item.receipt,
      eventTimestampMs: item.time,
      settings,
      botId: 'bot',
      actionEligible,
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
    service,
    remote,
    redis,
    chatId,
    processor,
    settings,
    deleted,
    sanctions,
    downloads,
    intents,
    claimedMessages,
    records,
    max,
    inspector,
    keys,
    policyValue,
    immunity,
    governor,
    history,
    guard,
    authorization,
    queue,
    ordering,
    async close() {
      await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
      await redis.deleteKeysByPattern(`message-duplicate:ordering:v2:${shortHash(chatId)}:*`);
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
      jest.restoreAllMocks();
      await flow?.close();
    });

    it.each(['MESSAGE', 'TEXT'] as const)(
      'anchors the 24-hour window to the accepted original (%s)',
      async (mode) => {
        flow = await createFlow({ duplicateCompareMode: mode, duplicateWarnWindowSec: 86400 });
        let now = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        const originalTime = now;
        await flow.ingest(flow.prepare({ id: 'original', text: 'offer', time: now }));
        now = originalTime + 21 * 3600000;
        await flow.ingest(flow.prepare({ id: 'morning', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning']);
        now = originalTime + 30 * 3600000;
        await flow.ingest(flow.prepare({ id: 'evening', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning']);
        now = originalTime + 43 * 3600000;
        await flow.ingest(flow.prepare({ id: 'next-morning', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning', 'next-morning']);
        const evidence = parseMessageDuplicateBinding(
          flow.records.get('intent:next-morning')!.input.event!.metadata,
        )!;
        expect(evidence.original!.messageId).toBe('evening');
        expect(evidence.original!.expiresAtMs).toBe(originalTime + 54 * 3600000);
      },
    );

    it('resumes the same sanction stage after deletion without counting the retry', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateMuteEnabled: true });
      await flow.ingest(flow.prepare({ text: 'offer' }));
      const repeat = flow.prepare({ text: 'offer' });
      await flow.ingest(repeat);
      // The production executor deduplicates sanctions; this fixture verifies the immutable stage.
      await flow.ingest(repeat);
      expect(flow.sanctions.map((sanction) => sanction.action)).toEqual(['WARN', 'WARN']);
      expect(flow.deleted).toEqual([repeat.id]);
      const next = flow.prepare({ text: 'offer' });
      await flow.ingest(next);
      expect(flow.sanctions.at(-1)?.action).toBe('MUTE');
    });

    it('does not let protected attempts advance WARN to MUTE or BAN', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
      });
      await flow.ingest(flow.prepare({ text: 'offer' }));
      flow.immunity.consumeForMessage.mockResolvedValue('granted');
      await flow.ingest(flow.prepare({ text: 'offer' }));
      await flow.ingest(flow.prepare({ text: 'offer' }));
      flow.immunity.consumeForMessage.mockResolvedValue('not_granted');
      const repeat = flow.prepare({ text: 'offer' });
      await flow.ingest(repeat);
      expect(flow.sanctions).toEqual([{ messageId: repeat.id, action: 'WARN' }]);
    });

    it('requires a live original even when no removal webhook was delivered', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      flow.remote.delete(first.id);
      await flow.ingest(flow.prepare({ text: 'offer' }));
      expect(flow.deleted).toEqual([]);
    });

    it.each(['text', 'image'] as const)(
      'recovers %s comparisons after structured original absence without a removal webhook',
      async (kind) => {
        flow = await createFlow();
        flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
          const row = flow.remote.get(messageId);
          if (!row) throw { response: { status: 404, data: { code: 'message.not.found' } } };
          return row;
        });
        const remove = jest.spyOn(flow.history, 'remove');
        const prepare = () => flow.prepare(kind === 'image' ? { photo: 'png' } : { text: 'offer' });
        const observe = async (item: ReturnType<typeof prepare>) => {
          const job = await flow.ingest(item);
          if (job) await flow.processor.process(job);
        };
        const original = prepare();
        await observe(original);
        flow.remote.delete(original.id);
        const unverifiedRepeat = prepare();
        await observe(unverifiedRepeat);
        expect(remove).toHaveBeenCalledWith(flow.chatId, original.id);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(flow.records.size).toBe(0);

        const freshOriginal = prepare();
        await observe(freshOriginal);
        const confirmedRepeat = prepare();
        await observe(confirmedRepeat);
        expect(flow.deleted).toEqual([confirmedRepeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${confirmedRepeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original!.messageId).toBe(freshOriginal.id);
        expect(binding.original!.publishedAtMs).toBe(freshOriginal.time);
      },
    );

    it.each(['text', 'image'] as const)(
      'resumes %s sanctions after our confirmed DELETE and a transient lookup failure',
      async (kind) => {
        flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
        let interruptSanction = true;
        flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
          const row = flow.remote.get(messageId);
          if (row) return row;
          if (interruptSanction) {
            interruptSanction = false;
            throw new Error('Temporary post-delete lookup failure');
          }
          throw { response: { status: 404, data: { code: 'message.not.found' } } };
        });
        const prepare = () => flow.prepare(kind === 'image' ? { photo: 'png' } : { text: 'offer' });
        const firstJob = await flow.ingest(prepare());
        if (firstJob) await flow.processor.process(firstJob);
        const repeat = prepare();
        let job: Awaited<ReturnType<typeof flow.ingest>> = undefined;
        if (kind === 'image') {
          job = await flow.ingest(repeat);
          await expect(flow.processor.process(job!)).rejects.toThrow(
            'Temporary post-delete lookup failure',
          );
        } else {
          await expect(flow.ingest(repeat)).rejects.toThrow('Temporary post-delete lookup failure');
        }
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions).toEqual([]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.sanction!.repeatCount).toBe(1);

        if (kind === 'image') await flow.processor.process(job!);
        else await flow.ingest(repeat);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions).toEqual([{ messageId: repeat.id, action: 'WARN' }]);
        expect(
          parseMessageDuplicateBinding(
            flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
          )!.sanction!.repeatCount,
        ).toBe(1);
      },
    );

    it('never deletes the original after a cosmetic edit following a rejected duplicate', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      const second = flow.prepare({ text: 'offer' });
      await flow.ingest(second);
      await flow.ingest(
        flow.prepare({
          id: first.id,
          text: '  offer  ',
          time: second.time + 100,
          editedFrom: first.time,
        }),
      );
      expect(flow.deleted).toEqual([second.id]);
    });

    it('checks materially changed old content against a newer original', async () => {
      flow = await createFlow();
      const old = flow.prepare({ text: 'old unrelated text' });
      await flow.ingest(old);
      const original = flow.prepare({ text: 'offer' });
      await flow.ingest(original);
      await flow.ingest(
        flow.prepare({
          id: old.id,
          text: 'offer',
          time: original.time + 100,
          editedFrom: old.time,
        }),
      );
      expect(flow.deleted).toEqual([old.id]);
    });

    it('does not rejuvenate an old original when whitespace is edited', async () => {
      flow = await createFlow({ duplicateWarnWindowSec: 86400 });
      const now = Date.now();
      const old = flow.prepare({ id: 'old', text: 'offer', time: now - 26 * 3600000 });
      await flow.history.observe({
        chatId: flow.chatId,
        userId: '123',
        messageId: old.id,
        eventTimestampMs: old.time,
        controlRevision: 1,
        settings: flow.settings,
        content: extractDuplicateMessageContent(old.update.raw),
      });
      await flow.ingest(
        flow.prepare({ id: old.id, text: ' offer ', time: now - 1000, editedFrom: old.time }),
      );
      await flow.ingest(flow.prepare({ text: 'offer', time: now }));
      expect(flow.deleted).toEqual([]);
    });

    it('invalidates evidence for an edit even when normal observation is bypassed', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      const edit = flow.prepare({
        id: first.id,
        text: 'different',
        time: first.time + 100,
        editedFrom: first.time,
      });
      await flow.service.observeLifecycle(edit.update);
      await flow.ingest(flow.prepare({ text: 'offer', time: first.time + 200 }));
      expect(flow.deleted).toEqual([]);
    });

    it('fails open on conflicting edits with the same event timestamp', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      await flow.ingest(
        flow.prepare({ id: first.id, text: 'different', time: first.time, editedFrom: first.time }),
      );
      await flow.ingest(flow.prepare({ text: 'offer', time: first.time + 200 }));
      expect(flow.deleted).toEqual([]);
    });

    it('fences pre-release originals and delayed media after a manual reset', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      await flow.redis.resetDuplicateWindow(flow.chatId, '123');
      await flow.ingest(first);
      await flow.ingest(flow.prepare({ text: 'offer', time: Date.now() + 100 }));
      expect(flow.deleted).toEqual([]);
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

    it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
      'keeps changed hidden-link associations and deletes their actual repeat in %s',
      async (preset) => {
        flow = await createFlow({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
          duplicateIgnoreLinksEnabled: false,
          duplicateIgnorePhonesEnabled: false,
        });
        const linked = (
          swapped: boolean,
          text = 'Participants can purchase comfortable iPhone equipment or practical Samsung devices today',
        ) =>
          flow.prepare({
            text,
            markup: ['iPhone', 'Samsung'].map((anchor, index) => ({
              type: 'link',
              from: text.indexOf(anchor),
              length: anchor.length,
              url: `https://example.com/${swapped ? 1 - index : index}`,
            })),
          });
        await flow.ingest(linked(false));
        await flow.ingest(linked(true));
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        const repeat = linked(
          true,
          '  PARTICIPANTS can purchase comfortable iPhone equipment\nor practical Samsung devices today ',
        );
        await flow.ingest(repeat);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps swapped case-sensitive visible URLs and deletes their actual repeat in STANDARD', async () => {
      flow = await createFlow({ duplicateDetectionPreset: 'STANDARD' });
      await flow.ingest(flow.prepare({ text: 'https://example.com/One https://example.com/one' }));
      await flow.ingest(flow.prepare({ text: 'https://example.com/one https://example.com/One' }));
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const repeat = flow.prepare({ text: '  https://example.com/one\nhttps://example.com/One  ' });
      await flow.ingest(repeat);
      expect(flow.deleted).toEqual([repeat.id]);
    });

    it.each(['current', 'original'] as const)(
      'rejects a hidden-link swap in the fresh %s message without an edit webhook',
      async (changed) => {
        flow = await createFlow();
        const text = 'Buy iPhone Buy Samsung';
        const markup = ['iPhone', 'Samsung'].map((anchor, index) => ({
          type: 'link',
          from: text.indexOf(anchor),
          length: anchor.length,
          url: `https://example.com/${index}`,
        }));
        const original = flow.prepare({ text, markup });
        await flow.ingest(original);
        const current = flow.prepare({ text, markup });
        const message = flow.remote.get(changed === 'current' ? current.id : original.id)!;
        flow.remote.set(changed === 'current' ? current.id : original.id, {
          ...message,
          body: {
            ...(message.body as Record<string, unknown>),
            markup: markup.map((item, index) => ({
              ...item,
              url: `https://example.com/${1 - index}`,
            })),
          },
        });
        await flow.ingest(current);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      },
    );

    it.each(['callback', 'link'] as const)(
      'keeps identical photos with different %s buttons and deletes an actual repeat',
      async (type) => {
        flow = await createFlow();
        const prepare = (value: string) =>
          flow.prepare({
            photo: 'png',
            buttons: [
              [
                {
                  type,
                  text: 'Open',
                  ...(type === 'callback' ? { payload: value } : { url: value }),
                },
              ],
            ],
          });
        await flow.processor.process((await flow.ingest(prepare('https://example.com/a')))!);
        await flow.processor.process((await flow.ingest(prepare('https://example.com/b')))!);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        const repeat = prepare('https://example.com/b');
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps distinct images with a reused platform ID and independently verifies a later repeat', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(first))!);
      const different = flow.prepare({ photo: 'different', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(different))!);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const repeat = flow.prepare({ photo: 'different', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
    });

    it.each(['before-add', 'lost-response', 'lost-registration-response'] as const)(
      'preserves photo enforcement after a transient %s failure',
      async (failure) => {
        flow = await createFlow();
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const repeat = flow.prepare({ photo: 'webp' });
        if (failure === 'lost-registration-response') {
          const announce = flow.ordering.announce.bind(flow.ordering);
          jest.spyOn(flow.ordering, 'announce').mockImplementationOnce(async (...args) => {
            await announce(...args);
            return { kind: 'unavailable' };
          });
        } else {
          const add = flow.queue.add.bind(flow.queue);
          jest.spyOn(flow.queue, 'add').mockImplementationOnce(async (...args) => {
            if (failure === 'lost-response') await add(...args);
            throw new Error('temporary queue add failure');
          });
        }
        await expect(flow.ingest(repeat)).rejects.toThrow();
        const job = (await flow.ingest(repeat))!;
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.downloads).toHaveBeenCalledTimes(2);
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps a concurrent restrictive replay after a lost queue acknowledgement', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'webp' });
      const add = flow.queue.add.bind(flow.queue);
      jest.spyOn(flow.queue, 'add').mockImplementationOnce(async (...args) => {
        const job = await add(...args);
        await flow.ordering.announce(
          {
            chatId: job.data.chatId,
            jobId: job.data.idempotencyKey,
            sourceCreatedAt: job.data.sourceCreatedAt,
          },
          false,
        );
        throw new Error('lost queue acknowledgement');
      });
      await expect(flow.ingest(repeat)).rejects.toThrow('lost queue acknowledgement');
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
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

    it('matches exact pictures independently of different captions and links', async () => {
      flow = await createFlow({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnoreLinksEnabled: true,
      });
      const first = flow.prepare({ photo: 'different', text: 'https://first.example/item' });
      const second = flow.prepare({ photo: 'png', text: 'https://second.example/item' });
      const repeat = flow.prepare({
        photo: 'webp',
        text: 'https://first.example/item https://second.example/item',
      });
      await flow.processor.process((await flow.ingest(first))!);
      await flow.processor.process((await flow.ingest(second))!);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      const job = (await flow.ingest(repeat))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
    });

    it('preserves different pictures, other authors and the original while ignoring captions', async () => {
      flow = await createFlow();
      for (const item of [
        flow.prepare({ photo: 'png' }),
        flow.prepare({ photo: 'different' }),
        flow.prepare({ photo: 'png', text: 'Different caption' }),
        flow.prepare({ photo: 'png', userId: 456 }),
      ])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual(['message-3']);
    });

    it('keeps WARN/MUTE escalation after changing only the original photo caption', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
      });
      const original = flow.prepare({ photo: 'png', text: 'Original caption' });
      await flow.processor.process((await flow.ingest(original))!);
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
      const edited = flow.prepare({
        id: original.id,
        photo: 'png',
        text: 'Changed caption with https://example.org/new',
        time: first.time + 100,
        editedFrom: original.time,
      });
      await flow.processor.process((await flow.ingest(edited))!);
      const next = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([first.id, next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'MUTE']);
    });

    it('keeps the spent photo allowance after changing only the original caption', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 });
      const original = flow.prepare({ photo: 'png', text: 'Original caption' });
      await flow.processor.process((await flow.ingest(original))!);
      const allowed = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(allowed))!);
      expect(flow.deleted).toEqual([]);
      const edited = flow.prepare({
        id: original.id,
        photo: 'png',
        text: 'Changed caption',
        time: allowed.time + 100,
        editedFrom: original.time,
      });
      await flow.processor.process((await flow.ingest(edited))!);
      const next = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
    });

    it('blocks a late ordering denial during MAX checks before reserving a stage', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
      });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const qualify = jest.spyOn(flow.history, 'qualify');
      flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
        if (messageId === repeat.id) {
          await flow.ordering.announce(
            {
              chatId: flow.chatId,
              jobId: job.data.idempotencyKey,
              sourceCreatedAt: job.data.sourceCreatedAt,
              deadlineAtMs: job.data.deadlineAtMs,
            },
            false,
          );
        }
        return flow.remote.get(messageId) ?? null;
      });
      await flow.processor.process(job);
      expect(qualify).not.toHaveBeenCalled();
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
      expect(flow.claimedMessages.has(repeat.id)).toBe(false);
      await flow.processor.process(job);
      expect(flow.intents.claimMessageActionBeforeQualification).toHaveBeenCalledTimes(1);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      const next = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
    });

    it('blocks a denial after qualification and before persisting the delete intent', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
      flow.intents.ensureIntentWithMessageActionClaim.mockImplementation(async (input) => {
        await flow.ordering.announce(
          {
            chatId: flow.chatId,
            jobId: job.data.idempotencyKey,
            sourceCreatedAt: job.data.sourceCreatedAt,
            deadlineAtMs: job.data.deadlineAtMs,
          },
          false,
        );
        return persist(input);
      });
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const binding = parseMessageDuplicateBinding(
        flow.records.get(`intent:${repeat.id}`)!.input.event?.metadata,
      )!;
      expect(await flow.history.qualified(flow.chatId, binding)).toBe(1);
      await expect(
        flow.guard.assertIntentStillActionable({
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        }),
      ).rejects.toThrow('message_duplicate_action_revoked');
    });

    it('keeps a persisted intent revoked independently of background recovery', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
      flow.intents.ensureIntentWithMessageActionClaim.mockImplementationOnce(async (input) => {
        await persist(input);
        throw new Error('Synthetic crash after intent persistence');
      });
      await expect(flow.processor.process(job)).rejects.toThrow('after intent persistence');
      expect(flow.records.has(`intent:${repeat.id}`)).toBe(true);
      await flow.authorization.revoke({
        chatId: flow.chatId,
        messageId: repeat.id,
        senderId: '123',
        eventTimestampMs: repeat.time,
      });
      await flow.ordering.announce(
        {
          chatId: flow.chatId,
          jobId: job.data.idempotencyKey,
          sourceCreatedAt: job.data.sourceCreatedAt,
          deadlineAtMs: job.data.deadlineAtMs,
        },
        true,
      );
      await expect(
        flow.guard.assertIntentStillActionable({
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        }),
      ).rejects.toThrow('message_duplicate_action_revoked');
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it('fails closed when the admitted permit disappears before a worker retry', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const permit = `message-duplicate:ordering:v2:${shortHash(flow.chatId)}:permit:${createHash('sha256').update(job.data.idempotencyKey).digest('hex')}`;
      expect(await flow.inspector.hget(permit, 'eligible')).toBe('1');
      await flow.inspector.del(permit);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      expect(flow.sanctions).toEqual([]);
      expect(await flow.inspector.hget(permit, 'eligible')).toBe('0');
    });

    it.each(['retained-job', 'lost-job'] as const)(
      'does not renew a persisted intent through webhook replay after permit loss (%s)',
      async (state) => {
        flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const repeat = flow.prepare({ photo: 'png' });
        const job = (await flow.ingest(repeat))!;
        const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
        flow.intents.ensureIntentWithMessageActionClaim.mockImplementationOnce(async (input) => {
          await persist(input);
          throw new Error('Synthetic crash after intent persistence');
        });
        await expect(flow.processor.process(job)).rejects.toThrow('after intent persistence');
        const params = {
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        };
        await expect(flow.guard.assertIntentStillActionable(params)).resolves.toBe('allowed');
        const permit = `message-duplicate:ordering:v2:${shortHash(flow.chatId)}:permit:${createHash('sha256').update(job.data.idempotencyKey).digest('hex')}`;
        await flow.inspector.del(permit);
        if (state === 'lost-job') {
          await job.remove();
          jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
        }
        await expect(flow.guard.assertIntentStillActionable(params)).rejects.toThrow(
          'message_duplicate_action_revoked',
        );
        const replay = (await flow.ingest(repeat, true))!;
        await expect(flow.guard.assertIntentStillActionable(params)).rejects.toThrow(
          'message_duplicate_action_revoked',
        );
        await flow.processor.process(replay);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(await flow.inspector.hget(permit, 'eligible')).toBe('0');
      },
    );

    it('keeps an untracked moderation replay denied when tracking resumes', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      await flow.service.observe({
        update: repeat.update,
        webhookEventId: repeat.receipt,
        eventTimestampMs: repeat.time,
        settings: flow.settings,
        botId: 'bot',
        actionEligible: false,
        track: false,
      });
      await flow.ingest(repeat, true);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
    });

    it('resumes a photo deletion after URL recovery and a transient intent persistence failure', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteEnabled: true,
        duplicateMuteMaxCount: 2,
      });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png', missingUrl: true });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      const firstQualification = flow.intents.ensureIntentWithMessageActionClaim.mock.calls[0]![0]
        .intent.event!.metadata as { count: number };
      await flow.processor.process(job);
      const resumedQualification = flow.intents.ensureIntentWithMessageActionClaim.mock.calls[1]![0]
        .intent.event!.metadata as { count: number };
      expect(resumedQualification.count).toBe(firstQualification.count);
      expect(flow.intents.claimMessageActionBeforeQualification).toHaveBeenCalledTimes(2);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.sanctions).toEqual([{ messageId: second.id, action: 'WARN' }]);
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

    it('handles four distinct pictures with text as one logical occurrence', async () => {
      flow = await createFlow({ duplicatePhotoEnabled: false });
      const first = flow.prepare({
        photo: 'png',
        photoCount: 4,
        text: 'Selling a complete aquarium. Contact in private.',
      });
      const repeat = flow.prepare({
        photo: 'webp',
        photoCount: 4,
        reversePhotos: true,
        text: 'Selling a complete aquarium. Contact in private.',
      });
      await flow.processor.process((await flow.ingest(first))!);
      const job = (await flow.ingest(repeat))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(8);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
    });

    it('retains an album if one of its four pictures is different', async () => {
      flow = await createFlow();
      await flow.processor.process(
        (await flow.ingest(flow.prepare({ photo: 'png', photoCount: 4, text: 'same caption' })))!,
      );
      await flow.processor.process(
        (await flow.ingest(
          flow.prepare({ photo: 'png', photoCount: 4, changedPhotoIndex: 2, text: 'same caption' }),
        ))!,
      );
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it('honors an explicitly allowed first repeat for a four-picture post', async () => {
      flow = await createFlow({ duplicateWarnMaxCount: 2 });
      const items = Array.from({ length: 3 }, () =>
        flow.prepare({ photo: 'png', photoCount: 4, text: 'same caption' }),
      );
      for (const item of items) await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([items[2]!.id]);
    });

    it('keeps each author on their own sanction ladder in chat-wide image comparison', async () => {
      flow = await createFlow({
        duplicatePhotoScope: 'CHAT',
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
        duplicateBanMaxCount: 3,
      });
      const items = [
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 456, text: 'Different caption' }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 456 }),
      ];
      for (const item of items) await flow.processor.process((await flow.ingest(item))!);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual([
        'WARN',
        'MUTE',
        'WARN',
        'BAN',
        'MUTE',
      ]);
      expect(flow.deleted).toEqual(items.slice(1).map((item) => item.id));
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
            photo: 'different',
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
