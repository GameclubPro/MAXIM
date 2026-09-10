import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  MessageDuplicateMediaService,
  MessageDuplicateMediaDeferredError,
} from './message-duplicate-media.service';
import { messageDuplicateSettingsDigest } from './message-duplicate-state';
import { duplicateSettings, duplicateUpdate } from './message-duplicate-test-fixtures';
import type { MessageDuplicateJob } from './message-duplicate.queue';

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
  const policy = { resolve: jest.fn().mockResolvedValue({ mode: 'delete_only', revision: 1 }) };
  const history = {
    candidateKeys: jest.fn().mockReturnValue(['caption']),
    observe: jest.fn().mockResolvedValue(null),
  };
  const enforcement = { enqueue: jest.fn() };
  const bots = { isKnownBotUserId: jest.fn().mockReturnValue(false), getDefaultBotId: () => 'bot' };
  const governor = { decide: jest.fn().mockResolvedValue({ action: 'allow' }) };
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
  );
  const downloads = jest.fn(async (url: string) => ({
    bytes: Buffer.from(url.endsWith('b') ? 'different' : 'same'),
  }));
  Object.defineProperty(service, 'binary', { value: { downloadBinary: downloads } });
  jest
    .spyOn(
      service as unknown as { verifyBinary: (bytes: Buffer, kind: string) => Promise<void> },
      'verifyBinary',
    )
    .mockResolvedValue();
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
      version: 1,
      webhookEventId: id,
      chatId: '-123',
      messageId,
      eventTimestampMs: now + timestamp,
      sourceCreatedAt: new Date(now + timestamp).toISOString(),
      createdAt: new Date().toISOString(),
      controlRevision: 1,
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
  };
}

describe('bounded message duplicate media analysis', () => {
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
    s.downloads.mockRejectedValueOnce(new Error('expired baseline URL'));
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.history.observe).toHaveBeenCalledTimes(1);
    expect(s.history.observe).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'b' }));
  });
  it('defers pressure without downloading, and requires the durable receipt to be processed', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.governor.decide.mockResolvedValue({ action: 'pause' });
    await expect(s.service.process(s.job('b', 100), s.lease)).rejects.toBeInstanceOf(
      MessageDuplicateMediaDeferredError,
    );
    expect(s.downloads).not.toHaveBeenCalled();
    const job = s.job('c', 200);
    s.rows.set('c', { status: 'QUEUED' });
    await expect(s.service.process(job, s.lease)).rejects.toThrow();
  });
  it('enforces only the current verified hit and never a retroactive baseline', async () => {
    const s = setup();
    await s.service.process(s.job('a', 0), s.lease);
    s.history.observe.mockResolvedValue({ hit: {}, binding: {} });
    await s.service.process(s.job('b', 100), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
    s.lease.resolveActionEligibility.mockResolvedValue(false);
    await s.service.process(s.job('c', 200), s.lease);
    expect(s.enforcement.enqueue).toHaveBeenCalledTimes(1);
  });
});
