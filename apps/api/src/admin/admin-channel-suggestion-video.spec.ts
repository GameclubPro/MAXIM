import { AdminService } from './admin.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';
import {
  buildChannelSuggestionMediaMetadata,
  loadStoredChannelSuggestionImages,
  prepareChannelSuggestionMediaRows,
} from './admin-channel-suggestion-image-storage';
import { uploadChannelSuggestionVideo } from './admin-channel-suggestion-video';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';

const video = {
  base64: TINY_VALID_MP4.toString('base64'),
  mimeType: 'video/mp4' as const,
  fileName: 'clip.mp4',
};

describe('channel suggestion uploaded video', () => {
  it('validates and stores video bytes in the existing owned media relation, without JSON media', async () => {
    const rows = await prepareChannelSuggestionMediaRows([], video);
    expect(rows).toEqual([
      expect.objectContaining({
        position: 0,
        mimeType: 'video/mp4',
        sizeBytes: TINY_VALID_MP4.length,
      }),
    ]);
    expect(buildChannelSuggestionMediaMetadata(rows)).toEqual(
      expect.objectContaining({
        imageCount: 0,
        hasImage: false,
        hasVideo: true,
        videoStorageVersion: 1,
        imageStorageVersion: 2,
      }),
    );
    expect(JSON.stringify(buildChannelSuggestionMediaMetadata(rows))).not.toContain(video.base64);
    const repository = {
      findMany: jest.fn().mockResolvedValue(rows.map((row) => ({ ...row, durablePayload: null }))),
    };
    const loaded = await loadStoredChannelSuggestionImages({
      auditLogId: 'suggestion-1',
      payload: buildChannelSuggestionMediaMetadata(rows),
      legacyImages: [],
      repository,
      logger: { error: jest.fn() },
    });
    expect(loaded).toEqual([{ type: 'video', ...video }]);
    expect(repository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { auditLogId: 'suggestion-1' }, take: 11 }),
    );
    const { videoStorageVersion, ...imageOnlyReaderPayload } =
      buildChannelSuggestionMediaMetadata(rows);
    expect(videoStorageVersion).toBe(1);
    await expect(
      loadStoredChannelSuggestionImages({
        auditLogId: 'suggestion-1',
        payload: imageOnlyReaderPayload,
        legacyImages: [],
        repository,
        logger: { error: jest.fn() },
      }),
    ).rejects.toThrow('Медиа предложки');
  });

  it('rejects mixed media, corrupt bytes and image files disguised as video', async () => {
    await expect(
      prepareChannelSuggestionMediaRows([{ ...video, mimeType: 'image/png' }], video),
    ).rejects.toThrow('отдельными');
    await expect(
      prepareChannelSuggestionMediaRows([], { ...video, base64: 'not-base64' }),
    ).rejects.toThrow('Видео повреждено');
    await expect(
      prepareChannelSuggestionMediaRows([], {
        ...video,
        base64: Buffer.from('not a video').toString('base64'),
      }),
    ).rejects.toThrow();
  });

  it('never drops a missing or incorrectly typed stored video', async () => {
    const rows = await prepareChannelSuggestionMediaRows([], video);
    const args = {
      auditLogId: 'publisher-suggestion',
      payload: buildChannelSuggestionMediaMetadata(rows),
      legacyImages: [],
      repository: { findMany: jest.fn().mockResolvedValue([]) },
      logger: { error: jest.fn() },
    };
    await expect(loadStoredChannelSuggestionImages(args)).rejects.toThrow('Видео предложки');
    args.repository.findMany.mockResolvedValue([
      { ...rows[0], durablePayload: null, mimeType: 'image/png' },
    ]);
    await expect(loadStoredChannelSuggestionImages(args)).rejects.toThrow('Видео предложки');
  });

  it.each([
    'major',
    'major-2',
    'major-3',
    'major-4',
    'major-5',
    'major-6',
    'major-7',
    'major-8',
    'major-9',
    'publisher',
  ])('uploads only with the selected %s bot', async (botId) => {
    const maxClient = { uploadVideo: jest.fn().mockResolvedValue({ token: `${botId}-token` }) };
    await expect(
      uploadChannelSuggestionVideo({ type: 'video', ...video }, maxClient as never, botId),
    ).resolves.toEqual({ attachments: [{ type: 'video', payload: { token: `${botId}-token` } }] });
    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      TINY_VALID_MP4,
      'clip.mp4',
      'video/mp4',
      expect.objectContaining({ botId }),
    );
  });

  it('persists a Major miniapp video without an upload on the request path', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.create.mockImplementation(async ({ data }: any) => ({
      id: 'major-video',
      actorUserId: 'author',
      createdAt: new Date(),
      ...data,
    }));
    const service = new AdminService(
      prisma as never,
      {} as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'enqueueChannelSuggestionDelivery').mockResolvedValue(true);
    const result = await (service as any).createChannelSuggestionAuditLog({
      chatId: 'channel-1',
      user: { userId: 'author' },
      threadId: 'thread-1',
      source: 'miniapp',
      text: '',
      video,
    });
    expect(result.queued).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'CHANNEL_DIALOG_SUGGESTION',
          payload: expect.objectContaining({ hasVideo: true, imageCount: 0 }),
          channelSuggestionImageAssets: {
            create: [expect.objectContaining({ sizeBytes: TINY_VALID_MP4.length })],
          },
        }),
      }),
    );
    expect(
      JSON.stringify((prisma.auditLog.create.mock.calls[0]![0] as any).data.payload),
    ).not.toContain(video.base64);
  });
});
