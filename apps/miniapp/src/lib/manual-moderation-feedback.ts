import type { ManualModerationActionResult } from '@maxim/contracts';
import { describeUserFacingError } from './user-facing-error';

export function describeManualModerationFeedback({
  action,
  message,
  muteDurationHours,
}: Pick<ManualModerationActionResult, 'action' | 'message' | 'muteDurationHours'>): string {
  // FLAG: Preserve removal-only and partial results; rewrite only matching, known outcomes.
  if (action === 'MUTE') {
    if (muteDurationHours !== null && message === `Мут включён на ${muteDurationHours} ч.`) {
      return `Сообщения ограничены на ${muteDurationHours} ч.`;
    }
    if (muteDurationHours === null && message === 'Мут включён без срока.') {
      return 'Сообщения ограничены без срока.';
    }
  }
  if (
    action === 'UNMUTE' &&
    message === 'Мут снят. Автоматическое удаление новых сообщений остановлено.'
  ) {
    return 'Ограничение снято. Участник снова может писать.';
  }
  if (action === 'BAN') {
    if (message === 'Бан включён.') return 'Участник заблокирован.';
    if (message === 'Бан уже включён.') return 'Участник уже заблокирован.';
  }
  return describeUserFacingError(new Error(message), 'Действие выполнено.');
}
