import { PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';

describe('PublicationPublisherRoutingService', () => {
  it('keeps PUBLIK_V1 publishable when Major primary lookup fails and persists custom-only context', async () => {
    const assertTargetsReady = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-publisher-only',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
        policyRevision: 7,
      },
    ]);
    const getStoredChatPrimaryBotId = jest
      .fn()
      .mockRejectedValue(new Error('Major route unavailable'));
    const prepare = jest.fn().mockImplementation(async (params) => ({
      version: 1,
      dialogBotId: params.dialogBotId,
      buttons: [[{ type: 'link', text: 'Открыть', url: 'https://example.com' }]],
      reference: null,
    }));
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      { getStoredChatPrimaryBotId } as never,
      { assertTargetsReady } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );

    const result = await service.prepareOccurrenceRoute(
      PublicationDispatchProfile.PUBLIK_V1,
      'publisher-bot',
      [{ chatId: 'chat-publisher-only', entityType: 'chat' }],
      [{ text: 'Открыть', url: 'https://example.com' }],
    );

    expect(getStoredChatPrimaryBotId).toHaveBeenCalledWith('chat-publisher-only', {
      bypassCache: true,
    });
    expect(prepare).toHaveBeenCalledWith({
      chatId: 'chat-publisher-only',
      entityType: 'chat',
      dialogBotId: 'publisher-bot',
      customButtons: [{ text: 'Открыть', url: 'https://example.com' }],
      includeManagedDialogs: false,
    });
    expect(result.deliveryDataByChatId.get('chat-publisher-only')).toMatchObject({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 7,
      publisherDialogContext: expect.objectContaining({
        version: 1,
        dialogBotId: 'publisher-bot',
        reference: null,
      }),
    });
  });

  it('keeps a distinct Major bot only when it can own managed dialog buttons', async () => {
    const prepare = jest.fn().mockImplementation(async (params) => ({
      version: 1,
      dialogBotId: params.dialogBotId,
      buttons: [],
      reference: null,
    }));
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      { getStoredChatPrimaryBotId: jest.fn().mockResolvedValue('major-bot') } as never,
      {
        assertTargetsReady: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            entityType: 'channel',
            requiredBotId: 'publisher-bot',
            policyRevision: 3,
          },
        ]),
      } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );

    const result = await service.prepareOccurrenceRoute(
      PublicationDispatchProfile.PUBLIK_V1,
      'publisher-bot',
      [{ chatId: 'channel-1', entityType: 'channel' }],
      [],
    );

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        dialogBotId: 'major-bot',
        includeManagedDialogs: true,
      }),
    );
    expect(result.deliveryDataByChatId.get('channel-1')).toMatchObject({
      dialogBotId: 'major-bot',
    });
  });

  it('drops only Major-managed buttons when their context cannot be prepared', async () => {
    const prepare = jest
      .fn()
      .mockRejectedValueOnce(new Error('Major dialog settings unavailable'))
      .mockImplementationOnce(async (params) => ({
        version: 1,
        dialogBotId: params.dialogBotId,
        buttons: [[{ type: 'link', text: 'Сайт', url: 'https://example.com' }]],
        reference: null,
      }));
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      { getStoredChatPrimaryBotId: jest.fn().mockResolvedValue('major-bot') } as never,
      {
        assertTargetsReady: jest.fn().mockResolvedValue([
          {
            chatId: 'chat-1',
            entityType: 'chat',
            requiredBotId: 'publisher-bot',
            policyRevision: 4,
          },
        ]),
      } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );

    const result = await service.prepareOccurrenceRoute(
      PublicationDispatchProfile.PUBLIK_V1,
      'publisher-bot',
      [{ chatId: 'chat-1', entityType: 'chat' }],
      [{ text: 'Сайт', url: 'https://example.com' }],
    );

    expect(prepare).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        dialogBotId: 'major-bot',
        includeManagedDialogs: true,
      }),
    );
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        dialogBotId: 'publisher-bot',
        includeManagedDialogs: false,
      }),
    );
    expect(result.deliveryDataByChatId.get('chat-1')).toMatchObject({
      dialogBotId: 'publisher-bot',
      publisherDialogContext: expect.objectContaining({
        dialogBotId: 'publisher-bot',
        reference: null,
      }),
    });
  });

  it('resolves PUBLIK_V1 audiences only through Publisher-owned scope', async () => {
    const resolvePublicationTargets = jest.fn().mockResolvedValue([
      {
        chatId: 'publisher-channel',
        entityType: 'channel',
        title: 'Publisher channel',
        avatarUrl: null,
        link: null,
      },
    ]);
    const listChats = jest.fn();
    const listChannels = jest.fn();
    const assertChatAdminAccess = jest.fn();
    const assertChannelAdminAccess = jest.fn();
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listChats,
        listChannels,
        assertChatAdminAccess,
        assertChannelAdminAccess,
      } as never,
      { resolvePublicationTargets } as never,
    );
    const user = { userId: 'user-1', username: null, displayName: null };

    await expect(
      service.resolveAudienceTargets(
        user,
        {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'publisher-channel', entityType: 'channel' }],
        },
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ chatId: 'publisher-channel', entityType: 'channel' }),
    ]);
    expect(resolvePublicationTargets).toHaveBeenCalledWith(user, [
      { chatId: 'publisher-channel', entityType: 'channel' },
    ]);
    expect(listChats).not.toHaveBeenCalled();
    expect(listChannels).not.toHaveBeenCalled();
    expect(assertChatAdminAccess).not.toHaveBeenCalled();
    expect(assertChannelAdminAccess).not.toHaveBeenCalled();
  });

  it('keeps legacy target authorization on Major with bounded access checks', async () => {
    const listChats = jest.fn().mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Chat ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    let activeChecks = 0;
    let maxActiveChecks = 0;
    const assertChatAdminAccess = jest.fn().mockImplementation(async () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeChecks -= 1;
    });
    const resolvePublicationTargets = jest.fn();
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listChats,
        listChannels: jest.fn().mockResolvedValue([]),
        assertChatAdminAccess,
        assertChannelAdminAccess: jest.fn(),
      } as never,
      { resolvePublicationTargets } as never,
    );

    await expect(
      service.resolveAudienceTargets(
        { userId: 'user-1', username: null, displayName: null },
        { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
      ),
    ).resolves.toHaveLength(8);
    expect(assertChatAdminAccess).toHaveBeenCalledTimes(8);
    expect(maxActiveChecks).toBe(4);
    expect(resolvePublicationTargets).not.toHaveBeenCalled();
  });
});

describe('PublisherDialogContextService', () => {
  it('builds custom-only buttons without reading Major chat or channel settings', async () => {
    const chatSettingsUpsert = jest.fn();
    const channelSettingsUpsert = jest.fn();
    const service = new PublisherDialogContextService(
      {
        chatSettings: { upsert: chatSettingsUpsert },
        channelSettings: { upsert: channelSettingsUpsert },
      } as never,
      {} as never,
    );

    const context = await service.prepare({
      chatId: 'chat-publisher-only',
      entityType: 'chat',
      dialogBotId: 'publisher-bot',
      customButtons: [{ text: 'Сайт', url: 'https://example.com/path' }],
      includeManagedDialogs: false,
    });

    expect(context).toEqual({
      version: 1,
      dialogBotId: 'publisher-bot',
      buttons: [[{ type: 'link', text: 'Сайт', url: 'https://example.com/path' }]],
      reference: null,
    });
    expect(chatSettingsUpsert).not.toHaveBeenCalled();
    expect(channelSettingsUpsert).not.toHaveBeenCalled();
  });
});
