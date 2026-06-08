export async function fetchWithApiBaseFallback<T>(
  apiBases: readonly string[],
  init: RequestInit,
  fetchFromBase: (apiBase: string) => Promise<T>,
): Promise<T> {
  if (['GET', 'HEAD'].includes((init.method ?? 'GET').toUpperCase())) {
    return Promise.any(apiBases.map(fetchFromBase)).catch((error: unknown) => {
      throw error instanceof AggregateError ? error.errors.at(-1) : error;
    });
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
