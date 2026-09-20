import type {
  ChatSettings,
  DuplicatePhotoEffectivePolicy,
  DuplicatePhotoModerationMode,
  DuplicatePhotoPolicyMatrix,
} from '@maxim/contracts/settings';
import {
  formatDuplicateAllowanceLabel,
  resolveDuplicateAllowedCount,
} from './settings-duplicate-flow';

export type DuplicatePhotoPresentationPolicy = DuplicatePhotoEffectivePolicy;

export function formatDuplicateSettingsSummary(
  settings: ChatSettings | null,
  windowHours: number,
): string {
  if (!settings?.antiDuplicateEnabled) return 'Выключено';
  return `${formatDuplicateAllowanceLabel(resolveDuplicateAllowedCount(settings))} • ${windowHours} ч${settings.duplicateCompareMode !== 'TEXT' ? ' • картинки' : ''}`;
}

export function resolveDuplicatePhotoPresentationPolicy(
  policy: DuplicatePhotoEffectivePolicy,
): DuplicatePhotoPresentationPolicy {
  return {
    moderationMode:
      policy.moderationMode === 'FULL' && policy.allowedMatchKinds.includes('canonical_sha256')
        ? 'FULL'
        : 'OFF',
    actionCeiling: 'BAN',
    allowedMatchKinds: policy.allowedMatchKinds.includes('canonical_sha256')
      ? ['canonical_sha256']
      : [],
  };
}

export function resolveDuplicatePhotoPolicyForDraft(
  matrix: DuplicatePhotoPolicyMatrix | undefined,
  legacyMode: DuplicatePhotoModerationMode,
): DuplicatePhotoEffectivePolicy {
  return resolveDuplicatePhotoPresentationPolicy(
    matrix?.base ?? {
      moderationMode: legacyMode,
      actionCeiling: 'DELETE_MESSAGE',
      allowedMatchKinds:
        legacyMode === 'FULL' || legacyMode === 'DELETE_ONLY' ? ['canonical_sha256'] : [],
    },
  );
}

export function formatDuplicatePhotoCoverageLabel(
  textLabel: string,
  enabled: boolean,
  policy: DuplicatePhotoPresentationPolicy,
): string {
  return `Текст: ${textLabel}${enabled ? (policy.moderationMode === 'FULL' ? ' • одинаковые картинки: включены' : ' • картинки: недоступно') : ''}`;
}

export function formatDuplicatePhotoModerationHint(
  policy: DuplicatePhotoPresentationPolicy,
): string {
  return policy.moderationMode === 'FULL'
    ? 'Для одинаковых картинок действует общая цепочка антидубля. Подписи не учитываются; счётчик повторов отдельный для каждого участника.'
    : 'Удаление одинаковых картинок сейчас недоступно.';
}

export function formatDuplicateActionSummary(
  settings: Pick<
    ChatSettings,
    | 'duplicateCompareMode'
    | 'duplicateBotMessageEnabled'
    | 'duplicateWarnEnabled'
    | 'duplicateMuteEnabled'
    | 'duplicateBanEnabled'
    | 'duplicateMuteDurationHours'
  >,
  allowedCount: number,
  photoPolicy: DuplicatePhotoPresentationPolicy,
): string {
  const firstRemoved = Math.max(2, Math.round(allowedCount) + 2);
  let next = firstRemoved + (settings.duplicateBotMessageEnabled ? 1 : 0);
  const actions: string[] = [];
  if (settings.duplicateWarnEnabled) actions.push(`предупреждение с №${next++}`);
  if (settings.duplicateMuteEnabled)
    actions.push(
      `ограничение на ${Math.max(1, Math.round(settings.duplicateMuteDurationHours))} ч с №${next++}`,
    );
  if (settings.duplicateBanEnabled) actions.push(`блокировка с №${next}`);
  return [
    `Текст удаляется с сообщения №${firstRemoved}.`,
    settings.duplicateBotMessageEnabled ? 'Бот объясняет первое удаление.' : '',
    actions.length
      ? `Дальнейшие действия: ${actions.join('; ')}.`
      : 'Предупреждения и ограничения для текста выключены.',
    settings.duplicateCompareMode !== 'TEXT' ? formatDuplicatePhotoModerationHint(photoPolicy) : '',
  ]
    .filter(Boolean)
    .join(' ');
}
