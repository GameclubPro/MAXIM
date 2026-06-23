import type { ChatSettings } from '@maxim/contracts';

export function buildRulesSanctionsSummary(
  settings: Pick<
    ChatSettings,
    | 'linkWarnEnabled'
    | 'requiredSubscriptionWarnEnabled'
    | 'textFiltersWarnEnabled'
    | 'thematicFiltersWarnEnabled'
    | 'messageLimitsWarnEnabled'
    | 'duplicateWarnEnabled'
    | 'linkMuteEnabled'
    | 'requiredSubscriptionMuteEnabled'
    | 'textFiltersMuteEnabled'
    | 'thematicFiltersMuteEnabled'
    | 'messageLimitsMuteEnabled'
    | 'duplicateMuteEnabled'
    | 'linkBanEnabled'
    | 'requiredSubscriptionBanEnabled'
    | 'textFiltersBanEnabled'
    | 'thematicFiltersBanEnabled'
    | 'messageLimitsBanEnabled'
    | 'duplicateBanEnabled'
  >,
): string | null {
  const sanctions = new Set<string>();

  if (
    settings.linkWarnEnabled ||
    settings.requiredSubscriptionWarnEnabled ||
    settings.textFiltersWarnEnabled ||
    settings.thematicFiltersWarnEnabled ||
    settings.messageLimitsWarnEnabled ||
    settings.duplicateWarnEnabled
  ) {
    sanctions.add('предупредить');
  }

  if (
    settings.linkMuteEnabled ||
    settings.requiredSubscriptionMuteEnabled ||
    settings.textFiltersMuteEnabled ||
    settings.thematicFiltersMuteEnabled ||
    settings.messageLimitsMuteEnabled ||
    settings.duplicateMuteEnabled
  ) {
    sanctions.add('временно ограничить сообщения');
  }

  if (
    settings.linkBanEnabled ||
    settings.requiredSubscriptionBanEnabled ||
    settings.textFiltersBanEnabled ||
    settings.thematicFiltersBanEnabled ||
    settings.messageLimitsBanEnabled ||
    settings.duplicateBanEnabled
  ) {
    sanctions.add('заблокировать');
  }

  if (sanctions.size === 0) {
    return null;
  }

  return `За повторные нарушения бот может ${formatRulesConjunctionList([...sanctions])}.`;
}

export function resolveRulesDuplicateAllowedCount(
  settings: Pick<
    ChatSettings,
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateWarnMaxCount'
    | 'duplicateMuteMaxCount'
    | 'duplicateBanMaxCount'
  >,
): number {
  const firstThreshold = settings.duplicateWarnEnabled
    ? settings.duplicateWarnMaxCount
    : settings.duplicateMuteEnabled
      ? settings.duplicateMuteMaxCount
      : settings.duplicateBanEnabled
        ? settings.duplicateBanMaxCount
        : settings.duplicateWarnMaxCount;
  const duplicateThresholdOffset =
    (settings.duplicateBotMessageEnabled ? 2 : 1) +
    (settings.duplicateWarnEnabled ? 1 : 0) +
    (settings.duplicateMuteEnabled ? 1 : 0);
  const allowedCountMax = Math.max(0, 20 - duplicateThresholdOffset);

  return Math.max(
    0,
    Math.min(allowedCountMax, firstThreshold - (settings.duplicateBotMessageEnabled ? 2 : 1)),
  );
}

export function formatRulesDuplicateAllowanceLabel(count: number): string {
  if (count === 0) {
    return 'с первого дубля';
  }

  if (count === 1) {
    return 'после 1 дубля';
  }

  return `после ${count} дублей`;
}

export function formatRulesPreviewList(values: readonly string[], limit: number): string {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const visible = uniqueValues.slice(0, limit);
  const remaining = uniqueValues.length - visible.length;
  if (remaining <= 0) {
    return visible.join(', ');
  }

  return `${visible.join(', ')} и ещё ${remaining}`;
}

export function formatRulesConjunctionList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  if (values.length === 2) {
    return `${values[0]} и ${values[1]}`;
  }

  return `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;
}

export function formatRulesHoursLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'час';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'часа';
  }

  return 'часов';
}

export function formatRulesMinutesLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'минуту';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'минуты';
  }

  return 'минут';
}

export function formatRulesTime(minutes: number): string {
  const totalMinutes = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, '0');
  const mins = (totalMinutes % 60).toString().padStart(2, '0');
  return `${hours}:${mins}`;
}
