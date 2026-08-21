export type NightModeNoticeTransition = 'close' | 'open';

export function buildNightModeNoticeIdempotencyKey(
  transition: NightModeNoticeTransition,
  chatId: string,
  sessionKey: string,
): string {
  return `night-mode:${transition}:${chatId.trim()}:session:${sessionKey.trim()}`;
}
