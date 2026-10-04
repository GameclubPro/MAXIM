import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BOT_SPEECH_STYLE_VALUES } from '@maxim/contracts/bot-speech';
import { buildSpeechStylePreviewSamples } from '../src/lib/bot-speech-style-preview';

test('every style preview resolves its variables and includes duplicate and night examples', () => {
  for (const style of BOT_SPEECH_STYLE_VALUES) {
    const samples = buildSpeechStylePreviewSamples(style, {
      persona: 'female',
      characterName: 'Алиса',
    });
    assert.match(samples.greeting, /Алиса/u);
    assert.match(samples.duplicate, /Алексей/u);
    assert.match(samples.night, /23:00–08:00/u);
    assert.doesNotMatch(samples.warning, /реклам/iu);
    for (const sample of Object.values(samples)) {
      assert.doesNotMatch(sample, /\{[a-z_]+\}/u);
      assert.ok(sample.length < 500);
    }
  }
});

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
