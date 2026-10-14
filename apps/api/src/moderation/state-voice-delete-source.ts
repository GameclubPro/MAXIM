import type { Prisma } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { VOICE_SOURCE_LIFETIME_MS, type VoiceSourceInput } from './voice-webhook-source';

const STATE_VOICE_RULES = new Set([
  'MUTE_ACTIVE_DELETE',
  'NIGHT_MODE_DELETE',
  'MANUAL_GROUP_CLOSE_DELETE',
]);
type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// FLAG: This binding proves only the direct voice identity. Each state guard must still
// authorize its own current mute/closure, author, immunity and absolute deadline.
export function bindStateVoiceSource(
  intent: EnsureModerationDeleteIntentInput,
  source: VoiceSourceInput | null | undefined,
): EnsureModerationDeleteIntentInput {
  if (
    !STATE_VOICE_RULES.has(intent.ruleCode ?? '') ||
    source?.kind !== 'created' ||
    source.chatId !== intent.chatId ||
    source.messageId !== intent.messageId ||
    source.userId !== intent.subjectUserId ||
    source.sourceAtMs !== new Date(intent.sourceMessageAt ?? NaN).getTime()
  )
    return intent;
  return {
    ...intent,
    retryUntilAt: new Date(source.deadlineAtMs),
    event: {
      ...intent.event,
      metadata: {
        ...metadata(intent.event?.metadata),
        stateVoiceSourceVersion: 1,
        stateVoiceSourceRuleCode: intent.ruleCode,
        stateVoiceSourceAtMs: source.sourceAtMs,
        stateVoiceSourceDeadlineAtMs: source.deadlineAtMs,
      },
    },
  };
}

export function isStateVoiceReason(reason: Reason): boolean {
  return (
    STATE_VOICE_RULES.has(reason.ruleCode) &&
    metadata(reason.metadata).stateVoiceSourceVersion === 1
  );
}

// FLAG: Never turn a missing MAX GET into proof. Only atomic authenticated ingress
// evidence qualifies; edits/removals, conflicting mirrors and expiry revoke it.
// Re-read after awaited authority work. Do not lend it to history cleanup or content rules.
export async function readStateVoiceReasonKeys(
  prisma: Pick<Prisma.TransactionClient, 'moderationVoiceSource'>,
  params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    sourceMessageAt?: Date | null;
  },
  reasons: readonly Reason[],
): Promise<string[]> {
  const source = await prisma.moderationVoiceSource.findUnique({
    where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
  });
  const at = source?.sourceAt?.getTime();
  const deadline = source?.deadlineAt?.getTime();
  if (
    !source ||
    source.invalidatedAt ||
    !source.receiptId ||
    source.userId !== params.subjectUserId ||
    !at ||
    !deadline ||
    at !== params.sourceMessageAt?.getTime() ||
    deadline !== at + VOICE_SOURCE_LIFETIME_MS ||
    at > Date.now() + 1_000 ||
    Date.now() >= deadline
  )
    return [];
  return reasons
    .filter((reason) => {
      const proof = metadata(reason.metadata);
      return (
        isStateVoiceReason(reason) &&
        proof.stateVoiceSourceRuleCode === reason.ruleCode &&
        proof.stateVoiceSourceAtMs === at &&
        proof.stateVoiceSourceDeadlineAtMs === deadline &&
        proof.automaticMuteCleanupId === undefined
      );
    })
    .map((reason) => reason.reasonKey);
}
