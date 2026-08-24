import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelSuggestionImagePreparationGuard } from '../src/lib/channel-suggestion-image-preparation';

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((nextResolve) => {
    resolve = () => nextResolve();
  });
  return { promise, resolve };
}

test('overlapping image preparation admits one mutation and gates submit until completion', async () => {
  const guard = createChannelSuggestionImagePreparationGuard();
  const firstStep = createDeferred();
  let mutationCount = 0;

  const runPipeline = async (step: Promise<void>) => {
    const run = guard.tryStart();
    if (!run) {
      return false;
    }

    try {
      await step;
      if (guard.owns(run)) {
        mutationCount += 1;
      }
      return true;
    } finally {
      guard.finish(run);
    }
  };

  const first = runPipeline(firstStep.promise);
  const second = runPipeline(Promise.resolve());

  assert.equal(guard.isActive(), true);
  assert.equal(await second, false);
  assert.equal(mutationCount, 0);

  firstStep.resolve();
  assert.equal(await first, true);
  assert.equal(mutationCount, 1);
  assert.equal(guard.isActive(), false);
});

test('cancelled preparation cannot finish or mutate a replacement run', () => {
  const guard = createChannelSuggestionImagePreparationGuard();
  const cancelled = guard.tryStart();
  assert.ok(cancelled);

  guard.cancel();
  const replacement = guard.tryStart();
  assert.ok(replacement);

  assert.equal(guard.owns(cancelled), false);
  assert.equal(guard.finish(cancelled), false);
  assert.equal(guard.owns(replacement), true);
});
