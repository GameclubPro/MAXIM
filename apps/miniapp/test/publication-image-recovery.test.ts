import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPublicationImageRecoveryState,
  resolvePublicationImageRecoveryState,
} from '../src/features/publications/use-publication-composer';

test('isolated editors can reset recovery without changing the saved create snapshot', () => {
  const createRecovery = createPublicationImageRecoveryState(2, 1);
  const isolatedRecovery = createPublicationImageRecoveryState(0, 0);

  assert.deepEqual(createRecovery, { missingImageCount: 2, expectedImageCount: 3 });
  assert.deepEqual(isolatedRecovery, { missingImageCount: 0, expectedImageCount: null });

  const restoredRecovery = createPublicationImageRecoveryState(createRecovery.missingImageCount, 1);
  assert.deepEqual(restoredRecovery, createRecovery);
});

test('partial add, remove, completion, and discard keep exact recovery counts', () => {
  const initial = createPublicationImageRecoveryState(3, 1);
  const afterAddingTwo = resolvePublicationImageRecoveryState(initial, 3);
  const afterRemovingOne = resolvePublicationImageRecoveryState(afterAddingTwo, 2);
  const completed = resolvePublicationImageRecoveryState(afterRemovingOne, 4);
  const discarded = createPublicationImageRecoveryState(0, 2);

  assert.equal(afterAddingTwo.missingImageCount, 1);
  assert.equal(afterRemovingOne.missingImageCount, 2);
  assert.deepEqual(completed, { missingImageCount: 0, expectedImageCount: null });
  assert.deepEqual(discarded, { missingImageCount: 0, expectedImageCount: null });
});
