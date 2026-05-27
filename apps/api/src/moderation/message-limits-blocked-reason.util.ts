type BlockedListRuleCode = 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';

export function isMessageLimitsBlockedListRuleCode(ruleCode: string): ruleCode is BlockedListRuleCode {
  return ruleCode === 'MESSAGE_BLOCKED_WORD' || ruleCode === 'MESSAGE_BLOCKED_DOMAIN';
}

export function buildMessageLimitsBlockedReason(
  ruleCode: BlockedListRuleCode,
  blockedValue?: string | null,
): string {
  if (ruleCode === 'MESSAGE_BLOCKED_DOMAIN') {
    return blockedValue ? `запрещенный домен: ${blockedValue}` : 'домен из стоп-листа';
  }

  return blockedValue ? `стоп-слово: ${blockedValue}` : 'слово из стоп-листа';
}

export function extractMessageLimitsBlockedToken(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  for (const key of ['blockedWord', 'blockedDomain'] as const) {
    const value = (metadata as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}
