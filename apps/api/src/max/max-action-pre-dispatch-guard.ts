export const MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_member_pre_dispatch_guard_rejected';
export const MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_delete_pre_dispatch_guard_rejected';
export const MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_edit_pre_dispatch_guard_rejected';
export const MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_send_pre_dispatch_guard_rejected';

const rejectedGuardErrors = new WeakSet<object>();
const finalAuthorityCheckpointGuards = new WeakSet<object>();

type FinalAuthorityGuard = (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;

// FLAG: Opt in only when the guard calls the checkpoint exactly once after remote
// preparation, before its final authority permit. Legacy callbacks retain their order.
export function withMaxFinalAuthorityCheckpoint<T extends FinalAuthorityGuard>(
  guard: T,
  enabled = true,
): T {
  if (enabled) finalAuthorityCheckpointGuards.add(guard);
  return guard;
}

export function usesMaxFinalAuthorityCheckpoint(guard: unknown): boolean {
  return typeof guard === 'function' && finalAuthorityCheckpointGuards.has(guard);
}

export function markMaxPreDispatchGuardRejected(error: unknown, fallbackCode: string): unknown {
  if (error && typeof error === 'object') {
    const existingCode = (error as { code?: unknown }).code;
    rejectedGuardErrors.add(error);
    if (typeof existingCode === 'string' && existingCode.trim()) {
      return error;
    }
    try {
      Object.defineProperty(error, 'code', {
        configurable: true,
        enumerable: false,
        value: fallbackCode,
        writable: true,
      });
      return error;
    } catch {
      // Frozen errors need a coded wrapper so the durable ledger can classify the failure.
    }
  }

  const wrapped = new Error(error instanceof Error ? error.message : String(error), {
    cause: error,
  }) as Error & { code: string };
  wrapped.name = 'MaxPreDispatchGuardRejectedError';
  wrapped.code = fallbackCode;
  rejectedGuardErrors.add(wrapped);
  return wrapped;
}

export function wasMaxPreDispatchGuardRejected(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && rejectedGuardErrors.has(error));
}
