type TimeoutHandle = ReturnType<typeof setTimeout>;

export async function raceWithTimeout<T>(params: {
  operation: Promise<T>;
  timeoutMs: number;
  onTimeout: () => T;
}): Promise<T> {
  const { operation, timeoutMs, onTimeout } = params;
  operation.catch(() => undefined);

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

  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
