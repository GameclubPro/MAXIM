import type {
  ChatSettings,
  DuplicatePhotoActionCeiling,
  DuplicatePhotoEffectivePolicy,
  DuplicatePhotoModerationMode,
  DuplicatePhotoPolicyMatrix,
} from '@maxim/contracts/settings';

export type DuplicatePhotoSanctionSettings = Pick<
  ChatSettings,
  'duplicateWarnEnabled' | 'duplicateMuteEnabled' | 'duplicateBanEnabled'
>;

export function formatDuplicatePhotoCoverageLabel(
  textLabel: string,
  photoEnabled: boolean,
  policy: DuplicatePhotoEffectivePolicy,
  settings?: DuplicatePhotoSanctionSettings,
): string {
  if (!photoEnabled) {
    return `Текст: ${textLabel}`;
  }

  switch (policy.moderationMode) {
    case 'OFF':
      return `Текст: ${textLabel} • фото неактивно`;
    case 'OBSERVE':
      return `Текст: ${textLabel} • фото: наблюдение`;
    case 'DELETE_ONLY':
      return `Текст: ${textLabel} • фото: ${formatPhotoMatchCoverage(policy)}удаление`;
    case 'FULL': {
      const enabledSanctions = resolveEnabledPhotoSanctions(settings, policy.actionCeiling);
      const highestEnabledSanction = enabledSanctions[enabledSanctions.length - 1];
      return `Текст: ${textLabel} • фото: ${formatPhotoMatchCoverage(policy)}${formatPhotoCoverageAction(highestEnabledSanction)}`;
    }
  }
}

export function resolveDuplicatePhotoPolicyForDraft(
  matrix: DuplicatePhotoPolicyMatrix | undefined,
  legacyMode: DuplicatePhotoModerationMode,
  preset: ChatSettings['duplicatePhotoMatchPreset'],
  scope: ChatSettings['duplicatePhotoScope'],
  savedSelection?: Pick<ChatSettings, 'duplicatePhotoMatchPreset' | 'duplicatePhotoScope'>,
): DuplicatePhotoEffectivePolicy {
  if (matrix) {
    return preset === 'SAME_IMAGE' && scope === 'SAME_AUTHOR' ? matrix.base : matrix.advanced;
  }

  if (
    savedSelection &&
    (preset !== savedSelection.duplicatePhotoMatchPreset ||
      scope !== savedSelection.duplicatePhotoScope)
  ) {
    return {
      moderationMode: 'OBSERVE',
      actionCeiling: 'DELETE_MESSAGE',
      allowedMatchKinds: [],
    };
  }

  return {
    moderationMode: legacyMode,
    actionCeiling: legacyMode === 'FULL' ? 'BAN' : 'DELETE_MESSAGE',
    allowedMatchKinds:
      legacyMode === 'DELETE_ONLY' || legacyMode === 'FULL' ? ['canonical_sha256'] : [],
  };
}

export function formatDuplicatePhotoModerationHint(
  policy: DuplicatePhotoEffectivePolicy,
  settings?: DuplicatePhotoSanctionSettings,
): string {
  const perceptualActionsEnabled = policy.allowedMatchKinds.includes('pdq');
  const deletionScope = perceptualActionsEnabled
    ? 'Совпадения фото по выбранному режиму удаляются.'
    : 'Точные дубли фото удаляются.';
  const matchScope = perceptualActionsEnabled
    ? ''
    : ' Изменённые варианты остаются в наблюдении без действий.';

  switch (policy.moderationMode) {
    case 'OFF':
      return 'Проверка фото сейчас выключена на сервере. Настройку можно сохранить, но фото не проверяются.';
    case 'OBSERVE':
      return 'Бот только фиксирует совпадения для проверки. Фото не удаляются, санкции не применяются.';
    case 'DELETE_ONLY':
      return `${deletionScope} Предупреждение, ограничение и блокировка для фото выключены.${matchScope}`;
    case 'FULL': {
      const sanctions = resolveEnabledPhotoSanctions(settings, policy.actionCeiling);
      const sanctionSummary =
        sanctions.length > 0
          ? `Для фото включены: ${sanctions.map(formatPhotoActionCeiling).join(', ')}.`
          : 'Дополнительные санкции для фото выключены или недоступны при текущем серверном лимите.';
      return `${deletionScope} ${sanctionSummary}${matchScope}`;
    }
  }
}

type DuplicateActionSummarySettings = Pick<
  ChatSettings,
  | 'duplicatePhotoEnabled'
  | 'duplicateBotMessageEnabled'
  | 'duplicateWarnEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateBanEnabled'
  | 'duplicateMuteDurationHours'
>;

export function formatDuplicateActionSummary(
  settings: DuplicateActionSummarySettings,
  allowedCount: number,
  photoPolicy: DuplicatePhotoEffectivePolicy,
): string {
  const firstRemovedDuplicate = Math.max(1, Math.round(allowedCount) + 1);
  let sanctionDuplicate = firstRemovedDuplicate + (settings.duplicateBotMessageEnabled ? 1 : 0);
  const textSanctions: string[] = [];
  if (settings.duplicateWarnEnabled) {
    textSanctions.push(`предупреждение с №${sanctionDuplicate}`);
    sanctionDuplicate += 1;
  }
  if (settings.duplicateMuteEnabled) {
    textSanctions.push(
      `ограничение на ${Math.max(1, Math.round(settings.duplicateMuteDurationHours))} ч с №${sanctionDuplicate}`,
    );
    sanctionDuplicate += 1;
  }
  if (settings.duplicateBanEnabled) {
    textSanctions.push(`блокировка с №${sanctionDuplicate}`);
  }

  const textParts = [`Текст удаляется с дубля №${firstRemovedDuplicate}.`];
  if (settings.duplicateBotMessageEnabled) {
    textParts.push('Бот объясняет первое удаление.');
  }
  textParts.push(
    textSanctions.length > 0
      ? `Санкции: ${textSanctions.join('; ')}.`
      : 'Дополнительные санкции выключены.',
  );

  if (!settings.duplicatePhotoEnabled) {
    return textParts.join(' ');
  }
  if (photoPolicy.moderationMode === 'OFF') {
    return `${textParts.join(' ')} Фото: проверка выключена.`;
  }
  if (photoPolicy.moderationMode === 'OBSERVE') {
    return `${textParts.join(' ')} Фото: только наблюдение, без действий.`;
  }

  const photoSanctions =
    photoPolicy.moderationMode === 'FULL'
      ? resolveEnabledPhotoSanctions(settings, photoPolicy.actionCeiling)
      : [];
  const photoMatchLabel = photoPolicy.allowedMatchKinds.includes('pdq')
    ? 'Выбранные совпадения фото'
    : 'Точные дубли фото';
  const photoParts = [`${photoMatchLabel} удаляются с дубля №${firstRemovedDuplicate}.`];
  if (settings.duplicateBotMessageEnabled) {
    photoParts.push('Объяснение удаления включено.');
  }
  photoParts.push(
    photoSanctions.length > 0
      ? `Санкции для фото: ${photoSanctions.map(formatPhotoActionCeiling).join(', ')}.`
      : 'Санкции для фото выключены.',
  );

  return `${textParts.join(' ')} ${photoParts.join(' ')}`;
}

const PHOTO_ACTION_RANK: Record<DuplicatePhotoActionCeiling, number> = {
  DELETE_MESSAGE: 0,
  WARN: 1,
  MUTE: 2,
  BAN: 3,
};

function resolveEnabledPhotoSanctions(
  settings: DuplicatePhotoSanctionSettings | undefined,
  ceiling: DuplicatePhotoActionCeiling,
): Exclude<DuplicatePhotoActionCeiling, 'DELETE_MESSAGE'>[] {
  if (!settings) {
    return [];
  }
  const ceilingRank = PHOTO_ACTION_RANK[ceiling];
  return [
    settings.duplicateWarnEnabled && ceilingRank >= PHOTO_ACTION_RANK.WARN
      ? ('WARN' as const)
      : null,
    settings.duplicateMuteEnabled && ceilingRank >= PHOTO_ACTION_RANK.MUTE
      ? ('MUTE' as const)
      : null,
    settings.duplicateBanEnabled && ceilingRank >= PHOTO_ACTION_RANK.BAN ? ('BAN' as const) : null,
  ].filter(
    (action): action is Exclude<DuplicatePhotoActionCeiling, 'DELETE_MESSAGE'> => action !== null,
  );
}

function formatPhotoActionCeiling(ceiling: DuplicatePhotoActionCeiling): string {
  switch (ceiling) {
    case 'DELETE_MESSAGE':
      return 'только удаление';
    case 'WARN':
      return 'предупреждение';
    case 'MUTE':
      return 'ограничение отправки';
    case 'BAN':
      return 'блокировка';
  }
}

function formatPhotoCoverageAction(
  action: Exclude<DuplicatePhotoActionCeiling, 'DELETE_MESSAGE'> | undefined,
): string {
  switch (action) {
    case 'WARN':
      return 'до предупреждения';
    case 'MUTE':
      return 'до ограничения';
    case 'BAN':
      return 'до блокировки';
    default:
      return 'удаление';
  }
}

function formatPhotoMatchCoverage(policy: DuplicatePhotoEffectivePolicy): string {
  return policy.allowedMatchKinds.includes('pdq') ? '' : 'только точные, ';
}
