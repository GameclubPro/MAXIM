type TimeoutHandle = ReturnType<typeof setTimeout>;

export async function raceWithTimeout<T>(params: {
  operation: Promise<T> | ((signal: AbortSignal) => Promise<T>);
  timeoutMs: number;
  onTimeout: () => T;
  abortOnTimeout?: boolean;
  abortController?: AbortController;
}): Promise<T> {
  const { operation, timeoutMs, onTimeout, abortOnTimeout = false } = params;
  const abortController = params.abortController ?? new AbortController();

  let timeout: TimeoutHandle | null = null;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      } finally {
        if (abortOnTimeout && !abortController.signal.aborted) {
          abortController.abort();
        }
      }
    }, timeoutMs);
    timeout.unref?.();
  });

  const operationPromise =
    typeof operation === 'function'
      ? Promise.resolve().then(() => operation(abortController.signal))
      : operation;
  operationPromise.catch(() => undefined);

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
