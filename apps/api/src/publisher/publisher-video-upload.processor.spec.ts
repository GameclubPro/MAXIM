import { PublisherVideoUploadProcessor } from './publisher-video-upload.processor';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from '../admin/publication-video-media';

function fixture() {
  const uploads = {
    publisherBotId: 'publisher-bot',
    getOwnedSession: jest
      .fn()
      .mockResolvedValue({ returnvalue: { kind: 'session', token: 'video-token' } }),
  };
  const max = {
    createVideoUploadSession: jest
      .fn()
      .mockResolvedValue({ url: 'https://test.okcdn.ru/private', token: 'video-token' }),
    getVideoDownloadUrl: jest.fn().mockResolvedValue('https://test.okcdn.ru/playable.mp4'),
  };
  const prisma = {
    publicationAsset: {
      upsert: jest
        .fn()
        .mockResolvedValue({
          id: 'asset',
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
          sizeBytes: 36_000_000,
        }),
    },
  };
  const boundary = { assertDispatchEnabled: jest.fn() };
  const health = { assertDispatchAllowed: jest.fn() };
  const processor = new PublisherVideoUploadProcessor(
    uploads as never,
    max as never,
    prisma as never,
    boundary as never,
    health as never,
  );
  const data = {
    requestId: 'upload_request_123456',
    actorUserId: 'actor',
    publisherBotId: 'publisher-bot',
    requestedAtMs: Date.now(),
    phase: 'complete',
    fileName: 'clip.mp4',
    mimeType: 'video/mp4',
    sizeBytes: 36_000_000,
  };
  return { processor, uploads, max, prisma, boundary, data };
}

describe('Publisher direct video completion', () => {
  const previousRole = process.env.APP_ROLE;
  const previousService = process.env.APP_SERVICE_NAME;
  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });
  afterAll(() => {
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousService;
  });

  it('confirms MAX readiness and persists only an owner-bound remote token, never bytes', async () => {
    const { processor, prisma, max, data } = fixture();
    expect((await processor.process({ data } as never)).kind).toBe('asset');
    expect(max.getVideoDownloadUrl).toHaveBeenCalledWith(
      'video-token',
      expect.objectContaining({ botId: 'publisher-bot' }),
    );
    expect(prisma.publicationAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          actorUserId: 'actor',
          bytes: null,
          durablePayload: {
            [PUBLICATION_UPLOADED_VIDEO_FIELD]: {
              version: 1,
              botId: 'publisher-bot',
              token: 'video-token',
            },
          },
        }),
        update: {},
      }),
    );
  });

  it('does not persist an unprocessed or rejected video and redacts failures', async () => {
    const { processor, prisma, max, data } = fixture();
    max.getVideoDownloadUrl.mockRejectedValue(new Error('https://secret.example/token'));
    await expect(processor.process({ data } as never)).rejects.toThrow(
      'MAX video preparation is not ready',
    );
    max.getVideoDownloadUrl.mockResolvedValue(null as never);
    await expect(processor.process({ data } as never)).rejects.toThrow(
      'MAX video preparation is not ready',
    );
    expect(prisma.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('allocates sessions only in the exact publisher role with dispatch enabled', async () => {
    const { processor, max, data, boundary } = fixture();
    process.env.APP_SERVICE_NAME = 'api-admin';
    await expect(processor.process({ data } as never)).rejects.toThrow('outside its owner');
    process.env.APP_SERVICE_NAME = 'api-publisher';
    boundary.assertDispatchEnabled.mockImplementationOnce(() => {
      throw new Error('disabled');
    });
    await expect(processor.process({ data } as never)).rejects.toThrow('disabled');
    expect(max.createVideoUploadSession).not.toHaveBeenCalled();
    await processor.process({ data: { ...data, phase: 'create' } } as never);
    expect(max.createVideoUploadSession).toHaveBeenCalledTimes(1);
  });
});
