import { UnrecoverableError } from 'bullmq';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import type { MaxActionJob } from './max-client.service';

const FEATURE_PROOF_KEYS = [
  'moderationRuleNotice',
  'requiredSubscriptionNotice',
  'duplicateNotice',
] as const;

export class MaxModerationNoticeEnvelopeRejectedError extends UnrecoverableError {
  readonly code = 'moderation_notice_legacy_envelope_unverified';
}

export function requiresMaxModerationNoticeEnvelope(
  action: Pick<MaxActionJob, 'actionType' | 'chatId' | 'sourceTag'>,
): boolean {
  return (
    action.actionType === 'SEND_MESSAGE' &&
    action.sourceTag === 'moderation_notice' &&
    !action.chatId.startsWith('user:') &&
    !isPrivateDirectChatId(action.chatId)
  );
}

export function assertMaxModerationNoticeEnvelope(action: MaxActionJob): void {
  const context = action.ledgerContext;
  const featureProofs = context
    ? FEATURE_PROOF_KEYS.filter((key) => Object.hasOwn(context, key))
    : [];
  // FLAG: One SEND belongs to one moderation feature. Sequential independent permits
  // would allow a later feature's awaited qualification to expire or invalidate an earlier one.
  if (featureProofs.length > 1) throw new MaxModerationNoticeEnvelopeRejectedError();
  if (!requiresMaxModerationNoticeEnvelope(action)) return;
  // FLAG: This marker identifies the compatible producer, not moderation permission.
  // Feature proofs retain their independent mandatory guards. Unbound legacy notices
  // may settle completed/unknown journals but cannot start a fresh group SEND.
  if (featureProofs.length === 1) return;
  const marker = context?.moderationNoticeEnvelope;
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    Object.keys(marker).length !== 1 ||
    marker.version !== 1
  )
    throw new MaxModerationNoticeEnvelopeRejectedError();
}
