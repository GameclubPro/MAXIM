import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChannelBroadcastSystemButtons } from '../src/lib/broadcast-system-buttons';

test('derives channel system buttons directly from the feature toggles', () => {
  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: false,
      postSuggestionsEnabled: false,
    }),
    [],
  );

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: true,
      postSuggestionsEnabled: false,
    }),
    [{ kind: 'comments', text: '💬 Комментарии' }],
  );

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: false,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
    }),
    [{ kind: 'suggest', text: 'Предложить' }],
  );

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
    }),
    [
      { kind: 'comments', text: '💬 Комментарии' },
      { kind: 'suggest', text: 'Предложить' },
    ],
  );
});
