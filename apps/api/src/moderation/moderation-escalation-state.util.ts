const MODERATION_ESCALATION_COUNTER_PREFIX = 'moderation:violation-count:v1';

function normalizeKeyPart(value: string): string {
  return encodeURIComponent(value.trim());
}

export function buildModerationEscalationCounterKey(params: {
  chatId: string;
  userId: string;
  ruleKey: string;
  windowSec: number;
}): string {
  return [
    MODERATION_ESCALATION_COUNTER_PREFIX,
    normalizeKeyPart(params.chatId),
    normalizeKeyPart(params.userId),
    normalizeKeyPart(params.ruleKey),
    String(Math.max(1, Math.trunc(params.windowSec))),
  ].join(':');
}

export function buildModerationEscalationCounterPattern(chatId: string, userId: string): string {
  return `${MODERATION_ESCALATION_COUNTER_PREFIX}:${normalizeKeyPart(chatId)}:${normalizeKeyPart(userId)}:*`;
}
