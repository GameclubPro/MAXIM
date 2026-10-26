import type { ChatSettings } from '@maxim/contracts/settings';

export type DuplicatePhotoScope = ChatSettings['duplicatePhotoScope'];

export const DUPLICATE_PHOTO_SCOPE_OPTIONS: Array<{ value: DuplicatePhotoScope; label: string }> = [
  { value: 'SAME_AUTHOR', label: 'Одного участника' },
  { value: 'CHAT', label: 'Всех участников' },
];

export function formatDuplicatePhotoScopeSummary(scope: DuplicatePhotoScope | null): string {
  if (scope === 'CHAT') return 'Среди всех участников';
  if (scope === 'SAME_AUTHOR') return 'У одного участника';
  return 'Разные значения';
}
