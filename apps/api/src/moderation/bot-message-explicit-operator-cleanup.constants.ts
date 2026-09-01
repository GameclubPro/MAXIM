export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE = 'explicit_operator_cleanup';
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION = 5;
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON =
  'Explicit operator cleanup of a live bot-authored message';
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON_MIN_LENGTH = 8;
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON_MAX_LENGTH = 256;

export function isValidBotMessageExplicitOperatorCleanupReason(value: string): boolean {
  return (
    value.length >= BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON_MIN_LENGTH &&
    value.length <= BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON_MAX_LENGTH &&
    !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  );
}
