export const MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_member_pre_dispatch_guard_rejected';
export const MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_delete_pre_dispatch_guard_rejected';
export const MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE = 'max_edit_pre_dispatch_guard_rejected';

const rejectedGuardErrors = new WeakSet<object>();

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
