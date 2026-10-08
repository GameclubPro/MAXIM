import type { ModerationRuleSanctionAuthority } from '../moderation/moderation-rule-sanction-authority';

export type MaxModerationRuleNoticeProof = ModerationRuleSanctionAuthority & { version: 1 };
export type MaxModerationRuleFollowupProof = { version: 1; id: string; issuedAtMs: number };

// FLAG: These pure readers share the transport's exact retained proof grammar.
// Parsing historical completed SEND lineage never grants fresh dispatch authority.
export function readMaxModerationRuleNoticeProof(
  value: unknown,
): MaxModerationRuleNoticeProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ['chatId', 'messageId', 'userId', 'reasonKey', 'ruleCode', 'policySha256'];
  if (
    row.version !== 1 ||
    Object.keys(row).length !== keys.length + 2 ||
    keys.some(
      (key) =>
        typeof row[key] !== 'string' ||
        !(row[key] as string).trim() ||
        (row[key] as string).length > 1_024,
    ) ||
    typeof row.policySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(row.policySha256) ||
    !Number.isSafeInteger(row.deadlineAtMs)
  )
    return null;
  return row as MaxModerationRuleNoticeProof;
}

export function readMaxModerationRuleFollowupProof(
  value: unknown,
): MaxModerationRuleFollowupProof | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    Object.keys(row).some((key) => !['version', 'id', 'issuedAtMs'].includes(key)) ||
    row.version !== 1 ||
    typeof row.id !== 'string' ||
    !row.id.trim() ||
    row.id.length > 256 ||
    !Number.isSafeInteger(row.issuedAtMs) ||
    (row.issuedAtMs as number) <= 0
  )
    return null;
  return row as MaxModerationRuleFollowupProof;
}
