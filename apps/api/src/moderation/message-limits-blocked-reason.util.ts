type BlockedListRuleCode = 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';

export const MESSAGE_LIMITS_BLOCKED_LIST_PUBLIC_REASON = 'такие сообщения запрещены в чате';

export function isMessageLimitsBlockedListRuleCode(
  ruleCode: string,
): ruleCode is BlockedListRuleCode {
  return ruleCode === 'MESSAGE_BLOCKED_WORD' || ruleCode === 'MESSAGE_BLOCKED_DOMAIN';
}

export function buildMessageLimitsBlockedReason(
  _ruleCode: BlockedListRuleCode,
  _blockedValue?: string | null,
): string {
  return MESSAGE_LIMITS_BLOCKED_LIST_PUBLIC_REASON;
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
