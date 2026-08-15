import { PublicationContentService } from './publication-content.service';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';
import { validateMaxMediaUploadPayload } from '../max/max-media-upload-validation';
import { PUBLICATION_MAX_TOTAL_IMAGE_BYTES } from './publication-media-limits';

const TINY_JPEG = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z',
  'base64',
);
function createTransaction() {
  let revision = 0;
  return {
    publicationContentRevision: {
      create: jest.fn().mockImplementation(async () => ({ id: `content-${++revision}` })),
    },
    publicationAsset: {
      findFirst: jest.fn(),
      upsert: jest
        .fn()
        .mockImplementation(
          async ({
            where,
          }: {
            where: { actorUserId_sha256: { actorUserId: string; sha256: string } };
          }) => ({
            id: `asset-${where.actorUserId_sha256.actorUserId}`,
          }),
        ),
    },
    publicationContentAsset: {
      create: jest.fn().mockResolvedValue({}),
    },
  };
}

function createService(prisma: unknown = {}) {
  return new PublicationContentService(
    prisma as never,
    {
      validateMediaUploadPayload: validateMaxMediaUploadPayload,
    } as never,
  );
}

describe('PublicationContentService', () => {
  it('uses the injected MAX client validation boundary for inline media ingestion', async () => {
    const validateMediaUploadPayload = jest.fn(validateMaxMediaUploadPayload);
    const service = new PublicationContentService(
      {} as never,
      {
        validateMediaUploadPayload,
      } as never,
    );

    await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'image',
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/png',
          fileName: 'photo.png',
        },
      ],
    });

    expect(validateMediaUploadPayload).toHaveBeenCalledWith('image', TINY_JPEG);
  });

  it('scopes identical asset hashes to the actor that owns the publication', async () => {
    const tx = createTransaction();
    const service = createService();
    const content = {
      text: '',
      textFormat: 'plain' as const,
      buttons: [],
      media: [
        {
          type: 'image' as const,
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/png',
          fileName: '../photo\u0000.png',
        },
      ],
    };

    const prepared = await service.prepareContentRevision(content);
    await service.persistPreparedContentRevision(tx, 'publication-a', 1, prepared, 'actor-a');
    await service.persistPreparedContentRevision(tx, 'publication-b', 1, prepared, 'actor-b');

    const firstUpsert = tx.publicationAsset.upsert.mock.calls[0][0];
    const secondUpsert = tx.publicationAsset.upsert.mock.calls[1][0];
    expect(firstUpsert.where).toEqual({
      actorUserId_sha256: {
        actorUserId: 'actor-a',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      },
    });
    expect(secondUpsert.where).toEqual({
      actorUserId_sha256: {
        actorUserId: 'actor-b',
        sha256: firstUpsert.where.actorUserId_sha256.sha256,
      },
    });
    expect(firstUpsert.create).toEqual(expect.objectContaining({ actorUserId: 'actor-a' }));
    expect(secondUpsert.create).toEqual(expect.objectContaining({ actorUserId: 'actor-b' }));
    expect(firstUpsert.create).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'photo_.jpg' }),
    );
    expect(secondUpsert.create).toEqual(
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'photo_.jpg' }),
    );
  });

  it('canonicalizes an inline video from its bytes before persisting it', async () => {
    const tx = createTransaction();
    const service = createService();

    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        {
          type: 'video',
          payload: null,
          base64: TINY_VALID_MP4.toString('base64'),
          mimeType: 'application/octet-stream',
          fileName: 'clip.webm',
        },
      ],
    });
    await service.persistPreparedContentRevision(tx, 'publication-video', 1, prepared, 'actor-a');

    expect(tx.publicationAsset.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          mimeType: 'video/mp4',
          fileName: 'clip.mp4',
          bytes: TINY_VALID_MP4,
        }),
      }),
    );
  });

  it('rejects malformed inline media before creating a content revision or asset', async () => {
    const tx = createTransaction();
    const service = createService();

    await expect(
      service.prepareContentRevision({
        text: '',
        textFormat: 'plain',
        buttons: [],
        media: [
          {
            type: 'image',
            base64: Buffer.from('not-an-image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'broken.png',
          },
        ],
      }),
    ).rejects.toThrow(
      'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
    );
    expect(tx.publicationContentRevision.create).not.toHaveBeenCalled();
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('requires direct actor ownership when reusing a saved asset', async () => {
    const tx = createTransaction();
    tx.publicationAsset.findFirst.mockResolvedValue({
      id: 'asset-owned',
      actorUserId: 'actor-a',
      sha256: 'a'.repeat(64),
      mimeType: 'image/png',
      fileName: 'saved.png',
      sizeBytes: 5,
      bytes: Buffer.from('image'),
      durablePayload: null,
    });
    const service = createService();

    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [{ type: 'image-ref', assetId: 'asset-owned' }],
    });
    expect(tx.publicationAsset.findFirst).not.toHaveBeenCalled();
    await service.persistPreparedContentRevision(tx, 'publication-a', 2, prepared, 'actor-a');

    expect(tx.publicationAsset.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-owned',
        actorUserId: 'actor-a',
        contentLinks: {
          some: { contentRevision: { publication: { actorUserId: 'actor-a' } } },
        },
      },
    });
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('rechecks the total image byte limit after resolving saved assets in the transaction', async () => {
    const tx = createTransaction();
    tx.publicationAsset.findFirst.mockResolvedValue({
      id: 'asset-large',
      actorUserId: 'actor-a',
      sha256: 'b'.repeat(64),
      mimeType: 'image/png',
      fileName: 'saved.png',
      sizeBytes: PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
      bytes: Buffer.from('saved-image'),
      durablePayload: null,
    });
    const service = createService();
    const prepared = await service.prepareContentRevision({
      text: '',
      textFormat: 'plain',
      buttons: [],
      media: [
        { type: 'image-ref', assetId: 'asset-large' },
        {
          type: 'image',
          base64: TINY_JPEG.toString('base64'),
          mimeType: 'image/jpeg',
          fileName: 'inline.jpg',
        },
      ],
    });

    await expect(
      service.persistPreparedContentRevision(tx, 'publication-a', 2, prepared, 'actor-a'),
    ).rejects.toThrow('Суммарный размер фото превышает 24 МБ.');
    expect(tx.publicationContentRevision.create).not.toHaveBeenCalled();
    expect(tx.publicationAsset.upsert).not.toHaveBeenCalled();
  });

  it('keeps test-send asset lookup scoped to the requesting actor', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'asset-owned',
      actorUserId: 'actor-a',
      mimeType: 'image/png',
      fileName: 'saved.png',
      bytes: Buffer.from('image'),
      durablePayload: null,
    });
    const service = createService({
      publicationAsset: { findFirst },
    });

    await service.buildLegacyTestPayload(
      {
        requestId: 'test-send-a',
        content: {
          text: '',
          textFormat: 'plain',
          buttons: [],
          media: [{ type: 'image-ref', assetId: 'asset-owned' }],
        },
        sourceTarget: { chatId: 'chat-a', entityType: 'chat' },
      },
      'actor-a',
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        id: 'asset-owned',
        actorUserId: 'actor-a',
        contentLinks: {
          some: { contentRevision: { publication: { actorUserId: 'actor-a' } } },
        },
      },
    });
  });

  it('validates and canonicalizes inline video before building a legacy test payload', async () => {
    const service = createService();
    const request = {
      requestId: 'test-video',
      content: {
        text: '',
        textFormat: 'plain' as const,
        buttons: [],
        media: [
          {
            type: 'video' as const,
            payload: null,
            base64: TINY_VALID_MP4.toString('base64'),
            mimeType: 'video/webm',
            fileName: '../clip.webm',
          },
        ],
      },
      sourceTarget: { chatId: 'chat-a', entityType: 'chat' as const },
    };

    await expect(service.buildLegacyTestPayload(request, 'actor-a')).resolves.toMatchObject({
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
      mediaPayload: {
        __publicationVideoInlineBase64: TINY_VALID_MP4.toString('base64'),
      },
    });

    await expect(
      service.buildLegacyTestPayload(
        {
          ...request,
          requestId: 'test-invalid-video',
          content: {
            ...request.content,
            media: [
              {
                ...request.content.media[0],
                base64: Buffer.from(
                  '000000186674797069736f6d0000020069736f6d69736f32',
                  'hex',
                ).toString('base64'),
              },
            ],
          },
        },
        'actor-a',
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
    });
  });
});
