import {
  createPublicationRequestSchema,
  decodeLegacyPublicationListCursor,
  decodePublicationListCursor,
  encodeLegacyPublicationListCursor,
  encodePublicationListCursor,
  listLegacyPublicationsQuerySchema,
  listPublicationDeliveriesQuerySchema,
  listPublicationsQuerySchema,
  MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH,
  publicationContentInputSchema,
} from '@maxim/contracts/publication';

describe('publication contracts', () => {
  it('accepts mixed chat/channel targets and a byte-backed video', () => {
    const parsed = createPublicationRequestSchema.parse({
      requestId: 'publication_request_1',
      title: 'Анонс',
      content: {
        text: 'Новый выпуск',
        textFormat: 'markdown',
        buttons: [{ text: 'Открыть', url: 'https://max.ru/example', row: 0 }],
        media: [
          {
            type: 'video',
            payload: null,
            base64: Buffer.from('video').toString('base64'),
            mimeType: 'video/mp4',
            fileName: 'clip.mp4',
          },
        ],
      },
      audience: {
        selection: 'SELECTED',
        mode: 'SNAPSHOT',
        targets: [
          { chatId: 'chat-1', entityType: 'chat' },
          { chatId: 'channel-1', entityType: 'channel' },
        ],
      },
      schedule: { mode: 'now', timezone: 'Europe/Moscow' },
      intent: 'publish',
    });

    expect(parsed.audience.targets).toHaveLength(2);
    expect(parsed.content.media[0]).toEqual(
      expect.objectContaining({ type: 'video', mimeType: 'video/mp4' }),
    );
  });

  it('rejects image/video mixes and video inputs with two sources', () => {
    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: [
          {
            type: 'image',
            base64: Buffer.from('image').toString('base64'),
            mimeType: 'image/png',
            fileName: 'image.png',
          },
          {
            type: 'video',
            payload: { token: 'video-token' },
            base64: '',
            mimeType: 'video/mp4',
            fileName: 'video.mp4',
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: [
          {
            type: 'video',
            payload: { token: 'video-token' },
            base64: Buffer.from('video').toString('base64'),
            mimeType: 'video/mp4',
            fileName: 'video.mp4',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects inline images whose combined request body exceeds the total limit', () => {
    const imageBase64 = 'A'.repeat(Math.floor(MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH / 3) + 1);

    expect(
      publicationContentInputSchema.safeParse({
        text: '',
        media: Array.from({ length: 3 }, (_, index) => ({
          type: 'image',
          base64: imageBase64,
          mimeType: 'image/png',
          fileName: `image-${index}.png`,
        })),
      }).success,
    ).toBe(false);
  });

  it('accepts only ordinary http/https publication button links', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'file:///tmp/post',
      'https://max.ru/bot?start=pm2_private',
    ]) {
      expect(
        publicationContentInputSchema.safeParse({
          text: 'Пост',
          buttons: [{ text: 'Открыть', url, row: 0 }],
          media: [],
        }).success,
      ).toBe(false);
    }

    expect(
      publicationContentInputSchema.safeParse({
        text: 'Пост',
        buttons: [{ text: 'Открыть', url: 'https://example.com/post', row: 0 }],
        media: [],
      }).success,
    ).toBe(true);
  });

  it('parses server-side list filters and binds them into opaque cursors', () => {
    const query = listPublicationsQuerySchema.parse({
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
      limit: '25',
    });
    expect(query).toEqual({
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
      limit: 25,
    });

    const cursor = encodePublicationListCursor({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'publication-1',
      view: query.view,
      query: query.query,
      entityType: query.entityType,
      status: query.status,
    });
    expect(decodePublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'publication-1',
      view: 'schedules',
      query: 'Анонс',
      entityType: 'channel',
      status: 'failed',
    });
  });

  it('binds legacy pagination cursors to view, kind, entity, and search filters', () => {
    const query = listLegacyPublicationsQuerySchema.parse({
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
      limit: '25',
    });
    expect(query).toEqual({
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
      limit: 25,
    });

    const cursor = encodeLegacyPublicationListCursor({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'broadcast-1',
      itemKind: 'broadcast',
      view: query.view,
      kind: query.kind,
      entityType: query.entityType,
      query: query.query,
    });
    expect(decodeLegacyPublicationListCursor(cursor)).toEqual({
      v: 1,
      updatedAt: '2026-07-10T09:00:00.000Z',
      id: 'broadcast-1',
      itemKind: 'broadcast',
      view: 'history',
      kind: 'broadcast',
      entityType: 'channel',
      query: 'Анонс',
    });
    expect(listLegacyPublicationsQuerySchema.safeParse({ limit: 31 }).success).toBe(false);
  });

  it('accepts delivery pagination that excludes a reviewed status', () => {
    expect(
      listPublicationDeliveriesQuerySchema.parse({
        excludeStatus: 'AMBIGUOUS',
        cursor: 'delivery-50',
        limit: '50',
      }),
    ).toEqual({
      excludeStatus: 'AMBIGUOUS',
      cursor: 'delivery-50',
      limit: 50,
    });
  });
});
