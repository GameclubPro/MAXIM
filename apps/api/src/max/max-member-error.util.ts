const MAX_INSUFFICIENT_RIGHTS_MESSAGE_FRAGMENTS = [
  'insufficient rights',
  'not enough rights',
  'does not have sufficient rights',
  "doesn't have sufficient rights",
  'do not have sufficient rights',
  "don't have sufficient rights",
  'does not have enough rights',
  "doesn't have enough rights",
  'do not have enough rights',
  "don't have enough rights",
] as const;

const maxMemberMutationAttemptedErrors = new WeakSet<object>();
const maxMemberMutationConfirmedErrors = new WeakSet<object>();

export function hasMaxInsufficientRightsMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return MAX_INSUFFICIENT_RIGHTS_MESSAGE_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

export function wasMaxMemberMutationAttempted(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && maxMemberMutationAttemptedErrors.has(error));
}

export function markMaxMemberMutationAttempted(error: unknown): unknown {
  if (error && typeof error === 'object') {
    maxMemberMutationAttemptedErrors.add(error);
    return error;
  }
  const wrapped = new Error(String(error));
  maxMemberMutationAttemptedErrors.add(wrapped);
  return wrapped;
}

export function wasMaxMemberMutationConfirmed(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && maxMemberMutationConfirmedErrors.has(error));
}

export function markMaxMemberMutationConfirmed(error: unknown): unknown {
  const attemptedError = markMaxMemberMutationAttempted(error);
  maxMemberMutationConfirmedErrors.add(attemptedError as object);
  return attemptedError;
}
