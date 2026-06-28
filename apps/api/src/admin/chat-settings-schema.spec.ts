import {
  broadcastHandoffRequestSchema,
  chatSettingsSchema,
  sendBroadcastRequestSchema,
  updateChatRulesRequestSchema,
} from '@maxim/contracts';

describe('chatSettingsSchema duplicate flow validation', () => {
  it('allows phone numbers and photos by default', () => {
    const settings = chatSettingsSchema.parse({});

    expect(settings.phoneNumbersEnabled).toBe(true);
    expect(settings.photoMessagesEnabled).toBe(true);
    expect(settings.duplicateDetectionPreset).toBe('STRICT');
  });

  it('allows duplicate thresholds to start from the first duplicate', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
    });

    expect(result.success).toBe(true);
  });

  it('does not require BAN thresholds to stay above MUTE thresholds', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteWindowSec: 48 * 60 * 60,
      duplicateMuteMaxCount: 6,
      duplicateBanWindowSec: 24 * 60 * 60,
      duplicateBanMaxCount: 4,
    });

    expect(result.success).toBe(true);
  });

  it('normalizes stored multi-button arrays and syncs the legacy greeting fields', () => {
    const result = chatSettingsSchema.parse({
      greetingEnabled: true,
      greetingBotMessageEnabled: true,
      greetingBotButtonEnabled: true,
      greetingBotButtons: [
        {
          text: ' Открыть канал ',
          url: 'https://max.ru/channel/maxim ',
        },
        {
          text: 'Профиль',
          url: 'https://max.ru/profile/maxim',
        },
      ],
    });

    expect(result.greetingBotButtons).toEqual([
      { text: 'Открыть канал', url: 'https://max.ru/channel/maxim' },
      { text: 'Профиль', url: 'https://max.ru/profile/maxim' },
    ]);
    expect(result.greetingBotButtonUrl).toBe('https://max.ru/channel/maxim');
    expect(result.greetingBotButtonText).toBe('Открыть канал');
  });

  it('keeps legacy button fields compatible when the stored array is empty', () => {
    const result = chatSettingsSchema.parse({
      textFiltersBotMessageEnabled: true,
      textFiltersBotButtonEnabled: true,
      textFiltersBotButtonUrl: ' https://max.ru/channel/rules ',
      textFiltersBotButtonText: ' Правила ',
      textFiltersBotButtons: [],
    });

    expect(result.textFiltersBotButtons).toEqual([
      { text: 'Правила', url: 'https://max.ru/channel/rules' },
    ]);
    expect(result.textFiltersBotButtonUrl).toBe('https://max.ru/channel/rules');
    expect(result.textFiltersBotButtonText).toBe('Правила');
  });

  it('allows profile handoff links only for the dedicated admin contact button', () => {
    const profileHandoffUrl = 'https://max.ru/id613002203036_bot?start=pmh-chat-user';
    const adminContactSettings = chatSettingsSchema.parse({
      linkAdminContactButtonEnabled: true,
      linkAdminContactButtonUrl: profileHandoffUrl,
    });

    expect(adminContactSettings.linkAdminContactButtonUrl).toBe(profileHandoffUrl);

    const genericButtonResult = chatSettingsSchema.safeParse({
      linkBotMessageEnabled: true,
      linkBotButtonEnabled: true,
      linkBotButtonUrl: profileHandoffUrl,
      linkBotButtonText: 'Связь с админом',
    });

    expect(genericButtonResult.success).toBe(false);
  });

  it('keeps bot speech media as a per-message image map', () => {
    const result = chatSettingsSchema.parse({
      botSpeechMedia: {
        messageLimitsBotMessageText: {
          base64: ' YQ== ',
          mimeType: ' image/png ',
          fileName: ' warning.png ',
        },
      },
    });

    expect(result.botSpeechMedia).toEqual({
      messageLimitsBotMessageText: {
        base64: 'YQ==',
        mimeType: 'image/png',
        fileName: 'warning.png',
      },
    });
  });

  it('normalizes required subscription state from selected sources', () => {
    const enabled = chatSettingsSchema.parse({
      requiredSubscriptionEnabled: false,
      requiredSubscriptionChannelIds: [' channel-1 ', 'channel-1'],
      requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
    });
    const disabled = chatSettingsSchema.parse({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [],
      requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
    });

    expect(enabled.requiredSubscriptionEnabled).toBe(true);
    expect(enabled.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(enabled.requiredSubscriptionExpiresAt).toBe('');
    expect(disabled.requiredSubscriptionEnabled).toBe(false);
    expect(disabled.requiredSubscriptionChannelIds).toEqual([]);
    expect(disabled.requiredSubscriptionExpiresAt).toBe('');
  });

  it('keeps per-chat admin command names normalized', () => {
    const defaults = chatSettingsSchema.parse({});
    const customized = chatSettingsSchema.parse({
      adminBanCommandName: ' бан ',
      adminBanAllCommandName: ' Бан! ',
      adminMuteCommandName: ' тихий   час ',
      adminPermanentMuteCommandName: ' мут   навсегда ',
      adminRulesCommandName: ' регламент ',
      adminSilenceCommandName: ' режим   тишины ',
      adminOpenChatCommandName: ' открыть   чат ',
    });

    expect(defaults.adminBanCommandName).toBe('бан');
    expect(defaults.adminBanAllCommandName).toBe('Бан!');
    expect(defaults.adminMuteCommandName).toBe('мут');
    expect(defaults.adminPermanentMuteCommandName).toBe('мут 88');
    expect(defaults.adminRulesCommandName).toBe('правило');
    expect(defaults.adminSilenceCommandName).toBe('тишина');
    expect(defaults.adminOpenChatCommandName).toBe('тишина выкл');
    expect(customized.adminBanCommandName).toBe('бан');
    expect(customized.adminBanAllCommandName).toBe('Бан!');
    expect(customized.adminMuteCommandName).toBe('тихий час');
    expect(customized.adminPermanentMuteCommandName).toBe('мут навсегда');
    expect(customized.adminRulesCommandName).toBe('регламент');
    expect(customized.adminSilenceCommandName).toBe('режим тишины');
    expect(customized.adminOpenChatCommandName).toBe('открыть чат');
  });

  it('rejects duplicate per-chat admin command names', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'мера',
      adminOpenChatCommandName: ' мера ',
    });

    expect(result.success).toBe(false);
  });

  it('rejects per-chat admin command names that only differ by case', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'бан',
      adminBanAllCommandName: 'БАН',
    });

    expect(result.success).toBe(false);
  });

  it('rejects case-only duplicates for case-insensitive admin commands', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'мут',
      adminMuteCommandName: 'МУТ',
    });

    expect(result.success).toBe(false);
  });

  it('rejects bot speech media with non-image mime type', () => {
    const result = chatSettingsSchema.safeParse({
      botSpeechMedia: {
        messageLimitsWarnMessageText: {
          base64: 'YQ==',
          mimeType: 'application/pdf',
          fileName: 'notice.pdf',
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('updateChatRulesRequestSchema button normalization', () => {
  it('normalizes multi-button rules payloads and keeps legacy fields in sync', () => {
    const result = updateChatRulesRequestSchema.parse({
      text: 'Правила чата',
      autoTextEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      buttonEnabled: true,
      buttons: [
        { text: ' Открыть чат ', url: 'https://max.ru/channel/team ' },
        { text: 'MAX', url: 'https://max.ru/' },
      ],
    });

    expect(result.buttons).toEqual([
      { text: 'Открыть чат', url: 'https://max.ru/channel/team' },
      { text: 'MAX', url: 'https://max.ru/' },
    ]);
    expect(result.buttonUrl).toBe('https://max.ru/channel/team');
    expect(result.buttonText).toBe('Открыть чат');
  });

  it('allows profile handoff links for the dedicated rules admin contact button', () => {
    const profileHandoffUrl = 'https://max.ru/id613002203036_bot?start=pmh-chat-user';
    const result = updateChatRulesRequestSchema.parse({
      text: 'Правила чата',
      adminContactButtonEnabled: true,
      adminContactButtonUrl: profileHandoffUrl,
    });

    expect(result.adminContactButtonUrl).toBe(profileHandoffUrl);

    const genericButtonResult = updateChatRulesRequestSchema.safeParse({
      text: 'Правила чата',
      buttonEnabled: true,
      buttonUrl: profileHandoffUrl,
      buttonText: 'Связь с админом',
    });

    expect(genericButtonResult.success).toBe(false);
  });
});

describe('broadcast request schema normalization', () => {
  it('keeps audience, buttons, and legacy cycle fields aligned for send and handoff payloads', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      targetChatIds: [' chat-2 ', 'chat-1', 'chat-2'],
      buttonEnabled: true,
      buttonUrl: ' https://max.ru/channel/maxim ',
      buttonText: ' Читать ',
      cycleEnabled: true,
      cycleEveryDays: 2,
      cycleCount: 3,
    });
    const handoffPayload = broadcastHandoffRequestSchema.parse({
      targetChatIds: [' chat-2 ', 'chat-1', 'chat-2'],
      buttonEnabled: true,
      buttonUrl: ' https://max.ru/channel/maxim ',
      buttonText: ' Читать ',
      cycleEnabled: true,
      cycleEveryDays: 2,
      cycleCount: 3,
    });

    for (const payload of [sendPayload, handoffPayload]) {
      expect(payload.targetMode).toBe('selected');
      expect(payload.targetChatIds).toEqual(['chat-2', 'chat-1']);
      expect(payload.applyToAllChats).toBe(false);
      expect(payload.buttons).toEqual([{ text: 'Читать', url: 'https://max.ru/channel/maxim' }]);
      expect(payload.buttonEnabled).toBe(true);
      expect(payload.buttonUrl).toBe('https://max.ru/channel/maxim');
      expect(payload.buttonText).toBe('Читать');
      expect(payload.cycleEveryHours).toBe(48);
    }
  });

  it('canonicalizes calendar slots and preserves handoff conflict replacement flag', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        '2026-03-03T12:00:00.000Z',
        '2026-03-03T12:00:00Z',
        '2026-03-03T13:00:00.000Z',
      ],
    });
    const handoffPayload = broadcastHandoffRequestSchema.parse({
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        '2026-03-03T12:00:00Z',
        '2026-03-03T12:00:00.000Z',
      ],
      replaceConflictingSlots: true,
    });

    expect(sendPayload.scheduledSlots).toEqual([
      '2026-03-03T12:00:00.000Z',
      '2026-03-03T13:00:00.000Z',
    ]);
    expect(handoffPayload.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(handoffPayload.replaceConflictingSlots).toBe(true);
  });

  it('accepts ISO datetimes with offsets and rejects ambiguous dates', () => {
    const offsetPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduledSlots: ['2026-03-03T15:00:00+03:00'],
    });

    expect(offsetPayload.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(
      sendBroadcastRequestSchema.safeParse({
        text: 'Анонс',
        sendAt: '2026-03-03',
      }).success,
    ).toBe(false);
  });

  it('clears inactive schedule fields for every broadcast schedule mode', () => {
    const legacyPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: false,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const calendarPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const cyclePayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });

    expect(legacyPayload).toEqual(
      expect.objectContaining({
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
        replaceConflictingSlots: false,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(calendarPayload).toEqual(
      expect.objectContaining({
        sendAt: null,
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        replaceConflictingSlots: true,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(cyclePayload).toEqual(
      expect.objectContaining({
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
        replaceConflictingSlots: false,
        cycleEnabled: true,
        cycleEveryHours: 4,
        cycleCount: 5,
      }),
    );
  });

  it('infers calendar mode from legacy payloads that contain scheduled slots', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const explicitLegacyPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      sendAt: '2026-03-03T11:00:00.000Z',
    });

    expect(sendPayload).toEqual(
      expect.objectContaining({
        scheduleMode: 'calendar',
        sendAt: null,
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(explicitLegacyPayload).toEqual(
      expect.objectContaining({
        scheduleMode: 'legacy',
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
      }),
    );
  });

  it('rejects cycles outside the shared 31-day schedule window', () => {
    const result = sendBroadcastRequestSchema.safeParse({
      text: 'Анонс',
      cycleEnabled: true,
      cycleEveryHours: 24,
      cycleCount: 33,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('cycleCount');
    }
  });

  it('rejects invalid broadcast schedule timezones', () => {
    for (const schema of [sendBroadcastRequestSchema, broadcastHandoffRequestSchema]) {
      const result = schema.safeParse({
        text: 'Анонс',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Mars/Olympus',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
          'scheduleTimezone',
        );
      }
    }
  });

  it('uses shared validation for selected audience and calendar slots', () => {
    for (const schema of [sendBroadcastRequestSchema, broadcastHandoffRequestSchema]) {
      const result = schema.safeParse({
        text: 'Анонс',
        targetMode: 'selected',
        targetChatIds: [],
        scheduleMode: 'calendar',
        scheduledSlots: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
          expect.arrayContaining(['targetChatIds', 'scheduledSlots']),
        );
      }
    }
  });
});
