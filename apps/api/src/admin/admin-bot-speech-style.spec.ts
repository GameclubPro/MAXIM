import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminSettingsService } from './admin-settings.service';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
};
const settingsRevision = '2026-10-04T10:00:00.000Z';

function createService(initial: ChatSettings | null = chatSettingsSchema.parse({})) {
  let storedSettings = initial;
  const legacyAdminService = {
    assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
    resolveChatSettingsWriteBotAssignmentData: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
  };
  const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const tx = {
    chat: { upsert: jest.fn().mockResolvedValue({ id: 'chat-1' }) },
    chatSettings: {
      upsert: jest.fn().mockImplementation(async ({ create, update }) => {
        const nextSettings: ChatSettings = storedSettings
          ? { ...storedSettings, ...update }
          : chatSettingsSchema.parse(create);
        storedSettings = nextSettings;
        return {
          botSpeechStyle: nextSettings.botSpeechStyle,
          updatedAt: new Date(settingsRevision),
        };
      }),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: jest.fn().mockImplementation(async (operation) => operation(tx)),
  };
  const service = new AdminSettingsService(
    legacyAdminService as never,
    prisma as never,
    chatContextCache as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return {
    service,
    legacyAdminService,
    prisma,
    tx,
    chatContextCache,
    getStoredSettings: () => storedSettings,
    setStoredSettings: (settings: ChatSettings) => {
      storedSettings = settings;
    },
  };
}

describe('AdminSettingsService speech style mutation', () => {
  it('preserves concurrent custom text and media while atomically saving only the style', async () => {
    const fixture = createService();
    const concurrentSettings = chatSettingsSchema.parse({
      botSpeechStyle: 'FRIENDLY',
      greetingBotMessageText: '  Свой текст для {user}.\n',
      linkBotMessageText: '   ',
      botSpeechMedia: {
        greetingBotMessageText: {
          base64: 'aW1hZ2U=',
          mimeType: 'image/png',
          fileName: 'custom.png',
        },
      },
      linkPolicy: 'BLOCKLIST_ONLY',
    });
    fixture.legacyAdminService.resolveChatSettingsWriteBotAssignmentData.mockImplementationOnce(
      async () => {
        fixture.setStoredSettings(concurrentSettings);
        return { botId: 'bot-1' };
      },
    );

    await expect(
      fixture.service.updateBotSpeechStyle('chat-1', user, { botSpeechStyle: 'IRONIC' }),
    ).resolves.toEqual({ botSpeechStyle: 'IRONIC', settingsRevision });

    expect(fixture.legacyAdminService.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'chat-1',
      user.userId,
      'chat',
    );
    expect(fixture.getStoredSettings()).toEqual({
      ...concurrentSettings,
      botSpeechStyle: 'IRONIC',
    });
    expect(fixture.tx.chatSettings.upsert).toHaveBeenCalledWith({
      where: { chatId: 'chat-1' },
      create: { chatId: 'chat-1', botSpeechStyle: 'IRONIC' },
      update: { botSpeechStyle: 'IRONIC' },
      select: { botSpeechStyle: true, updatedAt: true },
    });
    expect(fixture.tx.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_SETTINGS',
        payload: { source: 'miniapp', settingKeys: ['botSpeechStyle'] },
      },
    });
    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(fixture.tx.auditLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.chatContextCache.invalidate.mock.invocationCallOrder[0],
    );
  });

  it('creates a missing settings row with inherited defaults and the selected style', async () => {
    const fixture = createService(null);

    await fixture.service.updateBotSpeechStyle('chat-1', user, { botSpeechStyle: 'ROBOT' });

    expect(fixture.getStoredSettings()).toEqual({
      ...chatSettingsSchema.parse({}),
      botSpeechStyle: 'ROBOT',
    });
    expect(fixture.tx.chat.upsert).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      create: {
        id: 'chat-1',
        title: 'Chat chat-1',
        entityType: 'CHAT',
        catalogKind: 'MANAGED',
        botId: 'bot-1',
      },
      update: { catalogKind: 'MANAGED' },
    });
  });

  it('rejects non-admin access before any mutation or cache invalidation', async () => {
    const fixture = createService();
    fixture.legacyAdminService.assertManagedEntityAdminAccess.mockRejectedValueOnce(
      new ForbiddenException(),
    );

    await expect(
      fixture.service.updateBotSpeechStyle('chat-1', user, { botSpeechStyle: 'IRONIC' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(
      fixture.legacyAdminService.resolveChatSettingsWriteBotAssignmentData,
    ).not.toHaveBeenCalled();
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { botSpeechStyle: null },
    { botSpeechStyle: 'UNKNOWN' },
    { botSpeechStyle: 'IRONIC', greetingBotMessageText: 'Нельзя заменить' },
    { botSpeechStyle: 'IRONIC', botSpeechMedia: {} },
  ])('rejects invalid or unrelated request fields: %j', async (body) => {
    const fixture = createService();

    await expect(fixture.service.updateBotSpeechStyle('chat-1', user, body)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fixture.prisma.$transaction).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('does not invalidate the cache when the style and audit transaction fails', async () => {
    const fixture = createService();
    fixture.tx.auditLog.create.mockRejectedValueOnce(new Error('audit unavailable'));

    await expect(
      fixture.service.updateBotSpeechStyle('chat-1', user, { botSpeechStyle: 'IRONIC' }),
    ).rejects.toThrow('audit unavailable');
    expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
  });
});
