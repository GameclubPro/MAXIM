import {
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
} from './max-member-error.util';

const sendAttempts = new WeakSet<object>();
export function wasMaxMessageSendAttempted(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && sendAttempts.has(error));
}
export function markMaxMessageSendAttempted(error: unknown): unknown {
  const marked = error && typeof error === 'object' ? error : new Error(String(error));
  sendAttempts.add(marked);
  return marked;
}

// FLAG: Error text never proves absence of an effect after an ambiguous mutation.
export function isMaxMutationOutcomeAmbiguous(error: unknown, requireAttempt = false): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  if (wasMaxMemberMutationConfirmed(error)) return true;
  const attempted = wasMaxMemberMutationAttempted(error) || wasMaxMessageSendAttempted(error);
  if (requireAttempt && !attempted)
    return error instanceof Error && error.message.toLowerCase().includes('ambiguous max');
  if (status === 408 || (typeof status === 'number' && status >= 500)) return true;
  if (attempted && status == null) return true;
  return error instanceof Error && error.message.toLowerCase().includes('ambiguous max');
}
