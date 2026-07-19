import { createAdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';

describe('AdminChatRulesTextRuntimeContext', () => {
  it('reads and writes legacy target properties through a typed bridge', () => {
    const target = { value: 1 } as { value: number; extra?: string };
    const context = createAdminChatRulesTextRuntimeContext(target);

    expect(context.read('value')).toBe(1);

    context.write('extra', 'ok');

    expect(target.extra).toBe('ok');
  });

  it('exposes chat rules runtime infrastructure through explicit typed accessors', async () => {
    const settings = { linkPolicy: 'ALLOWLIST_ONLY' } as never;
    const domains = [{ domain: 'example.com' }] as never;
    const headers = [{ id: 'channel-1', title: 'Канал' }] as never;
    const displayNames = new Map([['user-1', 'Admin Name']]);
    const botAssignment = { botId: 'bot-1', primaryBotId: 'bot-1' };
    const target = {
      prisma: { chatRules: {} },
      chatContextCache: { invalidate: jest.fn() },
      maxClient: { getChatMemberProfiles: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn() },
      maxBotTokenValidationSecrets: ['token-1'],
      getSettings: jest.fn().mockResolvedValue(settings),
      getDomainAllowlistDetails: jest.fn().mockResolvedValue(domains),
      isRequiredSubscriptionCurrentlyActive: jest.fn().mockReturnValue(true),
      resolveRequiredSubscriptionChannelHeaders: jest.fn().mockResolvedValue(headers),
      resolveUserDisplayNames: jest.fn().mockResolvedValue(displayNames),
      resolveChatSettingsReadBotAssignmentData: jest.fn().mockResolvedValue(botAssignment),
    };
    const context = createAdminChatRulesTextRuntimeContext(target);

    expect(context.prisma).toBe(target.prisma);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.maxBotTokenValidationSecrets).toBe(target.maxBotTokenValidationSecrets);
    await expect(context.getSettings('chat-1', {} as never)).resolves.toBe(settings);
    await expect(context.getDomainAllowlistDetails('chat-1', {} as never)).resolves.toBe(domains);
    expect(context.isRequiredSubscriptionCurrentlyActive(settings)).toBe(true);
    await expect(context.resolveRequiredSubscriptionChannelHeaders(['channel-1'])).resolves.toBe(
      headers,
    );
    await expect(context.resolveUserDisplayNames('chat-1', ['user-1'])).resolves.toBe(displayNames);
    await expect(context.resolveChatSettingsReadBotAssignmentData('chat-1')).resolves.toBe(
      botAssignment,
    );
  });
});
