import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';

function createRuntime() {
  const findUnique = jest.fn();
  const assetFindFirst = jest.fn();
  const uploadVideo = jest.fn().mockResolvedValue({ token: 'uploaded-video-token' });
  const runtime = new AdminManagedBroadcastRuntime({
    prisma: {
      publicationContentRevision: { findUnique },
      publicationAsset: { findFirst: assetFindFirst },
    },
    maxClient: { uploadVideo },
    logger: { warn: jest.fn() },
  } as never);

  return { runtime, findUnique, assetFindFirst, uploadVideo };
}

function createBroadcastRow(overrides: Record<string, unknown> = {}) {
  return {
    publicationContentRevisionId: 'revision-1',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    ...overrides,
  };
}

function createVideoRequestPayload(mediaPayload: Record<string, unknown>) {
  return {
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
    mediaType: 'video',
    mediaPayload,
    mediaMimeType: 'video/mp4',
    mediaFileName: 'clip.mp4',
  };
}

describe('AdminManagedBroadcastRuntime publication media', () => {
  it('loads publication images in revision order and converts stored bytes to base64', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            bytes: Buffer.from('first-image'),
            durablePayload: null,
            mimeType: 'image/png',
            fileName: 'first.png',
          },
        },
        {
          asset: {
            bytes: Buffer.from('second-image'),
            durablePayload: null,
            mimeType: 'image/jpeg',
            fileName: 'second.jpg',
          },
        },
      ],
    });

    const media = await (runtime as any).loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        imageEnabled: true,
        imageBase64: Buffer.from('legacy-image').toString('base64'),
      }),
    );

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'revision-1' },
      select: {
        assets: {
          orderBy: [{ position: 'asc' }],
          select: {
            asset: {
              select: {
                id: true,
                bytes: true,
                durablePayload: true,
                mimeType: true,
                fileName: true,
              },
            },
          },
        },
      },
    });
    expect(media).toEqual({
      imageEnabled: true,
      imageBase64: Buffer.from('first-image').toString('base64'),
      imageMimeType: 'image/png',
      imageFileName: 'first.png',
      images: [
        {
          base64: Buffer.from('first-image').toString('base64'),
          mimeType: 'image/png',
          fileName: 'first.png',
        },
        {
          base64: Buffer.from('second-image').toString('base64'),
          mimeType: 'image/jpeg',
          fileName: 'second.jpg',
        },
      ],
      mediaType: 'image',
      mediaPayload: {
        images: [
          {
            base64: Buffer.from('first-image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'first.png',
          },
          {
            base64: Buffer.from('second-image').toString('base64'),
            mimeType: 'image/jpeg',
            fileName: 'second.jpg',
          },
        ],
      },
      mediaMimeType: '',
      mediaFileName: '',
    });
  });

  it('uses a publication video durable payload without reading legacy row media', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            id: 'asset-video-token',
            bytes: null,
            durablePayload: { token: 'video-token-1' },
            mimeType: 'video/mp4',
            fileName: 'announcement.mp4',
          },
        },
      ],
    });

    const media = await (runtime as any).loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        mediaType: 'video',
        mediaPayload: { token: 'legacy-video-token' },
      }),
    );

    expect(media).toEqual({
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: 'video',
      mediaPayload: { token: 'video-token-1' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'announcement.mp4',
    });
  });

  it('keeps a byte-backed publication video as an internal upload reference', async () => {
    const { runtime, findUnique } = createRuntime();
    findUnique.mockResolvedValue({
      assets: [
        {
          asset: {
            id: 'asset-video-bytes',
            bytes: Buffer.from('video-bytes'),
            durablePayload: null,
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
          },
        },
      ],
    });

    const media = await (runtime as any).loadManagedBroadcastRequestMedia(createBroadcastRow());

    expect(media).toEqual({
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: 'video',
      mediaPayload: { __publicationVideoAssetId: 'asset-video-bytes' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });
  });

  it('uploads trusted inline test video bytes and does not expose them as a MAX payload', async () => {
    const { runtime, uploadVideo } = createRuntime();
    const bytes = Buffer.from('inline-video');

    const media = await (runtime as any).resolveManagedBroadcastMedia(
      createVideoRequestPayload({
        [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: bytes.toString('base64'),
      }),
      'chat',
      'chat-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );

    expect(uploadVideo).toHaveBeenCalledWith(
      bytes,
      'clip.mp4',
      'video/mp4',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
    expect(media).toEqual({
      attachments: [{ type: 'video', payload: { token: 'uploaded-video-token' } }],
    });
  });

  it('does not resolve publication asset markers from ordinary public broadcast requests', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();

    await expect(
      (runtime as any).resolveManagedBroadcastMedia(
        createVideoRequestPayload({
          [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-from-another-user',
        }),
        'chat',
        'chat-1',
        'user-1',
      ),
    ).rejects.toThrow('Внутренняя ссылка на видео недоступна.');
    expect(assetFindFirst).not.toHaveBeenCalled();
    expect(uploadVideo).not.toHaveBeenCalled();
  });

  it('rechecks actor ownership before uploading a trusted saved video reference', async () => {
    const { runtime, assetFindFirst, uploadVideo } = createRuntime();
    assetFindFirst.mockResolvedValue({
      bytes: Buffer.from('owned-video'),
      mimeType: 'video/mp4',
      fileName: 'owned.mp4',
    });

    await (runtime as any).resolveManagedBroadcastMedia(
      createVideoRequestPayload({
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-owned',
      }),
      'channel',
      'channel-1',
      'user-1',
      undefined,
      undefined,
      undefined,
      { trustedPublicationVideoMarkers: true },
    );

    expect(assetFindFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-owned',
        contentLinks: {
          some: { contentRevision: { publication: { actorUserId: 'user-1' } } },
        },
      },
      select: { bytes: true, mimeType: true, fileName: true },
    });
    expect(uploadVideo).toHaveBeenCalledWith(
      Buffer.from('owned-video'),
      'owned.mp4',
      'video/mp4',
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
  });

  it('keeps legacy persisted media unchanged when no publication revision is linked', async () => {
    const { runtime, findUnique } = createRuntime();
    const legacyImage = {
      base64: Buffer.from('legacy-image').toString('base64'),
      mimeType: 'image/png',
      fileName: 'legacy.png',
    };

    const media = await (runtime as any).loadManagedBroadcastRequestMedia(
      createBroadcastRow({
        publicationContentRevisionId: null,
        imageEnabled: true,
        imageBase64: legacyImage.base64,
        imageMimeType: legacyImage.mimeType,
        imageFileName: legacyImage.fileName,
        mediaType: 'image',
        mediaPayload: { images: [legacyImage] },
      }),
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(media).toEqual({
      imageEnabled: true,
      imageBase64: legacyImage.base64,
      imageMimeType: legacyImage.mimeType,
      imageFileName: legacyImage.fileName,
      images: [legacyImage],
      mediaType: 'image',
      mediaPayload: { images: [legacyImage] },
      mediaMimeType: '',
      mediaFileName: '',
    });
  });
});
