import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  MessageDuplicateMediaService,
  MessageDuplicateMediaDeferredError,
} from './message-duplicate-media.service';
import {
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
} from './message-duplicate-state';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';
import type { MessageDuplicateJob } from './message-duplicate.queue';
import {
  PhotoDownloadHttpError,
  PhotoDownloadSourceRejectedError,
} from '../photo-duplicate/secure-photo-downloader';
import { UnrecoverableError } from 'bullmq';

function setup() {
  const settings = { ...duplicateSettings(), chat: { entityType: 'CHAT', admins: [] } };
  const now = Date.now() - 10000;
  const rows = new Map<string, unknown>();
  const cache = new Map<string, string>();
  const redis = {
    getString: jest.fn(async (key: string) => cache.get(key) ?? null),
    setStringWithTtl: jest.fn(async (key: string, value: string) => {
      cache.set(key, value);
    }),
    setStringIfAbsentWithTtl: jest.fn(async (key: string, value: string) => {
      if (!cache.has(key)) cache.set(key, value);
    }),
  };
  const prisma = {
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id)),
    },
    chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
  };
  const photos = { fingerprintAlbum: jest.fn() };
  const policy = {
    resolve: jest.fn().mockResolvedValue({
      mode: 'delete_only',
      revision: 1,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    }),
  };
  const history = {
    candidateKeys: jest.fn().mockReturnValue(['caption']),
    observe: jest.fn().mockResolvedValue(null),
  };
  const enforcement = { enqueue: jest.fn() };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false), getDefaultBotId: () => 'bot' };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'allow' }) };
  const max = { getExactMessageRow: jest.fn() };
  const metrics = { record: jest.fn() };
  const service = new MessageDuplicateMediaService(
    prisma as never,
    redis as never,
    photos as never,
    policy as never,
    history as never,
    enforcement as never,
    bots as never,
    governor as never,
    new ConfigService(),
    max as never,
    metrics as never,
  );
  const downloads = jest.fn(async (url: string) => ({
    bytes: Buffer.from(url.endsWith('b') ? 'different' : 'same'),
  }));
  Object.defineProperty(service, 'binary', { value: { downloadBinary: downloads } });
  const binaryVerifier = service as unknown as {
    verifyBinary: (bytes: Buffer, kind: string) => Promise<void>;
  };
  const actualVerifyBinary = binaryVerifier.verifyBinary.bind(service);
  const verifyBinary = jest.spyOn(binaryVerifier, 'verifyBinary').mockResolvedValue();
  const lease = {
    assertOwned: jest.fn(),
    resolveActionEligibility: jest.fn().mockResolvedValue(true),
  };
  const job = (
    id: string,
    timestamp: number,
    resource = 'a',
    messageId = id,
  ): MessageDuplicateJob => {
    const update = duplicateUpdate(messageId, now + timestamp, 'caption', [
      {
        type: 'file',
        payload: {
          id: 'same-untrusted-id',
          filename: 'same.pdf',
          size: 4,
          url: `https://fd.oneme.ru/${resource}`,
        },
      },
    ]);
    rows.set(id, {
      status: 'PROCESSED',
      normalizedPayload: update,
      botId: 'bot',
      nextEnqueueAt: null,
    });
    return {
      version: 2,
      webhookEventId: id,
      chatId: '-123',
      messageId,
      eventTimestampMs: now + timestamp,
      sourceCreatedAt: new Date(now + timestamp).toISOString(),
      createdAt: new Date().toISOString(),
      controlRevision: 1,
      policyRevision: settings.duplicatePolicyRevision,
      deadlineAtMs: now + timestamp + 600_000,
      settingsDigest: messageDuplicateSettingsDigest(settings),
      actionEligible: true,
      idempotencyKey: `message-duplicate__${'a'.repeat(64)}`,
    };
  };
  return {
    service,
    settings,
    rows,
    cache,
    history,
    downloads,
    lease,
    job,
    governor,
    enforcement,
    policy,
    photos,
    max,
    verifyBinary,
    actualVerifyBinary,
    metrics,
  };
}

describe('bounded message duplicate media analysis', () => {
  it('expires scheduled media work before downloading or using history', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T14:59Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      const job = s.job('scheduled', 0);
      clock.mockReturnValue(Date.parse('2026-09-29T15:00Z'));
      await s.service.process(job, s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('media.schedule_closed');
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    'resumes all candidates within the media budget (terminal baseline: %s)',
    async (terminal) => {
      const s = setup();
      s.history.candidateKeys.mockImplementation((content) => content.text.split(' '));
      const album = (id: string, timestamp: number, text: string) => {
        const job = s.job(id, timestamp);
        s.rows.set(id, {
          status: 'PROCESSED',
          botId: 'bot',
          normalizedPayload: duplicateUpdate(
            id,
            job.eventTimestampMs,
            text,
            Array.from({ length: 10 }, (_, index) => ({
              type: 'file',
              payload: { url: `https://fd.oneme.ru/${id}-${index}` },
            })),
          ),
        });
        return job;
      };
      for (const [index, id] of ['first', 'second', 'third'].entries())
        await s.service.process(album(id, index * 100, id), s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      if (terminal) s.verifyBinary.mockRejectedValueOnce(new UnrecoverableError('invalid bytes'));
      const repeat = album('repeat', 400, 'first second third');
      await expect(s.service.process(repeat, s.lease)).rejects.toBeInstanceOf(
        MessageDuplicateMediaDeferredError,
      );
      expect(s.downloads.mock.calls.length).toBeLessThanOrEqual(20);
      expect(s.history.observe).not.toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'repeat' }),
      );
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('media.budget_deferred');
      const before = s.downloads.mock.calls.length;
      await s.service.process(repeat, s.lease);
      expect(s.downloads.mock.calls.length - before).toBe(20);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'repeat' }),
      );
      const total = s.downloads.mock.calls.length;
      await s.service.process(repeat, s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(total);
      expect(s.downloads.mock.calls.filter(([url]) => url.includes('/first-0'))).toHaveLength(1);
      if (terminal) expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected_cached');
    },
  );

  it('verifies a shared predecessor only once across candidate keys', async () => {
    const s = setup();
    s.history.candidateKeys.mockReturnValue(['one', 'two', 'three']);
    await s.service.process(s.job('original', 0), s.lease);
    await s.service.process(s.job('repeat', 100), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    expect(s.history.observe).toHaveBeenCalledTimes(2);
  });

  it('classifies unsupported binary contents as terminal, without retrying the same bytes', async () => {
    const s = setup();
    const verify = s.actualVerifyBinary;
    await expect(verify(Buffer.from('unsupported plain text file'), 'file')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(verify(Buffer.from('%PDF-1.7\n'), 'video')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    await expect(verify(Buffer.from('%PDF-1.7\n'), 'file')).resolves.toBeUndefined();
  });

  it('does not let an unsupported first binary poison the following valid pair', async () => {
    const s = setup();
    s.verifyBinary.mockImplementationOnce(s.actualVerifyBinary);
    await s.service.process(s.job('unsupported', 0), s.lease);
    await s.service.process(s.job('valid-first', 100), s.lease);
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'valid-first' }),
    );
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.job('valid-repeat', 200), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    expect(s.enforcement.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          message: expect.objectContaining({ messageId: 'valid-repeat' }),
        }),
      }),
    );
  });

  function photoSetup() {
    const s = setup();
    s.settings.duplicatePhotoEnabled = true;
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    const photoJob = (id: string, timestamp: number, url: string | null = null) => {
      const job = s.job(id, timestamp);
      job.comparison = 'IMAGE';
      job.settingsDigest = exactImageSettingsDigest(s.settings);
      const update = duplicateUpdate(id, job.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: id, ...(url ? { url } : {}) } },
      ]);
      s.rows.set(id, { status: 'PROCESSED', normalizedPayload: update, botId: 'bot' });
      return job;
    };
    const complete = {
      kind: 'complete',
      fingerprint: { images: [{ canonicalHash: 'a'.repeat(64) }] },
    };
    s.photos.fingerprintAlbum.mockResolvedValue(complete);
    return { ...s, photoJob, complete };
  }

  it('charges every album member when an outer hash checkpoint contains only a prefix', async () => {
    const s = photoSetup();
    const job = s.photoJob('partial', 0, 'https://i.oneme.ru/first');
    const update = (
      s.rows.get(job.webhookEventId) as { normalizedPayload: ReturnType<typeof duplicateUpdate> }
    ).normalizedPayload;
    const { extractDuplicateMessageContent } = await import('./message-duplicate-content');
    const one = extractDuplicateMessageContent(update.raw);
    const content = {
      ...one,
      media: [
        one.media[0]!,
        {
          ...one.media[0]!,
          identity: 'second',
          photoId: 'second',
          url: 'https://i.oneme.ru/second',
        },
      ],
    };
    s.photos.fingerprintAlbum.mockResolvedValue({
      kind: 'incomplete',
      reason: 'album_decode_budget_exceeded',
    });
    const boundary = s.service as unknown as {
      hashMedia: (
        content: typeof one,
        source: typeof update,
        ttl: number,
        deadline: number,
        bot: string,
        cached: (string | null)[],
        budget: { remaining: number },
        receiptId: string,
      ) => Promise<unknown>;
    };
    await expect(
      boundary.hashMedia(
        content,
        update,
        3600,
        Date.now() + 30_000,
        'bot',
        ['a'.repeat(64), null],
        { remaining: 20 },
        job.webhookEventId,
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledWith(
      expect.objectContaining({
        receiptId: job.webhookEventId,
        images: [
          expect.objectContaining({ downloadUrl: 'https://i.oneme.ru/first' }),
          expect.objectContaining({ downloadUrl: 'https://i.oneme.ru/second' }),
        ],
      }),
      3600,
      expect.any(Number),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('verifies exact photo copies with different IDs and forwards full action execution', async () => {
    const s = photoSetup();
    const execute = jest.fn();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease, execute);
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease, execute);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(2);
    expect(s.history.observe).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ messageId: 'a', mediaHashes: ['a'.repeat(64)] }),
    );
    expect(s.history.observe).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
    );
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    const request = s.enforcement.enqueue.mock.calls[0]![0];
    expect(request.update.message.messageId).toBe('b');
    await request.executeFullAction({});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('retries enforcement after refreshing a missing URL even when the candidate points to itself', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const next = s.photoJob('b', 100);
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete).mockResolvedValueOnce({
      kind: 'incomplete',
      reason: 'missing_download_url',
    });
    const fresh = duplicateUpdate('b', next.eventTimestampMs, '', [
      { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
    ]);
    s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    s.enforcement.enqueue.mockRejectedValueOnce(new Error('temporary intent store failure'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('intent store failure');
    s.photos.fingerprintAlbum.mockClear();
    await s.service.process(next, s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(2);
    expect(s.photos.fingerprintAlbum).not.toHaveBeenCalled();
  });

  it('re-verifies a retry after its own media hash cache is evicted', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const next = s.job('b', 100);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    s.enforcement.enqueue.mockRejectedValueOnce(new Error('temporary intent store failure'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('intent store failure');
    for (const key of s.cache.keys()) {
      if (key.startsWith('message-duplicate:media-hash:')) s.cache.delete(key);
    }
    await s.service.process(next, s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a newer candidate when an older job arrives late', async () => {
    const s = setup();
    const first = s.job('newer', 1000);
    await s.service.process(first, s.lease);
    const pointerKey = [...s.cache.keys()].find((key) =>
      key.startsWith('message-duplicate:candidate:'),
    )!;
    const pointer = s.cache.get(pointerKey);
    await s.service.process(s.job('older', 0), s.lease);
    expect(s.cache.get(pointerKey)).toBe(pointer);
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it.each(['oversized', 'expired'] as const)(
    'repairs a %s candidate pointer before the next matching pair',
    async (kind) => {
      const s = setup();
      const first = s.job('a', 0);
      await s.service.process(first, s.lease);
      const key = [...s.cache.keys()].find((value) =>
        value.startsWith('message-duplicate:candidate:'),
      )!;
      s.cache.set(
        key,
        kind === 'oversized'
          ? 'x'.repeat(2048)
          : JSON.stringify({
              webhookEventId: 'expired',
              messageId: 'expired',
              eventTimestampMs: first.eventTimestampMs - 604800000,
            }),
      );
      await s.service.process(s.job('b', 100), s.lease);
      expect(s.downloads).not.toHaveBeenCalled();
      await s.service.process(s.job('c', 200), s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(2);
      expect(s.history.observe).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ messageId: 'b' }),
      );
    },
  );

  it.each(['missing', 403, 404, 410, 'forbidden'] as const)(
    'refreshes a %s photo URL without treating its ID as equality proof',
    async (reason) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      const current = s.photoJob(
        'b',
        100,
        reason === 'missing'
          ? null
          : reason === 'forbidden'
            ? 'https://untrusted.example/photo?opaque=secret'
            : 'https://i.oneme.ru/expired',
      );
      s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete);
      if (reason === 'missing')
        s.photos.fingerprintAlbum.mockResolvedValueOnce({
          kind: 'incomplete',
          reason: 'missing_download_url',
        });
      else
        s.photos.fingerprintAlbum.mockRejectedValueOnce(
          reason === 'forbidden'
            ? new PhotoDownloadSourceRejectedError('host')
            : new PhotoDownloadHttpError(reason),
        );
      const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
      ]);
      s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
      s.history.observe.mockResolvedValueOnce(null).mockResolvedValueOnce({
        hit: {},
        binding: { eventTimestampMs: current.eventTimestampMs },
      });
      await s.service.process(current, s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
        '-123',
        'b',
        expect.objectContaining({ botId: 'bot', trafficClass: 'background', bypassCache: true }),
      );
      expect(s.photos.fingerprintAlbum).toHaveBeenLastCalledWith(
        expect.objectContaining({
          images: [{ source: 'direct', photoId: 'b', downloadUrl: 'https://i.oneme.ru/fresh' }],
        }),
        expect.any(Number),
        expect.any(Number),
      );
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
      expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      if (reason === 'forbidden') expect(s.metrics.record).toHaveBeenCalledWith('media.url_host');
    },
  );

  it.each([
    ['malformed_url', 'media.url_malformed'],
    ['protocol', 'media.url_protocol'],
    ['credentials', 'media.url_credentials'],
    ['port', 'media.url_port'],
    ['host', 'media.url_host'],
  ] as const)(
    'records fixed %s diagnostics before one guarded source refresh',
    async (reason, counter) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      const current = s.photoJob('b', 100, 'https://untrusted.example/photo?opaque=secret');
      s.photos.fingerprintAlbum
        .mockResolvedValueOnce(s.complete)
        .mockRejectedValueOnce(new PhotoDownloadSourceRejectedError(reason));
      const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: 'b', url: 'https://i.oneme.ru/fresh' } },
      ]);
      s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
      await s.service.process(current, s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.metrics.record.mock.calls.filter(([value]) => value === counter)).toHaveLength(1);
      expect(s.metrics.record.mock.calls.flat()).not.toEqual(
        expect.arrayContaining([expect.stringContaining('secret')]),
      );
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
    },
  );

  it.each(
    (['missing', 'forbidden'] as const).flatMap((reason) =>
      (['photo', 'author', 'message', 'chat', 'deleted'] as const).map((change) => ({
        reason,
        change,
      })),
    ),
  )('rejects changed $change after a $reason photo source refresh', async ({ reason, change }) => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const current = s.photoJob(
      'b',
      100,
      reason === 'forbidden' ? 'https://untrusted.example/photo' : null,
    );
    s.photos.fingerprintAlbum.mockResolvedValueOnce(s.complete);
    if (reason === 'forbidden')
      s.photos.fingerprintAlbum.mockRejectedValueOnce(new PhotoDownloadSourceRejectedError('host'));
    else
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
    const fresh = duplicateUpdate(
      change === 'message' ? 'other' : 'b',
      current.eventTimestampMs,
      '',
      [
        {
          type: 'image',
          payload: {
            photo_id: change === 'photo' ? 'other' : 'b',
            url: 'https://i.oneme.ru/fresh',
          },
        },
      ],
    );
    const raw = (
      fresh.raw as {
        message: { sender: { user_id: number }; recipient: { chat_id: number } };
      }
    ).message;
    if (change === 'author') raw.sender.user_id = 999;
    if (change === 'chat') raw.recipient.chat_id = -999;
    s.max.getExactMessageRow.mockResolvedValue(change === 'deleted' ? null : raw);
    await expect(s.service.process(current, s.lease)).rejects.toThrow('source changed');
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(2);
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(
      s.metrics.record.mock.calls.filter(([value]) => value === 'media.url_host'),
    ).toHaveLength(reason === 'forbidden' ? 1 : 0);
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('classifies a rejected binary source without treating it as equality evidence', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.downloads.mockRejectedValueOnce(new PhotoDownloadSourceRejectedError('host'));
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.metrics.record).toHaveBeenCalledWith('media.url_host');
    expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected');
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'b' }));
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a still forbidden refreshed photo URL after one exact-message read', async () => {
    const s = photoSetup();
    await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
    const current = s.photoJob('b', 100, 'https://untrusted.example/stale');
    const rejected = new PhotoDownloadSourceRejectedError('host');
    s.photos.fingerprintAlbum
      .mockResolvedValueOnce(s.complete)
      .mockRejectedValueOnce(rejected)
      .mockRejectedValueOnce(rejected);
    const fresh = duplicateUpdate('b', current.eventTimestampMs, '', [
      {
        type: 'image',
        payload: { photo_id: 'b', url: 'https://untrusted.example/still-forbidden' },
      },
    ]);
    s.max.getExactMessageRow.mockResolvedValue((fresh.raw as { message: unknown }).message);
    await expect(s.service.process(current, s.lease)).rejects.toBe(rejected);
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(
      s.metrics.record.mock.calls.filter(([value]) => value === 'media.url_host'),
    ).toHaveLength(2);
    expect(s.photos.fingerprintAlbum).toHaveBeenCalledTimes(3);
    expect(s.photos.fingerprintAlbum).toHaveBeenLastCalledWith(
      expect.objectContaining({
        images: [
          {
            source: 'direct',
            photoId: 'b',
            downloadUrl: 'https://untrusted.example/still-forbidden',
          },
        ],
      }),
      expect.any(Number),
      expect.any(Number),
    );
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a' }));
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });

  it.each([403, 404])(
    'advances past an unverifiable photo baseline when MAX refresh returns %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
      s.max.getExactMessageRow.mockRejectedValueOnce({ response: { status } });

      await s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease);

      expect(s.history.observe).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'b', mediaHashes: ['a'.repeat(64)] }),
      );
      expect(s.metrics.record).toHaveBeenCalledWith('media.baseline_rejected');
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();

      s.history.observe
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ hit: {}, binding: { eventTimestampMs: Date.now() - 1000 } });
      await s.service.process(s.photoJob('c', 200, 'https://i.oneme.ru/c'), s.lease);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenLastCalledWith(
        expect.objectContaining({ messageId: 'c' }),
      );
      expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
      expect(s.enforcement.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            message: expect.objectContaining({ messageId: 'c' }),
          }),
        }),
      );
    },
  );

  it.each([403, 404])(
    'rejects unverified current photo evidence after MAX refresh returns %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0, 'https://i.oneme.ru/a'), s.lease);
      s.photos.fingerprintAlbum
        .mockResolvedValueOnce(s.complete)
        .mockResolvedValueOnce({ kind: 'incomplete', reason: 'missing_download_url' });
      s.max.getExactMessageRow.mockRejectedValueOnce({ response: { status } });

      await expect(s.service.process(s.photoJob('b', 100), s.lease)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(s.history.observe).toHaveBeenCalledTimes(1);
      expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'a' }));
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([401, 429, 500, undefined])(
    'preserves retry of photo baseline refresh failures with status %s',
    async (status) => {
      const s = photoSetup();
      await s.service.process(s.photoJob('a', 0), s.lease);
      s.photos.fingerprintAlbum.mockResolvedValueOnce({
        kind: 'incomplete',
        reason: 'missing_download_url',
      });
      const error = Object.assign(new Error('MAX lookup unavailable'), {
        response: status ? { status } : undefined,
      });
      s.max.getExactMessageRow.mockRejectedValueOnce(error);

      await expect(
        s.service.process(s.photoJob('b', 100, 'https://i.oneme.ru/b'), s.lease),
      ).rejects.toBe(error);
      expect(s.history.observe).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('media.baseline_rejected');
      expect(s.enforcement.enqueue).not.toHaveBeenCalled();
    },
  );

  it('retries a not-yet-processed baseline instead of losing its first occurrence', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.rows.set('a', { status: 'QUEUED' });
    await expect(s.service.process(s.job('b', 100), s.lease)).rejects.toThrow();
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.history.observe).not.toHaveBeenCalled();
  });
  it('does not download first occurrences and proves each candidate independently', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    expect(s.downloads).not.toHaveBeenCalled();
    await s.service.process(s.job('b', 100, 'b'), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    const hashes = s.history.observe.mock.calls.map(
      (call) => (call[0] as { mediaHashes: string[] }).mediaHashes[0],
    );
    expect(hashes).toEqual(
      ['same', 'different'].map((value) => createHash('sha256').update(value).digest('hex')),
    );
    expect(s.enforcement.enqueue).not.toHaveBeenCalled();
  });
  it('retains caches per message and edit revision, not untrusted resource id', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const second = s.job('b', 100);
    await s.service.process(second, s.lease);
    await s.service.process(second, s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
    await s.service.process(s.job('edit', 200, 'b', 'b'), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(3);
    expect(s.history.observe).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'b',
        mediaHashes: [createHash('sha256').update('different').digest('hex')],
      }),
    );
  });
  it('handles two different messages bearing the same trusted timestamp', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    await s.service.process(s.job('b', 0), s.lease);
    expect(s.downloads).toHaveBeenCalledTimes(2);
  });
  it('continues current evidence collection when the baseline download fails', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.downloads.mockRejectedValueOnce(new PhotoDownloadHttpError(410));
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'b' }));
  });
  it('retries transient baseline downloads before committing current history', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    const next = s.job('b', 100);
    s.downloads.mockRejectedValueOnce(new Error('temporary download timeout'));
    await expect(s.service.process(next, s.lease)).rejects.toThrow('temporary download timeout');
    expect(s.history.observe).not.toHaveBeenCalled();
    await s.service.process(next, s.lease);
    expect(s.history.observe).toHaveBeenCalledTimes(2);
  });
  it('defers pressure without downloading, and requires the durable receipt to be processed', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.governor.decide.mockResolvedValue({ action: 'pause', retryAfterMs: 180_000 });
    await expect(s.service.process(s.job('b', 100), s.lease)).rejects.toMatchObject({
      reason: 'governor_pause',
      retryAfterMs: 180_000,
    });
    expect(s.downloads).not.toHaveBeenCalled();
    expect(s.governor.decide).toHaveBeenCalledWith({
      component: 'message-duplicate-media',
      sourceTag: 'message-duplicate',
      allowRecoveryWindowRun: true,
    });
    const job = s.job('c', 200);
    s.rows.set('c', { status: 'QUEUED' });
    await expect(s.service.process(job, s.lease)).rejects.toThrow();
  });
  it('makes bounded progress after one slow governor delay instead of starving the job', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const s = setup();
      await s.service.process(s.job('a', 0), s.lease);
      const job = s.job('b', 100);
      s.governor.decide.mockResolvedValue({ action: 'slow', retryAfterMs: 20_000 });
      await expect(s.service.process(job, s.lease)).rejects.toMatchObject({
        reason: 'governor_slow',
        retryAfterMs: 20_000,
      });
      expect(s.downloads).not.toHaveBeenCalled();
      clock.mockReturnValue(now + 20_000);
      await s.service.process(job, s.lease);
      expect(s.downloads).toHaveBeenCalledTimes(2);
      expect(s.history.observe).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([NaN, Infinity, -1, 0])('bounds malformed retry delays (%p)', (delay) => {
    const error = new MessageDuplicateMediaDeferredError('governor_pause', delay);
    expect(error.retryAfterMs).toBe(60_000);
  });
  it('enforces only the current verified hit and never a retroactive baseline', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.history.observe.mockResolvedValue({
      hit: {},
      binding: { eventTimestampMs: Date.now() - 1000 },
    });
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    s.lease.resolveActionEligibility.mockResolvedValue(false);
    await s.service.process(s.job('c', 200), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
  });
});
