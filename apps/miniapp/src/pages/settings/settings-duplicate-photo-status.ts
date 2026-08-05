import type { DuplicatePhotoModerationMode } from '@maxim/contracts/settings';

export function formatDuplicatePhotoCoverageLabel(
  textLabel: string,
  mode: DuplicatePhotoModerationMode,
): string {
  switch (mode) {
    case 'OFF':
      return `${textLabel} • фото неактивно`;
    case 'OBSERVE':
      return `${textLabel} • фото: наблюдение`;
    case 'DELETE_ONLY':
      return `${textLabel} • фото: удаление`;
    case 'FULL':
      return `${textLabel} + фото`;
  }
}

export function formatDuplicatePhotoCardStatus(mode: DuplicatePhotoModerationMode): string {
  switch (mode) {
    case 'OFF':
      return 'Фото: неактивно';
    case 'OBSERVE':
      return 'Фото: наблюдение';
    case 'DELETE_ONLY':
      return 'Фото: удаление';
    case 'FULL':
      return 'Текст + фото';
  }
}
