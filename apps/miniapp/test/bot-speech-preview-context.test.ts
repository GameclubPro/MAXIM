import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT,
  resolveBotSpeechPreviewContext,
} from '../src/lib/bot-speech-preview-context';

test('bot speech preview uses the safe profile returned by the settings screen', () => {
  assert.deepEqual(
    resolveBotSpeechPreviewContext({
      persona: 'female',
      characterName: 'Майор Максимова',
    }),
    {
      persona: 'female',
      characterName: 'Майор Максимова',
    },
  );
});

test('bot speech preview keeps the Rex profile neutral', () => {
  assert.deepEqual(resolveBotSpeechPreviewContext({ persona: 'neutral', characterName: 'Рэкс' }), {
    persona: 'neutral',
    characterName: 'Рэкс',
  });
});

test('bot speech preview keeps the generic fallback when bot assignments are unavailable', () => {
  assert.deepEqual(resolveBotSpeechPreviewContext(null), DEFAULT_BOT_SPEECH_PREVIEW_CONTEXT);
});
