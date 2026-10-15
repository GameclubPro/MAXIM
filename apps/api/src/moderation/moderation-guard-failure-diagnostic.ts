export type ModerationGuardFailureBoundary =
  | 'required_subscription_sanction_authorize'
  | 'required_subscription_sanction_mutation'
  | 'required_subscription_sanction_notice'
  | 'duplicate_sanction_initial'
  | 'duplicate_sanction_final';

export type ModerationGuardProofFailure =
  | 'own_delete_binding_unproven'
  | 'own_delete_sanction_receipt_unproven';

type Diagnostic = Readonly<{
  guardBoundary: ModerationGuardFailureBoundary;
  guardProofFailure?: ModerationGuardProofFailure;
}>;

const failures = new WeakMap<object, Diagnostic>();

// FLAG: These closed labels describe the failing check, never absence of prior effects.
// Retain the original error and first boundary, including on frozen errors; no identity,
// payload, retry permission or mutation authority is stored or changed.
export function recordModerationGuardFailure(
  error: unknown,
  boundary: ModerationGuardFailureBoundary,
  proofFailure?: ModerationGuardProofFailure,
): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  const previous = failures.get(error);
  if (previous && (previous.guardBoundary !== boundary || previous.guardProofFailure)) return;
  failures.set(
    error,
    Object.freeze({
      guardBoundary: boundary,
      ...(proofFailure ? { guardProofFailure: proofFailure } : {}),
    }),
  );
}

export function readModerationGuardFailure(error: unknown): Diagnostic | undefined {
  return error && (typeof error === 'object' || typeof error === 'function')
    ? failures.get(error)
    : undefined;
}
