import { createAdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';

describe('AdminManagedBroadcastRuntimeContext', () => {
  it('exposes managed broadcast infrastructure through explicit typed accessors', async () => {
    const snapshot = { mode: 'normal' } as never;
    const target = {
      prisma: { managedBroadcast: {} },
      maxClient: { sendMessage: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn() },
      backgroundRuntimeGovernorService: { decide: jest.fn() },
      managedEntityAccessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      managedBroadcastDegradePauseLogAtMs: 17,
      resolveSystemModeSnapshot: jest.fn().mockResolvedValue(snapshot),
      resolveDeliveryBotAssignment: jest.fn().mockResolvedValue(undefined),
      resolvePrivateDeliveryBotId: jest.fn().mockReturnValue(undefined),
      resolvePrivateDialogChatId: jest.fn().mockResolvedValue(null),
      listChatsForMassBroadcast: jest.fn().mockResolvedValue([]),
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      assertManagedEntityReadAccess: jest.fn().mockResolvedValue(undefined),
      resolveBroadcastButtonContext: jest.fn().mockResolvedValue({
        buttons: [],
        commentDialogReference: null,
      }),
    };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.backgroundRuntimeGovernorService).toBe(
      target.backgroundRuntimeGovernorService,
    );
    expect(context.managedEntityAccessLossService).toBe(target.managedEntityAccessLossService);
    expect(context.managedBroadcastDegradePauseLogAtMs).toBe(17);

    context.managedBroadcastDegradePauseLogAtMs = 23;

    expect(target.managedBroadcastDegradePauseLogAtMs).toBe(23);
    await expect(context.resolveSystemModeSnapshot()).resolves.toBe(snapshot);
    expect(target.resolveSystemModeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('delegates delivery routing helpers without losing the legacy target context', async () => {
    const user = {
      userId: 'user-1',
      chatId: 'private-current',
      username: null,
      displayName: 'User One',
    };
    const target = {
      deliveryBotId: 'bot-1',
      privateChatId: 'private-1',
      prisma: { managedBroadcast: {} },
      maxClient: { sendMessage: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn() },
      managedBroadcastDegradePauseLogAtMs: 0,
      resolveSystemModeSnapshot: jest.fn(),
      resolveDeliveryBotAssignment(chatId: string): Promise<string | undefined> {
        return Promise.resolve(`${this.deliveryBotId}:${chatId}`);
      },
      resolvePrivateDeliveryBotId(botId?: string | null): string | undefined {
        return botId ? `${this.deliveryBotId}:${botId}` : this.deliveryBotId;
      },
      resolvePrivateDialogChatId(
        authUser: typeof user,
        botId?: string | null,
      ): Promise<string | null> {
        return Promise.resolve(`${this.privateChatId}:${authUser.userId}:${botId ?? 'default'}`);
      },
    };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    await expect(context.resolveDeliveryBotAssignment('chat-1')).resolves.toBe('bot-1:chat-1');
    expect(context.resolvePrivateDeliveryBotId('bot-2')).toBe('bot-1:bot-2');
    await expect(context.resolvePrivateDialogChatId(user, 'bot-3')).resolves.toBe(
      'private-1:user-1:bot-3',
    );
  });

  it('delegates managed entity access helpers through explicit ports', async () => {
    const user = {
      userId: 'user-1',
      chatId: 'private-current',
      username: null,
      displayName: 'User One',
    };
    const target = {
      scope: 'legacy',
      adminAccessCalls: [] as string[],
      readAccessCalls: [] as string[],
      listChatsForMassBroadcast(
        authUser: typeof user,
        options?: { discoveryMode?: 'full' | 'cached-first' },
      ) {
        return Promise.resolve([
          {
            id: `${this.scope}:${authUser.userId}:${options?.discoveryMode ?? 'default'}`,
          },
        ] as never);
      },
      assertManagedEntityAdminAccess(
        chatId: string,
        userId: string,
        entityType: string,
      ): Promise<void> {
        this.adminAccessCalls.push(`${this.scope}:${chatId}:${userId}:${entityType}`);
        return Promise.resolve();
      },
      assertManagedEntityReadAccess(
        chatId: string,
        userId: string,
        entityType: string,
        options?: { skipAdminCheck?: boolean },
      ): Promise<void> {
        this.readAccessCalls.push(
          `${this.scope}:${chatId}:${userId}:${entityType}:${options?.skipAdminCheck ?? false}`,
        );
        return Promise.resolve();
      },
    };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    await expect(
      context.listChatsForMassBroadcast(user, { discoveryMode: 'cached-first' }),
    ).resolves.toEqual([{ id: 'legacy:user-1:cached-first' }]);
    await context.assertManagedEntityAdminAccess('chat-1', 'user-1', 'chat');
    await context.assertManagedEntityReadAccess('channel-1', 'user-1', 'channel', {
      skipAdminCheck: true,
    });

    expect(target.adminAccessCalls).toEqual(['legacy:chat-1:user-1:chat']);
    expect(target.readAccessCalls).toEqual(['legacy:channel-1:user-1:channel:true']);
  });

  it('delegates broadcast button context through an explicit port', async () => {
    const target = {
      scope: 'legacy',
      resolveBroadcastButtonContext(
        chatId: string,
        entityType: string,
        options: { includeCustomButton: boolean },
        botId?: string,
      ) {
        return Promise.resolve({
          buttons: [
            [
              {
                type: 'link',
                text: `${this.scope}:${chatId}:${entityType}:${botId ?? 'default'}`,
                url: options.includeCustomButton ? 'https://example.com' : 'https://example.org',
              },
            ],
          ],
          commentDialogReference: null,
        });
      },
    };
    const context = createAdminManagedBroadcastRuntimeContext(target);

    await expect(
      context.resolveBroadcastButtonContext(
        'chat-1',
        'chat',
        {
          includeCustomButton: true,
          customButtonText: 'Open',
          customButtonUrl: 'https://example.com',
        },
        'bot-1',
      ),
    ).resolves.toEqual({
      buttons: [
        [
          {
            type: 'link',
            text: 'legacy:chat-1:chat:bot-1',
            url: 'https://example.com',
          },
        ],
      ],
      commentDialogReference: null,
    });
  });
});
