import { chatSettingsSchema } from '@maxim/contracts';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  normalizeChatSettings,
  readChatSettings,
  readChatSettingsSnapshot,
} from './admin-chat-settings';

const chatId = 'stop-words-snapshot-chat';
const updatedAt = new Date('2026-10-29T12:00:00.000Z');
const enabledPolicy = stopWordsPolicySchema.parse({
  enabled: true,
  rules: [{ id: 'casino', kind: 'WORD', value: 'casino' }],
});

function storedSettings(overrides: Record<string, unknown> = {}) {
  return {
    ...normalizeChatSettings(chatSettingsSchema.parse({}), undefined, chatId),
    id: 'stop-words-snapshot-settings',
    chatId,
    stopWordsRevision: 3,
    createdAt: updatedAt,
    updatedAt,
    ...overrides,
  };
}

function createFixture(
  stored: ReturnType<typeof storedSettings>,
  refreshed: ReturnType<typeof storedSettings> | null = null,
) {
  const prisma = {
    chat: { upsert: jest.fn().mockResolvedValue({ id: chatId, settings: stored }) },
    chatSettings: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(refreshed),
    },
  };
  const params: Parameters<typeof readChatSettingsSnapshot>[0] = {
    prisma: prisma as never,
    chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
    logger: { warn: jest.fn() },
    chatId,
  };
  return { params, prisma };
}

describe('chat settings stop-word storage snapshot', () => {
  it.each([
    { policy: null, expected: 'legacy' },
    { policy: enabledPolicy, expected: 'valid' },
    { policy: { version: 999, enabled: true }, expected: 'invalid' },
  ])('classifies raw $expected storage without changing it', async ({ policy, expected }) => {
    const stored = storedSettings({ stopWordsPolicy: policy });
    const original = structuredClone(stored);
    const { params, prisma } = createFixture(stored);

    const snapshot = await readChatSettingsSnapshot(params);

    expect(snapshot.stopWordsStorageStatus).toBe(expected);
    expect(snapshot.settings.stopWordsRevision).toBe(3);
    expect(snapshot.settings.settingsRevision).toBe(updatedAt.toISOString());
    if (expected === 'invalid') expect(snapshot.settings.stopWordsPolicy?.enabled).toBe(false);
    expect(stored).toEqual(original);
    expect(prisma.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('retains the settings-only compatibility wrapper', async () => {
    const { params } = createFixture(storedSettings({ stopWordsPolicy: enabledPolicy }));

    const settings = await readChatSettings(params);

    expect(settings.stopWordsPolicy?.enabled).toBe(true);
    expect(settings).not.toHaveProperty('settings');
    expect(settings).not.toHaveProperty('stopWordsStorageStatus');
  });

  it('preserves malformed media while returning a disabled presentation and invalid status', async () => {
    const stored = storedSettings({
      antiSpamEnabled: true,
      stopWordsPolicy: enabledPolicy,
      stopWordsMedia: {
        explanation: { base64: 'aW1hZ2U=', mimeType: 'text/plain', fileName: 'broken.txt' },
      },
    });
    const original = structuredClone(stored);
    const { params, prisma } = createFixture(stored);

    const snapshot = await readChatSettingsSnapshot(params);

    expect(snapshot.stopWordsStorageStatus).toBe('invalid');
    expect(snapshot.settings).toMatchObject({
      antiSpamEnabled: true,
      stopWordsPolicy: { enabled: false, sanctions: { media: {} } },
      stopWordsRevision: 3,
    });
    expect(snapshot.settings).not.toHaveProperty('stopWordsMedia');
    expect(stored).toEqual(original);
    expect(prisma.chatSettings.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    { policy: enabledPolicy, expected: 'valid', enabled: true },
    { policy: { version: 999, enabled: true }, expected: 'invalid', enabled: false },
  ])('binds metadata and revisions to the same refreshed $expected row', async (testCase) => {
    const stored = storedSettings({
      stopWordsPolicy: enabledPolicy,
      greetingBotButtonEnabled: true,
      greetingBotButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
    });
    const refreshedAt = new Date(updatedAt.getTime() + 1_000);
    const refreshed = storedSettings({
      stopWordsPolicy: testCase.policy,
      stopWordsRevision: 4,
      updatedAt: refreshedAt,
    });
    const { params, prisma } = createFixture(stored, refreshed);

    const snapshot = await readChatSettingsSnapshot(params);

    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { chatId, updatedAt } }),
    );
    expect(snapshot).toMatchObject({
      stopWordsStorageStatus: testCase.expected,
      settings: {
        stopWordsPolicy: { enabled: testCase.enabled },
        stopWordsRevision: 4,
        settingsRevision: refreshedAt.toISOString(),
      },
    });
    expect(params.chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('keeps stop-word policy, media and revision out of a general fallback repair', async () => {
    const stored = storedSettings({
      stopWordsPolicy: { version: 999, enabled: true },
      stopWordsMedia: { warning: { unexpected: true } },
      reportsThreshold: 'broken',
    });
    const original = structuredClone(stored);
    const { params, prisma } = createFixture(stored);

    const snapshot = await readChatSettingsSnapshot(params);

    const repair = prisma.chatSettings.updateMany.mock.calls[0]?.[0]?.data;
    expect(repair).toBeDefined();
    for (const field of ['stopWordsPolicy', 'stopWordsMedia', 'stopWordsRevision']) {
      expect(repair).not.toHaveProperty(field);
    }
    expect(snapshot).toMatchObject({
      stopWordsStorageStatus: 'invalid',
      settings: { stopWordsPolicy: { enabled: false }, stopWordsRevision: 3 },
    });
    expect(stored).toEqual(original);
  });

  it('does not erase legacy rules, sanctions or their media when an unrelated field is corrupt', async () => {
    const legacy = {
      stopWordsPolicy: null,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBlockedDomains: ['example.com'],
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBotMessageEnabled: true,
      messageLimitsBotMessageText: 'Удалено.',
      messageLimitsWarnEnabled: true,
      messageLimitsWarnMessageText: 'Предупреждение.',
      messageLimitsMuteEnabled: true,
      messageLimitsMuteDurationHours: 24,
      messageLimitsBanEnabled: true,
      messageLimitsBotButtonEnabled: true,
      messageLimitsBotButtons: [{ text: 'Правила', url: 'https://example.com/rules' }],
      messageLimitsBotButtonUrl: 'https://example.com/rules',
      messageLimitsBotButtonText: 'Правила',
      messageLimitsAdminContactButtonEnabled: true,
      messageLimitsAdminContactButtonUrl: 'https://max.ru/admin',
      messageLimitsRulesButtonEnabled: true,
      rulesAttachViolationsEnabled: true,
      botSpeechMedia: {
        messageLimitsBotMessageText: {
          base64: 'aW1hZ2U=',
          mimeType: 'image/jpeg',
          fileName: 'notice.jpg',
        },
      },
    };
    const stored = storedSettings({ ...legacy, reportsThreshold: 'broken' });
    const original = structuredClone(stored);
    const { params, prisma } = createFixture(stored);

    const snapshot = await readChatSettingsSnapshot(params);

    const repair = prisma.chatSettings.updateMany.mock.calls[0]?.[0]?.data;
    for (const field of Object.keys(legacy)) expect(repair).not.toHaveProperty(field);
    expect(snapshot).toMatchObject({
      stopWordsStorageStatus: 'legacy',
      settings: {
        stopWordsPolicy: {
          enabled: true,
          rules: [expect.objectContaining({ value: 'casino' })],
          domains: ['example.com'],
          sanctions: {
            warnEnabled: true,
            muteEnabled: true,
            muteDurationHours: 24,
            banEnabled: true,
            media: { explanation: legacy.botSpeechMedia.messageLimitsBotMessageText },
          },
        },
      },
    });
    expect(stored).toEqual(original);
  });

  it('normalizes a legacy button for presentation without repairing its stored value', async () => {
    const stored = storedSettings({
      stopWordsPolicy: null,
      messageLimitsBlockedWords: ['casino'],
      messageLimitsBotButtonEnabled: true,
      messageLimitsBotButtons: [],
      messageLimitsBotButtonUrl: '',
    });
    const original = structuredClone(stored);
    const { params, prisma } = createFixture(stored);

    const snapshot = await readChatSettingsSnapshot(params);

    expect(snapshot.settings.stopWordsPolicy?.sanctions.botButtonEnabled).toBe(false);
    expect(prisma.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(stored).toEqual(original);
  });
});
