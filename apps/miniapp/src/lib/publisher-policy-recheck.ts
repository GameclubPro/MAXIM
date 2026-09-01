export const PUBLISHER_POLICY_RECHECK_DELAYS_MS = [
  750, 1_250, 2_500, 4_500, 7_500, 10_500,
] as const;

export type PublisherPolicyRecheckBlocker = {
  canRecheck: boolean;
  checkedAt: string | null;
};

function abortError(): Error {
  const error = new Error('Publisher policy recheck was cancelled');
  error.name = 'AbortError';
  return error;
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const finish = () => {
      globalThis.clearTimeout(timeoutId);
      signal.removeEventListener('abort', cancel);
      resolve();
    };
    const cancel = () => {
      globalThis.clearTimeout(timeoutId);
      signal.removeEventListener('abort', cancel);
      reject(abortError());
    };
    const timeoutId = globalThis.setTimeout(finish, delayMs);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function retryPublisherPolicyEnablement<T>(options: {
  attempt: () => Promise<T>;
  parseBlocker: (error: unknown) => PublisherPolicyRecheckBlocker | null;
  signal: AbortSignal;
  delaysMs?: readonly number[];
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}): Promise<T> {
  const delaysMs = options.delaysMs ?? PUBLISHER_POLICY_RECHECK_DELAYS_MS;
  const wait = options.wait ?? waitForDelay;
  if (options.signal.aborted) {
    throw abortError();
  }

  let lastError: unknown;
  let observedCheckedAt: string | null;
  try {
    return await options.attempt();
  } catch (error: unknown) {
    lastError = error;
    const blocker = options.parseBlocker(error);
    if (!blocker?.canRecheck) {
      throw error;
    }
    observedCheckedAt = blocker.checkedAt;
  }

  for (const delayMs of delaysMs) {
    await wait(delayMs, options.signal);
    if (options.signal.aborted) {
      throw abortError();
    }

    try {
      return await options.attempt();
    } catch (error: unknown) {
      lastError = error;
      const blocker = options.parseBlocker(error);
      if (!blocker?.canRecheck || blocker.checkedAt !== observedCheckedAt) {
        throw error;
      }
    }
  }

  throw lastError;
}
