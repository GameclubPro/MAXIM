import { createAdminChatRulesTextRuntimeContext } from './admin-chat-rules-text-runtime-context';

describe('AdminChatRulesTextRuntimeContext', () => {
  it('exposes chat rules runtime infrastructure through explicit typed accessors', async () => {
    const settings = {
      linkPolicy: 'ALLOWLIST_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
    } as never;
    const domains = [{ domain: 'example.com' }] as never;
    const headers = [{ id: 'channel-1', title: 'Канал' }] as never;
    const displayNames = new Map([['user-1', 'Admin Name']]);
    const botAssignment = { botId: 'bot-1', primaryBotId: 'bot-1' };
    const target = {
      prisma: { chatRules: {} } as never,
      chatContextCache: { invalidate: jest.fn() } as never,
      maxClient: { getChatMemberProfiles: jest.fn() } as never,
      logger: { log: jest.fn(), warn: jest.fn() } as never,
      maxBotTokenValidationSecrets: ['token-1'],
      getSettings: jest.fn().mockResolvedValue(settings),
      getDomainAllowlistDetails: jest.fn().mockResolvedValue(domains),
      resolveRequiredSubscriptionChannelHeaders: jest.fn().mockResolvedValue(headers),
      resolveUserDisplayNames: jest.fn().mockResolvedValue(displayNames),
      resolveChatSettingsReadBotAssignmentData: jest.fn().mockResolvedValue(botAssignment),
    };
    const context = createAdminChatRulesTextRuntimeContext(target);

    expect(Object.keys(context)).not.toContain('read');
    expect(Object.keys(context)).not.toContain('write');
    expect(context.prisma).toBe(target.prisma);
    expect(context.chatContextCache).toBe(target.chatContextCache);
    expect(context.maxClient).toBe(target.maxClient);
    expect(context.logger).toBe(target.logger);
    expect(context.maxBotTokenValidationSecrets).toBe(target.maxBotTokenValidationSecrets);
    // Dependencies may finish initializing after the runtime is constructed.
    target.maxBotTokenValidationSecrets = ['later-token'];
    target.chatContextCache = { invalidate: jest.fn() } as never;
    expect(context.maxBotTokenValidationSecrets).toBe(target.maxBotTokenValidationSecrets);
    expect(context.chatContextCache).toBe(target.chatContextCache);
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
