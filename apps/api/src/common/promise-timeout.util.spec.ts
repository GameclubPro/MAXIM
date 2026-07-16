import { raceWithTimeout } from './promise-timeout.util';

describe('raceWithTimeout', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('keeps soft-timeout operations detached by default', async () => {
    jest.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finishOperation: ((value: string) => void) | undefined;
    const operationFinished = jest.fn();

    const resultPromise = raceWithTimeout({
      operation: (operationSignal) => {
        signal = operationSignal;
        return new Promise<string>((resolve) => {
          finishOperation = (value) => {
            operationFinished(value);
            resolve(value);
          };
        });
      },
      timeoutMs: 50,
      onTimeout: () => 'fallback',
    });

    await jest.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toBe('fallback');
    expect(signal?.aborted).toBe(false);

    finishOperation?.('late result');
    await Promise.resolve();
    expect(operationFinished).toHaveBeenCalledWith('late result');
  });

  it('aborts a signal-aware operation when requested', async () => {
    jest.useFakeTimers();
    const aborted = jest.fn();

    const resultPromise = raceWithTimeout({
      operation: (signal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', aborted, { once: true });
        }),
      timeoutMs: 50,
      onTimeout: () => 'fallback',
      abortOnTimeout: true,
    });

    await jest.advanceTimersByTimeAsync(50);

    await expect(resultPromise).resolves.toBe('fallback');
    expect(aborted).toHaveBeenCalledTimes(1);
  });

  it('does not abort when the operation completes before the deadline', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const onTimeout = jest.fn(() => 'fallback');

    await expect(
      raceWithTimeout({
        operation: async () => 'result',
        timeoutMs: 50,
        onTimeout,
        abortOnTimeout: true,
        abortController: controller,
      }),
    ).resolves.toBe('result');

    await jest.runAllTimersAsync();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
  });
});
