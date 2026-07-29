import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChannelBroadcastSystemButtons,
  enableChannelSuggestionAutoPostButton,
} from '../src/lib/broadcast-system-buttons';

test('adds the suggestion button to the retained autopost mode when suggestions are enabled', () => {
  assert.equal(enableChannelSuggestionAutoPostButton('OFF'), 'SUGGEST');
  assert.equal(enableChannelSuggestionAutoPostButton('COMMENTS'), 'BOTH');
  assert.equal(enableChannelSuggestionAutoPostButton('SUGGEST'), 'SUGGEST');
  assert.equal(enableChannelSuggestionAutoPostButton('BOTH'), 'BOTH');
});

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

  assert.deepEqual(
    buildChannelBroadcastSystemButtons({
      commentsEnabled: false,
      postSuggestionsEnabled: true,
      postSuggestionsButtonText: 'Предложить',
      autoPostButtonsMode: 'BOTH',
    }),
    [{ kind: 'suggest', text: 'Предложить' }],
  );
});
