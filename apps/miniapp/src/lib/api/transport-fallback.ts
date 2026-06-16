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
    let pendingCount = 0;
    let settled = false;
    let lastError: unknown;
    let hedgeTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

    const clearHedgeTimer = () => {
      if (hedgeTimer) {
        globalThis.clearTimeout(hedgeTimer);
        hedgeTimer = null;
      }
    };

    const maybeReject = () => {
      if (!settled && pendingCount === 0 && nextIndex >= apiBases.length) {
        settled = true;
        reject(lastError);
      }
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
      nextIndex += 1;
      pendingCount += 1;
      void fetchFromBase(apiBase)
        .then((value) => {
          if (settled) {
            return;
          }

          if (isRetryableFallbackResponse(value) && nextIndex < apiBases.length) {
            pendingCount -= 1;
            lastError = new Error(`API base returned ${value.response.status}`);
            clearHedgeTimer();
            startNextAttempt();
            return;
          }

          settled = true;
          clearHedgeTimer();
          resolve(value);
        })
        .catch((error: unknown) => {
          pendingCount -= 1;
          lastError = error;
          if (settled) {
            return;
          }

          if (nextIndex < apiBases.length) {
            clearHedgeTimer();
            startNextAttempt();
            return;
          }

          maybeReject();
        });

      scheduleNextAttempt();
    };

    startNextAttempt();
  });
}

function isRetryableFallbackResponse<T>(value: T): value is T & RetryableFetchAttemptResponse {
  const response = (value as FetchAttemptResponse | null | undefined)?.response;
  if (!response || response.ok) {
    return false;
  }

  return response.status === 403 || response.status >= 500;
}
