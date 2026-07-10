import { PublicationContentService } from './publication-content.service';

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

describe('PublicationContentService', () => {
  it('scopes identical asset hashes to the actor that owns the publication', async () => {
    const tx = createTransaction();
    const service = new PublicationContentService({} as never);
    const content = {
      text: '',
      textFormat: 'plain' as const,
      buttons: [],
      media: [
        {
          type: 'image' as const,
          base64: Buffer.from('same-image').toString('base64'),
          mimeType: 'image/png',
          fileName: 'photo.png',
        },
      ],
    };

    await service.persistContentRevision(tx, 'publication-a', 1, content, 'actor-a');
    await service.persistContentRevision(tx, 'publication-b', 1, content, 'actor-b');

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
    const service = new PublicationContentService({} as never);

    await service.persistContentRevision(
      tx,
      'publication-a',
      2,
      {
        text: '',
        textFormat: 'plain',
        buttons: [],
        media: [{ type: 'image-ref', assetId: 'asset-owned' }],
      },
      'actor-a',
    );

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

  it('keeps test-send asset lookup scoped to the requesting actor', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'asset-owned',
      actorUserId: 'actor-a',
      mimeType: 'image/png',
      fileName: 'saved.png',
      bytes: Buffer.from('image'),
      durablePayload: null,
    });
    const service = new PublicationContentService({
      publicationAsset: { findFirst },
    } as never);

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
});
