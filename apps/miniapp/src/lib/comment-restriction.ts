import type { CommentRestriction } from '@maxim/contracts/channel-dialog';

export function commentRestrictionLabel(restriction: CommentRestriction | undefined): string {
  if (restriction?.kind === 'BAN') return 'Бан без срока';
  if (restriction?.kind === 'MUTE' && restriction.expiresAt) {
    return `Мут до ${new Date(restriction.expiresAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  return 'Без ограничений';
}
