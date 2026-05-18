import { chatSettingsSchema, updateChatRulesRequestSchema } from '@maxim/contracts';

describe('chatSettingsSchema duplicate flow validation', () => {
  it('allows phone numbers and photos by default', () => {
    expect(chatSettingsSchema.parse({}).phoneNumbersEnabled).toBe(true);
    expect(chatSettingsSchema.parse({}).photoMessagesEnabled).toBe(true);
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
