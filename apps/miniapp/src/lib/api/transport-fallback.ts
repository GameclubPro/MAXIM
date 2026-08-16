import { isTransientHttpStatus } from '../api-retry';

const IDEMPOTENT_FALLBACK_HEDGE_DELAY_MS = 750;

type FetchAttemptResponse = {
  response?: {
    ok: boolean;
    status: number;
  };
};

type RetryableFetchAttemptResponse = {
  response: {
    ok: boolean;
    status: number;
  };
};

type FailedFetchAttemptResponse = RetryableFetchAttemptResponse;

export async function fetchWithApiBaseFallback<T>(
  apiBases: readonly string[],
  init: RequestInit,
  fetchFromBase: (apiBase: string) => Promise<T>,
): Promise<T> {
  if (['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) {
    return fetchWithHedgedApiBaseFallback(apiBases, fetchFromBase);
  }

  let lastError: unknown;
  for (const apiBase of apiBases) {
    try {
      return await fetchFromBase(apiBase);
    } catch (error: unknown) {
      lastError = error;
    }
  }

  throw lastError;
}

function fetchWithHedgedApiBaseFallback<T>(
  apiBases: readonly string[],
  fetchFromBase: (apiBase: string) => Promise<T>,
): Promise<T> {
  if (apiBases.length <= 1) {
    return fetchFromBase(apiBases[0]);
  }

  return new Promise<T>((resolve, reject) => {
    let nextIndex = 0;
    const pendingIndexes = new Set<number>();
    let settled = false;
    let lastError: unknown;
    let failureCandidate: { index: number; value: T } | null = null;
    let hedgeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const clearHedgeTimer = () => {
      if (hedgeTimer) {
        globalThis.clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
    };

    const maybeReject = () => {
      if (!settled && pendingIndexes.size === 0 && nextIndex >= apiBases.length) {
        settled = true;
        reject(lastError);
      }
    };

    const rememberFailure = (index: number, value: T) => {
      if (!failureCandidate || index < failureCandidate.index) {
        failureCandidate = { index, value };
      }
    };

    const hasPendingEarlierAttempt = (index: number): boolean => {
      for (const pendingIndex of pendingIndexes) {
        if (pendingIndex < index) {
          return true;
        }
      }

      return false;
    };

    const settleWithFailureCandidate = () => {
      if (settled || !failureCandidate) {
        return;
      }

      settled = true;
      clearHedgeTimer();
      resolve(failureCandidate.value);
    };

    const maybeSettleStoredFailure = () => {
      if (settled || pendingIndexes.size > 0) {
        return;
      }

      if (nextIndex < apiBases.length) {
        return;
      }

      if (failureCandidate) {
        settleWithFailureCandidate();
        return;
      }

      maybeReject();
    };

    const scheduleNextAttempt = () => {
      if (settled || hedgeTimer || nextIndex >= apiBases.length) {
        return;
      }

      hedgeTimer = globalThis.setTimeout(() => {
        hedgeTimer = null;
        startNextAttempt();
      }, IDEMPOTENT_FALLBACK_HEDGE_DELAY_MS);
    };

    const startNextAttempt = () => {
      if (settled || nextIndex >= apiBases.length) {
        return;
      }

      const apiBase = apiBases[nextIndex];
      const attemptIndex = nextIndex;
      nextIndex += 1;
      pendingIndexes.add(attemptIndex);
      void fetchFromBase(apiBase)
        .then((value) => {
          pendingIndexes.delete(attemptIndex);
          if (settled) {
            return;
          }

          if (!isFailedFallbackResponse(value)) {
            settled = true;
            clearHedgeTimer();
            resolve(value);
            return;
          }

          rememberFailure(attemptIndex, value);

          if (isRetryableFallbackResponse(value)) {
            lastError = new Error(`API base returned ${value.response.status}`);
            if (nextIndex < apiBases.length) {
              clearHedgeTimer();
              startNextAttempt();
              return;
            }

            maybeSettleStoredFailure();
            return;
          }

          if (hasPendingEarlierAttempt(attemptIndex)) {
            maybeSettleStoredFailure();
            return;
          }

          settleWithFailureCandidate();
        })
        .catch((error: unknown) => {
          pendingIndexes.delete(attemptIndex);
          lastError = error;
          if (settled) {
            return;
          }

          if (nextIndex < apiBases.length) {
            clearHedgeTimer();
            startNextAttempt();
            return;
          }

          if (failureCandidate) {
            maybeSettleStoredFailure();
            return;
          }

          maybeReject();
        });

      scheduleNextAttempt();
    };

    startNextAttempt();
  });
}

function isFailedFallbackResponse<T>(value: T): value is T & FailedFetchAttemptResponse {
  const response = (value as FetchAttemptResponse | null | undefined)?.response;
  return Boolean(response && !response.ok);
}

function isRetryableFallbackResponse<T>(value: T): value is T & RetryableFetchAttemptResponse {
  const response = (value as FetchAttemptResponse | null | undefined)?.response;
  if (!response || response.ok) {
    return false;
  }

  return isTransientHttpStatus(response.status);
}
