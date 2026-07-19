import { chatSettingsSchema } from '@maxim/contracts';
import { readChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';

describe('stored chat settings button URL sanitizer', () => {
  it.each([
    'https://example.test/path https://nested.example.test',
    'https://max.ru/chat/example/https://nested.example.test',
    'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
  ])('drops malformed greeting button URL %s', (url) => {
    const sanitized = sanitizeStoredChatSettings({
      greetingBotButtons: [{ text: 'Open', url }],
      greetingBotButtonEnabled: true,
      greetingBotButtonUrl: url,
      greetingBotButtonText: 'Open',
    }) as Record<string, unknown>;

    expect(sanitized.greetingBotButtons).toEqual([]);
    expect(sanitized.greetingBotButtonEnabled).toBe(false);
    expect(sanitized.greetingBotButtonUrl).toBe('');
  });

  it('sanitizes a malformed stored admin-contact URL before contract parsing', () => {
    const sanitized = sanitizeStoredChatSettings({
      antiSpamEnabled: true,
      profanityAdminContactButtonEnabled: true,
      profanityAdminContactButtonUrl:
        'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
    });
    const parsed = chatSettingsSchema.parse(sanitized);

    expect(parsed.antiSpamEnabled).toBe(true);
    expect(parsed.profanityAdminContactButtonEnabled).toBe(false);
    expect(parsed.profanityAdminContactButtonUrl).toBe('');
  });

  it('preserves an allowed profile-handoff URL for an admin-contact button', () => {
    const profileHandoffUrl = 'https://max.ru/admin_bot?start=pmh-profile_123';
    const parsed = chatSettingsSchema.parse(
      sanitizeStoredChatSettings({
        profanityAdminContactButtonEnabled: true,
        profanityAdminContactButtonUrl: profileHandoffUrl,
      }),
    );

    expect(parsed.profanityAdminContactButtonEnabled).toBe(true);
    expect(parsed.profanityAdminContactButtonUrl).toBe(profileHandoffUrl);
  });

  it('repairs only the malformed stored admin-contact button on the read path', async () => {
    const updatedAt = new Date('2026-07-19T08:00:00.000Z');
    const storedSettings = {
      ...chatSettingsSchema.parse({ antiSpamEnabled: true }),
      profanityAdminContactButtonEnabled: true,
      profanityAdminContactButtonUrl:
        'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
      updatedAt,
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({ settings: storedSettings }),
      },
      chatSettings: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const warn = jest.fn();

    const result = await readChatSettings({
      prisma: prisma as never,
      chatContextCache: { invalidate },
      logger: { warn },
      chatId: 'chat-1',
    });

    expect(result.antiSpamEnabled).toBe(true);
    expect(result.profanityAdminContactButtonEnabled).toBe(false);
    expect(result.profanityAdminContactButtonUrl).toBe('');
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', updatedAt },
      data: expect.objectContaining({
        profanityAdminContactButtonEnabled: false,
        profanityAdminContactButtonUrl: '',
      }),
    });
    expect(warn).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('chat-1');
  });
});
