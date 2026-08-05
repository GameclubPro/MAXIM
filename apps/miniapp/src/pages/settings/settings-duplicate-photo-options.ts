import type { ChatSettings, DuplicatePhotoModerationMode } from '@maxim/contracts/settings';

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

export const DUPLICATE_PHOTO_MODERATION_HINTS: Record<DuplicatePhotoModerationMode, string> = {
  OFF: 'Проверка фото сейчас выключена на сервере. Настройку можно сохранить, но фото не проверяются.',
  OBSERVE:
    'Бот только фиксирует совпадения для проверки. Фото не удаляются, предупреждение, мут и бан не применяются.',
  DELETE_ONLY: 'Повторные фото удаляются. Предупреждение, мут и бан для фото не применяются.',
  FULL: 'Повторные фото удаляются, а предупреждение, мут и бан могут применяться по общей лестнице повторов.',
};
