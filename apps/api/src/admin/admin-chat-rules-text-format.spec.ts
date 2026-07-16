import { chatSettingsSchema, managedEntityHeaderSchema } from '@maxim/contracts';
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
      antiDuplicateEnabled: true,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 3,
      messageCountLimitWindowHours: 2,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 7 * 60 + 30,
      linkWarnEnabled: true,
      duplicateMuteEnabled: true,
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
