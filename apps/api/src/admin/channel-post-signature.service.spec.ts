import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  CHANNEL_POST_MAX_TEXT_LENGTH,
  ChannelPostSignatureService,
} from './channel-post-signature.service';

function createFixture() {
  const prisma = {
    channelSettings: {
      findUnique: jest.fn().mockResolvedValue({
        postSignatureEnabled: true,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: 'Читать канал',
        postSignatureUrl: '',
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    vkParsingSettings: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    chat: {
      findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
    },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue({
        link: 'http://www.max.ru/channel/news?from=old#post',
      }),
    },
    managedBotChatCatalog: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => unknown) =>
    operation(prisma),
  );
  const maxClient = {
    getChatSnapshot: jest.fn().mockResolvedValue({
      entityType: 'channel',
      link: 'https://max.ru/channel/live',
    }),
  };
  const maxBotLinkService = {
    resolveBotIdForSend: jest.fn().mockResolvedValue('bot-1'),
  };
  const service = new ChannelPostSignatureService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
  );

  return { maxBotLinkService, maxClient, prisma, service };
}

describe('ChannelPostSignatureService', () => {
  it('leaves chat messages unchanged without reading channel settings', async () => {
    const { prisma, service } = createFixture();

    await expect(
      service.preparePostText(
        'chat-1',
        { text: 'Сообщение', textFormat: 'markdown' },
        { entityType: 'chat' },
      ),
    ).resolves.toEqual({
      text: 'Сообщение',
      textFormat: 'markdown',
      signatureApplied: false,
    });
    expect(prisma.channelSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('adds the current channel link to plain text and engagement text', async () => {
    const { maxClient, prisma, service } = createFixture();

    const result = await service.preparePostText(
      'channel-1',
      { text: 'Новость <дня>', engagementText: 'Новость дня' },
      { entityType: 'channel', trafficClass: 'interactive', sourceTag: 'test' },
    );

    expect(result).toEqual({
      text: 'Новость &lt;дня&gt;\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
      textFormat: 'html',
      engagementText: 'Новость дня\n\n[Читать канал](https://max.ru/channel/news)',
      signatureApplied: true,
    });
    expect(prisma.chat.findUnique).toHaveBeenCalledWith({
      where: { id: 'channel-1' },
      select: { entityType: true },
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('preserves markdown semantics by rendering the signed message as HTML', async () => {
    const { service } = createFixture();

    const result = await service.preparePostText(
      'channel-1',
      { text: '**Важно**', textFormat: 'markdown' },
      { entityType: 'channel' },
    );

    expect(result.text).toBe(
      '<strong>Важно</strong>\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
    );
    expect(result.textFormat).toBe('html');
  });

  it('uses an explicit signature URL without resolving the channel link', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'SIGNATURE',
      postSignatureText: 'Заказать рекламу',
      postSignatureUrl: 'https://ads.example/contact?source=(channel)',
    });

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'Новость', engagementText: 'Новость' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: 'Новость\n\n<a href="https://ads.example/contact?source=(channel)">Заказать рекламу</a>',
      textFormat: 'html',
      engagementText:
        'Новость\n\n[Заказать рекламу](https://ads.example/contact?source=%28channel%29)',
      signatureApplied: true,
    });
    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findFirst).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('returns a button without appending the action to the post text', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'BUTTON',
      postSignatureText: '📞 Заказать рекламу',
      postSignatureUrl: 'https://ads.example/contact',
    });

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'Новость', textFormat: 'markdown' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: 'Новость',
      textFormat: 'markdown',
      signatureApplied: false,
    });
    await expect(
      service.buildPostButton('channel-1', { entityType: 'channel' }),
    ).resolves.toEqual({
      type: 'link',
      text: '📞 Заказать рекламу',
      url: 'https://ads.example/contact',
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('does not append the same trailing channel signature twice', async () => {
    const { service } = createFixture();
    const signedText = 'Новость\n\n<a href="https://max.ru/channel/news">Читать канал</a>';

    await expect(
      service.preparePostText(
        'channel-1',
        { text: signedText, textFormat: 'html' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: signedText,
      textFormat: 'html',
      signatureApplied: false,
    });
  });

  it('still enforces the text limit when the trailing signature is already present', async () => {
    const { service } = createFixture();
    const signedText = `Новость\n\n<a href="https://max.ru/channel/news">Читать канал</a>`;

    await expect(
      service.preparePostText(
        'channel-1',
        { text: signedText, textFormat: 'html' },
        { entityType: 'channel', maxLength: signedText.length - 1 },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a post when the rendered text and signature exceed the MAX limit', async () => {
    const { service } = createFixture();

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'a'.repeat(CHANNEL_POST_MAX_TEXT_LENGTH) },
        { entityType: 'channel' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when an enabled signature has no resolvable public link', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue(null);
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockResolvedValue({ entityType: 'channel', link: null });

    await expect(
      service.preparePostText('channel-1', { text: 'Новость' }, { entityType: 'channel' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a temporary failure when live channel metadata cannot be loaded', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue(null);
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockRejectedValue(new Error('MAX unavailable'));

    await expect(
      service.preparePostText('channel-1', { text: 'Новость' }, { entityType: 'channel' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('updates only the Major channel signature and audit in one transaction', async () => {
    const { prisma, service } = createFixture();

    await expect(
      service.updateSettings('channel-1', 'admin-1', {
        enabled: true,
        presentation: 'button',
        text: '  Новый текст  ',
        url: ' https://max.ru/advertising ',
      }),
    ).resolves.toEqual({
      enabled: true,
      presentation: 'button',
      text: 'Новый текст',
      url: 'https://max.ru/advertising',
    });

    expect(prisma.channelSettings.upsert).toHaveBeenCalledWith({
      where: { chatId: 'channel-1' },
      create: {
        chatId: 'channel-1',
        postSignatureEnabled: true,
        postSignaturePresentation: 'BUTTON',
        postSignatureText: 'Новый текст',
        postSignatureUrl: 'https://max.ru/advertising',
      },
      update: {
        postSignatureEnabled: true,
        postSignaturePresentation: 'BUTTON',
        postSignatureText: 'Новый текст',
        postSignatureUrl: 'https://max.ru/advertising',
      },
    });
    expect(prisma.vkParsingSettings.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_CHANNEL_POST_SIGNATURE',
        payload: {
          changed: {
            enabled: true,
            presentation: 'button',
            text: 'Новый текст',
            url: 'https://max.ru/advertising',
          },
        },
      },
    });
    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
  });
});
