import {
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
      thematicFiltersWarnEnabled: false,
      messageLimitsWarnEnabled: false,
      duplicateWarnEnabled: false,
      linkMuteEnabled: false,
      requiredSubscriptionMuteEnabled: false,
      textFiltersMuteEnabled: false,
      thematicFiltersMuteEnabled: false,
      messageLimitsMuteEnabled: false,
      duplicateMuteEnabled: false,
      linkBanEnabled: false,
      requiredSubscriptionBanEnabled: false,
      textFiltersBanEnabled: false,
      thematicFiltersBanEnabled: false,
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
