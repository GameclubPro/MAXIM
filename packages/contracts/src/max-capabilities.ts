// FLAG: MAX retires POST /chats/{chatId}/members without a documented replacement.
export const MAX_MEMBER_RESTORE_RETIRES_AT = Date.parse('2026-09-30T00:00:00+03:00');

export function isMaxMemberRestoreAvailable(at = Date.now()): boolean {
  return Number.isFinite(at) && at < MAX_MEMBER_RESTORE_RETIRES_AT;
}
