import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldReplaceLocalManagedPollDraft,
  syncManagedPollDraft,
  type ManagedPollDraftSyncState,
} from '../src/lib/managed-poll-draft-sync';

type Draft = {
  question: string;
  options: string[];
};

function createState(
  overrides: Partial<ManagedPollDraftSyncState<Draft>> = {},
): ManagedPollDraftSyncState<Draft> {
  return {
    payload: {
      question: 'Вопрос',
      options: ['Да', 'Нет'],
    },
    payloadKey: 'draft-key',
    isDirty: true,
    isActive: false,
    lastFailedKey: null,
    ...overrides,
  };
}

test('preserves a newer local draft when stale server data arrives', () => {
  assert.equal(
    shouldReplaceLocalManagedPollDraft({
      entityChanged: false,
      hasCurrentDraft: true,
      isDirty: true,
      currentDraftKey: 'draft-new',
      nextDraftKey: 'draft-old',
    }),
    false,
  );
});

test('replaces local draft when the entity changes', () => {
  assert.equal(
    shouldReplaceLocalManagedPollDraft({
      entityChanged: true,
      hasCurrentDraft: true,
      isDirty: true,
      currentDraftKey: 'draft-old',
      nextDraftKey: 'draft-new',
    }),
    true,
  );
});

test('force save waits for a stale in-flight save and then saves the latest draft', async () => {
  let state = createState({
    payload: {
      question: 'Новый вопрос',
      options: ['Первый', 'Второй'],
    },
    payloadKey: 'draft-new',
  });
  let inFlightResolve: (() => void) | null = null;
  let inFlight: Promise<{ savedKey: string }> | null = new Promise((resolve) => {
    inFlightResolve = () => {
      state = createState({
        payload: {
          question: 'Новый вопрос',
          options: ['Первый', 'Второй'],
        },
        payloadKey: 'draft-new',
        isDirty: true,
      });
      resolve({ savedKey: 'draft-old' });
    };
  });
  const savedPayloadKeys: string[] = [];

  const resultPromise = syncManagedPollDraft<Draft, { savedKey: string }>(
    {
      readState: () => state,
      getInFlightSave: () => inFlight,
      setInFlightSave: (request) => {
        inFlight = request;
      },
      performSave: async (payload) => {
        savedPayloadKeys.push(payload.question);
        state = createState({
          payload,
          payloadKey: 'draft-new',
          isDirty: false,
        });
        return { savedKey: 'draft-new' };
      },
    },
    { force: true },
  );

  assert.deepEqual(savedPayloadKeys, []);
  inFlightResolve?.();

  const result = await resultPromise;
  assert.deepEqual(savedPayloadKeys, ['Новый вопрос']);
  assert.deepEqual(result, { savedKey: 'draft-new' });
});

test('non-force save reuses the current in-flight request', async () => {
  const inFlightResult = { savedKey: 'draft-current' };
  const inFlight = Promise.resolve(inFlightResult);
  let performSaveCalls = 0;

  const result = await syncManagedPollDraft<Draft, { savedKey: string }>({
    readState: () => createState(),
    getInFlightSave: () => inFlight,
    setInFlightSave: () => undefined,
    performSave: async () => {
      performSaveCalls += 1;
      return { savedKey: 'unexpected' };
    },
  });

  assert.equal(performSaveCalls, 0);
  assert.deepEqual(result, inFlightResult);
});
