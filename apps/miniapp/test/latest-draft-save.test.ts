import assert from 'node:assert/strict';
import test from 'node:test';
import { saveUntilLatestDraftIsPersisted } from '../src/lib/latest-draft-save';

test('retries after an in-flight save resolves an older draft', async () => {
  let resolveInFlight: ((value: string) => void) | null = null;
  const pendingSave = new Promise<string>((resolve) => {
    resolveInFlight = resolve;
  });
  let activeSave: Promise<string> | null = null;
  const inFlight = pendingSave.finally(() => {
    activeSave = null;
  });
  activeSave = inFlight;
  const savedKeys: string[] = [];

  const persistedPromise = saveUntilLatestDraftIsPersisted({
    getCurrentKey: () => 'draft-b',
    getSavedKey: (saved) => saved,
    save: async () => {
      if (activeSave) {
        return activeSave;
      }

      savedKeys.push('draft-b');
      return 'draft-b';
    },
  });

  resolveInFlight?.('draft-a');

  const persisted = await persistedPromise;
  assert.equal(persisted, true);
  assert.deepEqual(savedKeys, ['draft-b']);
});

test('does not approve a publish when the newest draft remains unsaved', async () => {
  const persisted = await saveUntilLatestDraftIsPersisted({
    getCurrentKey: () => 'draft-b',
    getSavedKey: (saved) => saved,
    save: async () => 'draft-a',
    maxAttempts: 2,
  });

  assert.equal(persisted, false);
});
