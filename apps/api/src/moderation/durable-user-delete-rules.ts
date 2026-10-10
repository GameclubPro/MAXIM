import { CLOSED_CHAT_DELETE_RULE_CODES } from './closed-chat-delete-guard.service';
import { MODERATION_STATE_DELETE_RULES } from './moderation-state-delete-guard.service';
import { MESSAGE_LIMITS_GUARDED_RULES } from './message-limits-delete-guard.service';
import { STOP_WORDS_DELETE_RULE_CODES } from './stop-words/stop-words-delete-guard.service';
import { PROFANITY_DELETE_RULE_CODE } from './profanity/profanity-delete-guard.service';
import { COMMERCIAL_TEXT_DELETE_RULE_CODE } from './commercial/commercial-delete-binding';
import { LINK_BLOCKED_DELETE_RULE_CODE } from './link-history-recovery.util';
import { TRAFFIC_PROTECTION_DELETE_RULE_CODES } from './traffic-protection';

// FLAG: These current-policy user-message guards own durable execution in every chat.
// Keep admission, loaded-intent eligibility and the indexed due sweep on this exact set.
// This does not enable a chat feature, duplicates, OCR, retention or legacy cleanup recovery.
export const DURABLE_USER_DELETE_RULES: ReadonlySet<string> = new Set([
  ...CLOSED_CHAT_DELETE_RULE_CODES,
  ...MODERATION_STATE_DELETE_RULES,
  ...MESSAGE_LIMITS_GUARDED_RULES,
  ...STOP_WORDS_DELETE_RULE_CODES,
  ...TRAFFIC_PROTECTION_DELETE_RULE_CODES,
  PROFANITY_DELETE_RULE_CODE,
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  LINK_BLOCKED_DELETE_RULE_CODE,
]);
