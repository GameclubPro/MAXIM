import type { ChatSettings, DuplicatePhotoEffectivePolicy } from '@maxim/contracts/settings';

export type DuplicatePhotoMatchPreset = ChatSettings['duplicatePhotoMatchPreset'];
export type DuplicatePhotoScope = ChatSettings['duplicatePhotoScope'];

export const DUPLICATE_PHOTO_MATCH_OPTIONS: Array<{
  value: DuplicatePhotoMatchPreset;
  label: string;
}> = [
  {
    value: 'SAME_IMAGE',
    label: 'Та же картинка',
  },
  {
    value: 'MINOR_EDITS',
    label: 'С изменениями',
  },
];

export const DUPLICATE_PHOTO_SCOPE_OPTIONS: Array<{
  value: DuplicatePhotoScope;
  label: string;
}> = [
  {
    value: 'SAME_AUTHOR',
    label: 'У участника',
  },
  {
    value: 'CHAT',
    label: 'Во всём чате',
  },
];

export function formatDuplicatePhotoMatchPresetHint(
  preset: DuplicatePhotoMatchPreset,
  policy: DuplicatePhotoEffectivePolicy,
): string {
  if (policy.moderationMode === 'OFF') {
    return 'Серверная проверка фото выключена. Выбранный режим можно сохранить заранее.';
  }
  const enforcementActive =
    policy.moderationMode === 'DELETE_ONLY' || policy.moderationMode === 'FULL';
  if (enforcementActive && !policy.allowedMatchKinds.includes('pdq')) {
    return 'Действия применяются только к точным цифровым совпадениям. Изменённые версии остаются в наблюдении.';
  }
  return preset === 'SAME_IMAGE'
    ? 'Учитываются пересылка, сжатие и изменение размера.'
    : 'Дополнительно учитываются небольшая обрезка и цветокоррекция.';
}
