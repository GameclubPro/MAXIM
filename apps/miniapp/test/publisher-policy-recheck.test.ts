import assert from 'node:assert/strict';
import test from 'node:test';
import { retryPublisherPolicyEnablement } from '../src/lib/publisher-policy-recheck';

type TestBlockerError = Error & {
  blocker?: { canRecheck: boolean; checkedAt: string | null };
};

function blockerError(checkedAt: string | null, canRecheck = true): TestBlockerError {
  const error = new Error('Publisher policy blocked') as TestBlockerError;
  error.blocker = { canRecheck, checkedAt };
  return error;
}

const parseBlocker = (error: unknown) => (error as TestBlockerError).blocker ?? null;
const immediateWait = async (_delayMs: number, signal: AbortSignal) => {
  if (signal.aborted) {
    const error = new Error('cancelled');
    error.name = 'AbortError';
    throw error;
  }
};

test('policy recheck waits through unchanged access snapshots and then succeeds', async () => {
  const controller = new AbortController();
  const attempts = [blockerError(null), blockerError(null), { publikEnabled: true }];
  let attemptIndex = 0;

  const result = await retryPublisherPolicyEnablement({
    signal: controller.signal,
    delaysMs: [1, 2],
    wait: immediateWait,
    parseBlocker,
    attempt: async () => {
      const result = attempts[attemptIndex++];
      if (result instanceof Error) throw result;
      return result;
    },
  });

  assert.deepEqual(result, { publikEnabled: true });
  assert.equal(attemptIndex, 3);
});

test('policy recheck adopts the first explicit response and stops on a newer blocked snapshot', async () => {
  const controller = new AbortController();
  const first = blockerError('2026-08-31T20:00:00.000Z');
  const refreshed = blockerError('2026-08-31T20:00:01.000Z');
  const attempts = [first, refreshed];
  let attemptIndex = 0;

  await assert.rejects(
    retryPublisherPolicyEnablement({
      signal: controller.signal,
      delaysMs: [1, 2, 3],
      wait: immediateWait,
      parseBlocker,
      attempt: async () => {
        throw attempts[attemptIndex++];
      },
    }),
    (error) => error === refreshed,
  );
  assert.equal(attemptIndex, 2);
});

test('policy recheck waits for the probe queued by its first response even after the dialog aged', async () => {
  const controller = new AbortController();
  const attempts = [blockerError('2026-08-31T20:00:01.000Z'), { publikEnabled: true }];
  let attemptIndex = 0;

  const result = await retryPublisherPolicyEnablement({
    signal: controller.signal,
    delaysMs: [1],
    wait: immediateWait,
    parseBlocker,
    attempt: async () => {
      const result = attempts[attemptIndex++];
      if (result instanceof Error) throw result;
      return result;
    },
  });

  assert.deepEqual(result, { publikEnabled: true });
  assert.equal(attemptIndex, 2);
});

test('policy recheck stops on non-recheckable and unrelated errors', async () => {
  for (const failure of [blockerError(null, false), new Error('revision conflict')]) {
    const controller = new AbortController();
    let attempts = 0;
    await assert.rejects(
      retryPublisherPolicyEnablement({
        signal: controller.signal,
        delaysMs: [1, 2, 3],
        wait: immediateWait,
        parseBlocker,
        attempt: async () => {
          attempts += 1;
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(attempts, 1);
  }
});

test('policy recheck is bounded and returns the last unchanged blocker', async () => {
  const controller = new AbortController();
  const failures = [blockerError(null), blockerError(null), blockerError(null)];
  let attempts = 0;

  await assert.rejects(
    retryPublisherPolicyEnablement({
      signal: controller.signal,
      delaysMs: [1, 2],
      wait: immediateWait,
      parseBlocker,
      attempt: async () => {
        throw failures[attempts++];
      },
    }),
    (error) => error === failures[2],
  );
  assert.equal(attempts, 3);
});

test('policy recheck aborts before issuing another policy mutation', async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;

  await assert.rejects(
    retryPublisherPolicyEnablement({
      signal: controller.signal,
      delaysMs: [1],
      parseBlocker,
      attempt: async () => {
        attempts += 1;
        return { publikEnabled: true };
      },
    }),
    { name: 'AbortError' },
  );
  assert.equal(attempts, 0);
});
