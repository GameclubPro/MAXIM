import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const suggestionPageSource = readFileSync(
  new URL('../src/pages/channel-suggest-dialog-page.tsx', import.meta.url),
  'utf8',
);

test('dedicated channel suggestions render formatting instead of markdown markers', () => {
  assert.match(suggestionPageSource, /<MaxRichTextEditor/u);
  assert.match(suggestionPageSource, /className="channel-suggest-composer__rich-editor"/u);
  assert.doesNotMatch(suggestionPageSource, /<MaxMarkdownEditor/u);
});

test('rich channel suggestions stay within the server text limit', () => {
  assert.match(suggestionPageSource, /draftLength <= SUGGEST_DRAFT_MAX_LENGTH/u);
  assert.match(suggestionPageSource, /draftLength > SUGGEST_DRAFT_MAX_LENGTH/u);
});
