type TimeoutHandle = ReturnType<typeof setTimeout>;

export async function raceWithTimeout<T>(params: {
  operation: Promise<T> | (() => Promise<T>);
  timeoutMs: number;
  onTimeout: () => T;
}): Promise<T> {
  const { operation, timeoutMs, onTimeout } = params;

  let timeout: TimeoutHandle | null = null;
  const timeoutPromise = new Promise<T>((resolve, reject) => {
    timeout = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, timeoutMs);
    timeout.unref?.();
  });

  const operationPromise =
    typeof operation === 'function' ? Promise.resolve().then(operation) : operation;
  operationPromise.catch(() => undefined);

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
