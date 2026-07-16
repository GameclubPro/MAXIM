import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BOT_SPEECH_STYLE_VALUES } from '@maxim/contracts/bot-speech';
import { buildSpeechStylePreviewSamples } from '../src/lib/bot-speech-style-preview';

const previewSource = readFileSync(
  new URL('../src/lib/bot-speech-style-preview.ts', import.meta.url),
  'utf8',
);

test('speech style preview uses a neutral permanent-ban template', () => {
  for (const style of BOT_SPEECH_STYLE_VALUES) {
    const samples = buildSpeechStylePreviewSamples(style);

    assert.match(samples.ban, /Алексей/u);
    assert.doesNotMatch(samples.ban, /тем|повторн|причин/u);
  }

  assert.match(previewSource, /getSystemTemplate\(style, 'permanentBanNotice'/u);
  assert.doesNotMatch(previewSource, /getSystemTemplate\(style, 'topic/u);
});
