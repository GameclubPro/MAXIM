import { readUserIdFromInitData } from './init-data';

type FullInitDataCredential = {
  value: string;
  userId: string;
  authDate: number;
};

type RejectedCredential = {
  value: string;
  userId: string | null;
  authDate: number | null;
};

export type AuthSessionEvent =
  | { type: 'locked'; userId: string | null }
  | { type: 'recovered'; userId: string };

export type AuthSessionCoordinator = {
  observeInitData: (initData: string) => boolean;
  markUnauthorized: (initData: string) => boolean;
  isBlocked: (initData: string) => boolean;
  hasPendingRecovery: (initData: string) => boolean;
  waitForPendingRecovery: (initData: string) => Promise<void>;
  recoverAfterUnauthorized: (
    initData: string,
    readReplacement: () => Promise<string>,
  ) => Promise<string>;
  subscribe: (listener: (event: AuthSessionEvent) => void) => () => void;
  getSnapshot: () => { blocked: boolean; userId: string | null; recovering: boolean };
};

function parseFullInitData(initData: string): FullInitDataCredential | null {
  const value = initData.trim();
  if (!value) {
    return null;
  }

  const params = new URLSearchParams(value);
  const authDateValue = params.get('auth_date')?.trim() ?? '';
  const hash = params.get('hash')?.trim() ?? '';
  const authDate = Number(authDateValue);
  const userId = readUserIdFromInitData(value);
  if (!userId || !hash || !/^\d+$/u.test(authDateValue) || !Number.isSafeInteger(authDate)) {
    return null;
  }

  return { value, userId, authDate };
}

function isFreshReplacement(
  rejected: RejectedCredential,
  candidate: FullInitDataCredential,
): boolean {
  return (
    rejected.userId !== null &&
    candidate.userId === rejected.userId &&
    candidate.value !== rejected.value &&
    (rejected.authDate === null || candidate.authDate >= rejected.authDate)
  );
}

export function createAuthSessionCoordinator(initialInitData = ''): AuthSessionCoordinator {
  let currentCredential = parseFullInitData(initialInitData);
  let rejectedCredential: RejectedCredential | null = null;
  let pendingRecovery: { value: string; promise: Promise<string> } | null = null;
  const listeners = new Set<(event: AuthSessionEvent) => void>();

  const emit = (event: AuthSessionEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  const observeInitData = (initData: string): boolean => {
    const candidate = parseFullInitData(initData);
    if (!candidate) {
      return false;
    }

    if (rejectedCredential) {
      if (!isFreshReplacement(rejectedCredential, candidate)) {
        return false;
      }

      rejectedCredential = null;
      currentCredential = candidate;
      emit({ type: 'recovered', userId: candidate.userId });
      return true;
    }

    if (
      !currentCredential ||
      (currentCredential.userId === candidate.userId &&
        candidate.authDate >= currentCredential.authDate)
    ) {
      currentCredential = candidate;
    }
    return false;
  };

  const markUnauthorized = (initData: string): boolean => {
    const value = initData.trim();
    const parsed = parseFullInitData(value);
    if (
      parsed &&
      currentCredential &&
      currentCredential.userId === parsed.userId &&
      currentCredential.value !== parsed.value &&
      currentCredential.authDate >= parsed.authDate
    ) {
      return false;
    }

    const nextRejected: RejectedCredential = {
      value,
      userId: parsed?.userId ?? currentCredential?.userId ?? null,
      authDate: parsed?.authDate ?? null,
    };
    const changed =
      !rejectedCredential ||
      rejectedCredential.value !== nextRejected.value ||
      rejectedCredential.userId !== nextRejected.userId;
    rejectedCredential = nextRejected;
    if (changed) {
      emit({ type: 'locked', userId: nextRejected.userId });
    }
    return changed;
  };

  const isBlocked = (initData: string): boolean => {
    observeInitData(initData);
    return rejectedCredential !== null;
  };

  const hasPendingRecovery = (initData: string): boolean =>
    Boolean(pendingRecovery && pendingRecovery.value === initData.trim());

  const waitForPendingRecovery = async (initData: string): Promise<void> => {
    if (pendingRecovery?.value === initData.trim()) {
      await pendingRecovery.promise;
    }
  };

  const recoverAfterUnauthorized = async (
    initData: string,
    readReplacement: () => Promise<string>,
  ): Promise<string> => {
    const rejectedValue = initData.trim();
    if (rejectedCredential?.value === rejectedValue) {
      return '';
    }

    const rejected = parseFullInitData(rejectedValue);
    if (
      rejected &&
      currentCredential &&
      isFreshReplacement(
        { value: rejected.value, userId: rejected.userId, authDate: rejected.authDate },
        currentCredential,
      )
    ) {
      return currentCredential.value;
    }

    if (pendingRecovery?.value === rejectedValue) {
      return pendingRecovery.promise;
    }

    const recoveryPromise = (async () => {
      const replacementValue = (await readReplacement()).trim();
      const replacement = parseFullInitData(replacementValue);
      const rejectedIdentity: RejectedCredential = {
        value: rejectedValue,
        userId: rejected?.userId ?? currentCredential?.userId ?? null,
        authDate: rejected?.authDate ?? null,
      };
      if (replacement && isFreshReplacement(rejectedIdentity, replacement)) {
        currentCredential = replacement;
        return replacement.value;
      }

      markUnauthorized(rejectedValue);
      return '';
    })();
    pendingRecovery = { value: rejectedValue, promise: recoveryPromise };

    try {
      return await recoveryPromise;
    } finally {
      if (pendingRecovery?.promise === recoveryPromise) {
        pendingRecovery = null;
      }
    }
  };

  return {
    observeInitData,
    markUnauthorized,
    isBlocked,
    hasPendingRecovery,
    waitForPendingRecovery,
    recoverAfterUnauthorized,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return {
        blocked: rejectedCredential !== null,
        userId: rejectedCredential?.userId ?? currentCredential?.userId ?? null,
        recovering: pendingRecovery !== null,
      };
    },
  };
}
