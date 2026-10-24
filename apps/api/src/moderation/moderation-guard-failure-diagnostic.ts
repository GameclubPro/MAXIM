export type ModerationGuardFailureBoundary =
  | 'required_subscription_sanction_authorize'
  | 'required_subscription_sanction_mutation'
  | 'required_subscription_sanction_notice'
  | 'duplicate_sanction_initial'
  | 'duplicate_sanction_final';

export type ModerationGuardProofFailure =
  | 'own_delete_binding_unproven'
  | 'own_delete_sanction_receipt_unproven';

export type ModerationGuardProofDetail =
  | 'receipt_missing'
  | 'delete_unconfirmed'
  | 'reason_missing'
  | 'reason_after_delete'
  | 'chat_mismatch'
  | 'message_mismatch'
  | 'subject_mismatch'
  | 'reason_unverified'
  | 'binding_invalid'
  | 'content_mismatch'
  | 'event_time_mismatch'
  | 'control_revision_mismatch'
  | 'settings_mismatch'
  | 'version_mismatch'
  | 'scope_mismatch'
  | 'lifecycle_revision_mismatch'
  | 'policy_revision_mismatch'
  | 'authorization_mismatch'
  | 'sanction_mismatch'
  | 'original_mismatch'
  | 'intent_mismatch'
  | 'receipt_unfinished'
  | 'executor_missing'
  | 'executor_mismatch'
  | 'executor_unregistered'
  | 'reason_key_mismatch'
  | 'reason_rule_mismatch'
  | 'reason_user_mismatch'
  | 'receipt_clock_invalid'
  | 'reason_clock_invalid'
  | 'receipt_clock_future'
  | 'binding_mismatch';

type Diagnostic = Readonly<{
  guardBoundary: ModerationGuardFailureBoundary;
  guardProofFailure?: ModerationGuardProofFailure;
  guardProofDetail?: ModerationGuardProofDetail;
}>;

const failures = new WeakMap<object, Diagnostic>();

// FLAG: These closed labels describe the failing check, never absence of prior effects.
// Retain the original error and first boundary, including on frozen errors; no identity,
// payload, retry permission or mutation authority is stored or changed.
export function recordModerationGuardFailure(
  error: unknown,
  boundary: ModerationGuardFailureBoundary,
  proofFailure?: ModerationGuardProofFailure,
  proofDetail?: ModerationGuardProofDetail,
): void {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return;
  const previous = failures.get(error);
  if (previous && (previous.guardBoundary !== boundary || previous.guardProofFailure)) return;
  failures.set(
    error,
    Object.freeze({
      guardBoundary: boundary,
      ...(proofFailure ? { guardProofFailure: proofFailure } : {}),
      ...(proofFailure && proofDetail ? { guardProofDetail: proofDetail } : {}),
    }),
  );
}

export function readModerationGuardFailure(error: unknown): Diagnostic | undefined {
  return error && (typeof error === 'object' || typeof error === 'function')
    ? failures.get(error)
    : undefined;
}
