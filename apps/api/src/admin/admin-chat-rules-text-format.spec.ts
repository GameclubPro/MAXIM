import {
  MAX_CHAT_RULES_TEXT_LENGTH,
  chatSettingsSchema,
  managedEntityHeaderSchema,
} from '@maxim/contracts';
import {
  buildRulesTextFromSettings,
  buildRulesTextItemsFromSettings,
  buildRulesSanctionsSummary,
  formatRulesConjunctionList,
  formatRulesDuplicateAllowanceLabel,
  formatRulesHoursLabel,
  formatRulesMinutesLabel,
  formatRulesPreviewList,
  formatRulesTime,
  resolveRulesDuplicateAllowedCount,
} from './admin-chat-rules-text-format';

describe('admin chat rules text format helpers', () => {
  it('builds autofilled rules text from active settings', () => {
    const settings = chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      russianProfanityFilterEnabled: true,
      antiSpamEnabled: true,
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: true,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 3,
      messageCountLimitWindowHours: 2,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 7 * 60 + 30,
      linkWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const input = {
      settings,
      domains: [
        {
          domain: 'example.com',
          normalizedValue: 'example.com',
          matchType: 'DOMAIN' as const,
          removeAfterAt: null,
        },
      ],
      requiredSubscriptionChannels: [
        managedEntityHeaderSchema.parse({
          id: 'channel-1',
          title: 'Новости',
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
        managedEntityHeaderSchema.parse({
          id: 'channel-2',
          title: 'Анонсы',
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      ],
    };

    expect(buildRulesTextItemsFromSettings(input)).toEqual([
      'Можно отправлять только ссылки из разрешённого списка.',
      'Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы.',
      'Пожалуйста, без мата и грубой лексики.',
      'Не повторяйте одно и то же сообщение: бот среагирует после 1 дубля.',
      'Пожалуйста, не флудите и не спамьте.',
      'Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
      'Ночью чат работает тише: ограничения действуют с 23:00 до 07:30.',
      'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    ]);
    expect(buildRulesTextFromSettings(input)).toBe(
      [
        'Правила чата:',
        '',
        '1. Можно отправлять только ссылки из разрешённого списка.',
        '2. Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы.',
        '3. Пожалуйста, без мата и грубой лексики.',
        '4. Не повторяйте одно и то же сообщение: бот среагирует после 1 дубля.',
        '5. Пожалуйста, не флудите и не спамьте.',
        '6. Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
        '7. Ночью чат работает тише: ограничения действуют с 23:00 до 07:30.',
        '8. За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
      ].join('\n'),
    );
  });

  it('uses the full shared rules limit for autofilled text', () => {
    const channelIds = ['channel-1', 'channel-2', 'channel-3'];
    const settings = chatSettingsSchema.parse({
      linkPolicy: 'ALERT_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: channelIds,
      russianProfanityFilterEnabled: true,
      commercialAdsFilterEnabled: true,
      antiDuplicateEnabled: true,
      antiSpamEnabled: true,
      messageCountLimitEnabled: true,
      maxMessageLengthEnabled: true,
      photoMessageCooldownEnabled: true,
      stickerMessageCooldownEnabled: true,
      photoMessagesEnabled: false,
      videoMessagesEnabled: false,
      fileMessagesEnabled: false,
      voiceMessagesEnabled: false,
      phoneNumbersEnabled: false,
      nightModeEnabled: true,
      linkWarnEnabled: true,
      textFiltersMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const text = buildRulesTextFromSettings({
      settings,
      domains: [],
      requiredSubscriptionChannels: channelIds.map((id, index) =>
        managedEntityHeaderSchema.parse({
          id,
          title: String.fromCharCode(1040 + index).repeat(520),
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      ),
    });

    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThanOrEqual(MAX_CHAT_RULES_TEXT_LENGTH);
    expect(text).toContain('За повторные нарушения бот может');
  });

  it.each([
    ['CORE_ONLY', 'Пожалуйста, без мата.'],
    ['BALANCED', 'Пожалуйста, без мата и грубой лексики.'],
    ['STRICT', 'Пожалуйста, без мата, грубой лексики и оскорблений.'],
  ] as const)('describes %s profanity sensitivity in published rules', (sensitivity, expected) => {
    const settings = chatSettingsSchema.parse({
      russianProfanityFilterEnabled: true,
      profanitySensitivity: sensitivity,
    });

    expect(
      buildRulesTextItemsFromSettings({
        settings,
        domains: [],
        requiredSubscriptionChannels: [],
      }),
    ).toContain(expected);
  });

  it('mentions repeated photos only when photo duplicate enforcement is active', () => {
    const baseSettings = chatSettingsSchema.parse({
      linkPolicy: 'ALERT_ONLY',
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: true,
    });
    const input = {
      domains: [],
      requiredSubscriptionChannels: [],
    };

    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: false },
      }),
    ).toContain('Не повторяйте одно и то же сообщение: бот среагирует после 1 дубля.');
    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: true },
        duplicatePhotoModerationMode: 'FULL',
      }),
    ).toContain(
      'Не отправляйте повторно одинаковые сообщения и фото: бот среагирует после 1 дубля.',
    );
    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: true },
        duplicatePhotoModerationMode: 'OBSERVE',
      }),
    ).toContain('Не повторяйте одно и то же сообщение: бот среагирует после 1 дубля.');
  });

  it('uses a fallback allowlist rule when allowed domains are empty', () => {
    const parsedSettings = chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      antiSpamEnabled: false,
      antiDuplicateEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      russianProfanityFilterEnabled: false,
      linkWarnEnabled: false,
      linkMuteEnabled: false,
      linkBanEnabled: false,
      textFiltersWarnEnabled: false,
      textFiltersMuteEnabled: false,
      textFiltersBanEnabled: false,
      photoMessagesEnabled: true,
      videoMessagesEnabled: true,
      fileMessagesEnabled: true,
      voiceMessagesEnabled: true,
      phoneNumbersEnabled: true,
    });
    const settings = {
      ...parsedSettings,
      thematicCodewordEnabled: true,
      thematicCodeword: 'Секрет',
      thematicFiltersWarnEnabled: true,
      thematicFiltersMuteEnabled: true,
      thematicFiltersBanEnabled: true,
    };

    expect(
      buildRulesTextFromSettings({
        settings,
        domains: [],
        requiredSubscriptionChannels: [],
      }),
    ).toBe(
      [
        'Правила чата:',
        '',
        '1. Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
      ].join('\n'),
    );
  });

  it('formats Russian duration labels for rules text', () => {
    expect(formatRulesHoursLabel(1)).toBe('час');
    expect(formatRulesHoursLabel(2)).toBe('часа');
    expect(formatRulesHoursLabel(5)).toBe('часов');
    expect(formatRulesHoursLabel(11)).toBe('часов');
    expect(formatRulesHoursLabel(21)).toBe('час');

    expect(formatRulesMinutesLabel(1)).toBe('минуту');
    expect(formatRulesMinutesLabel(2)).toBe('минуты');
    expect(formatRulesMinutesLabel(5)).toBe('минут');
    expect(formatRulesMinutesLabel(11)).toBe('минут');
    expect(formatRulesMinutesLabel(21)).toBe('минуту');
  });

  it('formats list previews, conjunctions, duplicate labels, and clock time', () => {
    expect(formatRulesPreviewList([' Канал ', 'Канал', '', 'Чат', 'Новости'], 2)).toBe(
      'Канал, Чат и ещё 1',
    );
    expect(formatRulesConjunctionList([])).toBe('');
    expect(formatRulesConjunctionList(['предупредить'])).toBe('предупредить');
    expect(formatRulesConjunctionList(['предупредить', 'заблокировать'])).toBe(
      'предупредить и заблокировать',
    );
    expect(formatRulesConjunctionList(['предупредить', 'ограничить', 'заблокировать'])).toBe(
      'предупредить, ограничить и заблокировать',
    );
    expect(formatRulesDuplicateAllowanceLabel(0)).toBe('с первого дубля');
    expect(formatRulesDuplicateAllowanceLabel(1)).toBe('после 1 дубля');
    expect(formatRulesDuplicateAllowanceLabel(3)).toBe('после 3 дублей');
    expect(formatRulesTime(-10)).toBe('00:00');
    expect(formatRulesTime(9 * 60 + 4)).toBe('09:04');
    expect(formatRulesTime(24 * 60)).toBe('23:59');
  });

  it('resolves duplicate allowance from the first enabled duplicate sanction', () => {
    expect(
      resolveRulesDuplicateAllowedCount({
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 4,
        duplicateMuteMaxCount: 8,
        duplicateBanMaxCount: 12,
      }),
    ).toBe(3);

    expect(
      resolveRulesDuplicateAllowedCount({
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 4,
        duplicateMuteMaxCount: 8,
        duplicateBanMaxCount: 12,
      }),
    ).toBe(6);
  });

  it('summarizes enabled sanctions in rules text order', () => {
    const emptySanctions = {
      linkWarnEnabled: false,
      requiredSubscriptionWarnEnabled: false,
      textFiltersWarnEnabled: false,
      messageLimitsWarnEnabled: false,
      duplicateWarnEnabled: false,
      linkMuteEnabled: false,
      requiredSubscriptionMuteEnabled: false,
      textFiltersMuteEnabled: false,
      messageLimitsMuteEnabled: false,
      duplicateMuteEnabled: false,
      linkBanEnabled: false,
      requiredSubscriptionBanEnabled: false,
      textFiltersBanEnabled: false,
      messageLimitsBanEnabled: false,
      duplicateBanEnabled: false,
    };

    expect(buildRulesSanctionsSummary(emptySanctions)).toBeNull();
    expect(
      buildRulesSanctionsSummary({
        ...emptySanctions,
        linkWarnEnabled: true,
        duplicateMuteEnabled: true,
        textFiltersBanEnabled: true,
      }),
    ).toBe(
      'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    );
  });
});
