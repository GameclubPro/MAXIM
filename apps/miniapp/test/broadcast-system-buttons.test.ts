import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChannelBroadcastSystemButtons } from '../src/lib/broadcast-system-buttons';

test('respects explicit channel autopost system button mode', () => {
  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
      autoPostButtonsMode: 'OFF',
    }),
    [],
  );

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
      autoPostButtonsMode: 'SUGGEST',
    }),
    [{ kind: 'suggest', text: 'Предложить' }],
  );

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
      autoPostButtonsMode: 'BOTH',
    }),
    [
      { kind: 'comments', text: '💬 Комментарии' },
      { kind: 'suggest', text: 'Предложить' },
    ],
  );
});
