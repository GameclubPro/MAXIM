import {
  PublisherAutoReplyCaptureError,
  PublisherAutoReplyContentCaptureService,
} from './publisher-auto-reply-content-capture.service';

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ORIGINAL_FETCH = global.fetch;

function exactMessage(overrides: Record<string, unknown> = {}) {
  return {
    mid: 'content-mid-1',
    sender: { user_id: 42 },
    recipient: { chat_id: 42, chat_type: 'dialog' },
    body: { text: 'Привет мир' },
    ...overrides,
  };
}

function persistedReceipt(rawMessage: Record<string, unknown>) {
  return {
    botId: 'publik_bot',
    normalizedPayload: {
      updateId: 'update-content-mid-1',
      botId: 'publik_bot',
      type: 'message_created',
      message: {
        messageId: 'content-mid-1',
        chatId: '42',
        senderId: '42',
        text: 'Старый ответ',
        createdAt: NOW.toISOString(),
      },
      raw: { message: rawMessage },
    },
  };
}

function createFixture(message = exactMessage()) {
  const prisma = { webhookEvent: { findUnique: jest.fn() } };
  const maxClient = {
    getExactMessageRow: jest.fn().mockResolvedValue(message),
    validateMediaUploadPayload: jest.fn().mockResolvedValue({
      extension: 'jpg',
      mimeType: 'image/jpeg',
    }),
  };
  return {
    service: new PublisherAutoReplyContentCaptureService(prisma as never, maxClient as never),
    prisma,
    maxClient,
  };
}

const captureParams = {
  webhookEventId: null,
  publisherBotId: 'publik_bot',
  actorUserId: '42',
  privateChatId: '42',
  incomingMessageId: 'content-mid-1',
};

describe('PublisherAutoReplyContentCaptureService', () => {
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
  });

  it('preserves structured formatting and imports ordered images', async () => {
    const { service, maxClient } = createFixture(
      exactMessage({
        body: {
          text: 'Привет мир',
          markup: [{ type: 'strong', from: 0, length: 6 }],
          attachments: [
            { type: 'image', payload: { url: 'https://max.ru/media/one.jpg' } },
            { type: 'photo', payload: { url: 'https://max.ru/media/two.jpg' } },
          ],
        },
      }),
    );
    global.fetch = jest.fn(async (input: string | URL | Request) => {
      const marker = String(input).includes('/one.jpg') ? 1 : 2;
      return new Response(new Uint8Array([marker, marker + 10]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '2' },
      });
    }) as typeof fetch;

    await expect(service.capture(captureParams)).resolves.toEqual({
      text: '**Привет** мир',
      textFormat: 'markdown',
      images: [
        {
          bytes: Buffer.from([1, 11]),
          mimeType: 'image/jpeg',
          fileName: 'auto-reply-image-1.jpg',
        },
        {
          bytes: Buffer.from([2, 12]),
          mimeType: 'image/jpeg',
          fileName: 'auto-reply-image-2.jpg',
        },
      ],
      buttons: [],
      omissions: [],
    });
    expect(maxClient.validateMediaUploadPayload).toHaveBeenCalledTimes(2);
  });

  it('imports safe link buttons and reports unsupported keyboard actions', async () => {
    const { service } = createFixture(
      exactMessage({
        body: {
          text: 'Выберите раздел',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    { type: 'link', text: 'Каталог', url: 'https://example.com/catalog' },
                    { type: 'callback', text: 'Внутреннее действие', payload: 'private-action' },
                  ],
                  [{ type: 'link', text: 'Поддержка', url: 'https://max.ru/support' }],
                ],
              },
            },
          ],
        },
      }),
    );

    await expect(service.capture(captureParams)).resolves.toMatchObject({
      buttons: [
        { text: 'Каталог', url: 'https://example.com/catalog' },
        { text: 'Поддержка', url: 'https://max.ru/support' },
      ],
      omissions: ['buttons_not_imported'],
    });
  });

  it('rejects two downloaded images with the same SHA-256 content', async () => {
    const { service } = createFixture(
      exactMessage({
        body: {
          text: 'Ответ',
          attachments: [
            { type: 'image', payload: { url: 'https://max.ru/media/one.jpg' } },
            { type: 'image', payload: { url: 'https://max.ru/media/two.jpg' } },
          ],
        },
      }),
    );
    global.fetch = jest.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
    ) as typeof fetch;

    await expect(service.capture(captureParams)).rejects.toMatchObject<
      Partial<PublisherAutoReplyCaptureError>
    >({ code: 'duplicate_images' });
  });

  it('falls back to the exact message when persisted receipt media has gone stale', async () => {
    const remote = exactMessage({ body: { text: 'Свежий ответ из exact lookup' } });
    const { service, prisma, maxClient } = createFixture(remote);
    prisma.webhookEvent.findUnique.mockResolvedValue(
      persistedReceipt(
        exactMessage({
          body: {
            text: 'Старый ответ',
            attachments: [{ type: 'image', payload: { url: 'https://max.ru/media/stale.jpg' } }],
          },
        }),
      ),
    );
    global.fetch = jest.fn(async () => new Response('', { status: 503 })) as typeof fetch;

    await expect(
      service.capture({ ...captureParams, webhookEventId: 'webhook-event-stale-1' }),
    ).resolves.toMatchObject({
      text: 'Свежий ответ из exact lookup',
      textFormat: 'plain',
      images: [],
    });
    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith(
      '42',
      'content-mid-1',
      expect.objectContaining({
        botId: 'publik_bot',
        sourceTag: 'publisher_auto_reply',
      }),
    );
  });
});
