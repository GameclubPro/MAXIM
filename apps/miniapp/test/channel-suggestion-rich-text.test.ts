import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const suggestionPageSource = readFileSync(
  new URL('../src/pages/channel-suggest-dialog-page.tsx', import.meta.url),
  'utf8',
);
const legacyDialogPageSource = readFileSync(
  new URL('../src/pages/channel-dialog-page.tsx', import.meta.url),
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

test('dedicated channel suggestions track rich editor focus for keyboard visibility', () => {
  assert.match(
    suggestionPageSource,
    /target\.closest\('\.max-rich-text-editor__surface, \.max-rich-text-editor__link-panel input'\)/u,
  );
  assert.doesNotMatch(
    suggestionPageSource,
    /target\.closest\('\.channel-suggest-composer__field textarea'\)/u,
  );
});

test('pasted images use the suggestion attachment preparation pipeline', () => {
  assert.match(
    suggestionPageSource,
    /<MaxRichTextEditor[\s\S]*?onPasteFiles=\{canUploadImages \? prepareDraftImagesFromFiles : undefined\}[\s\S]*?\/>/u,
  );
  assert.match(
    suggestionPageSource,
    /const \{ canUploadSuggestionImages: canUploadImages \} =\s*resolveChannelDialogProfileCapabilities\(profile\)/u,
  );
});

test('overlapping pasted images share an immediate preparation and submit guard', () => {
  assert.match(suggestionPageSource, /imagePreparationGuard\.tryStart\(\)/u);
  assert.match(suggestionPageSource, /imagePreparationGuard\.owns\(preparationRun\)/u);
  assert.match(suggestionPageSource, /imagePreparationGuard\.finish\(preparationRun\)/u);
  assert.match(
    suggestionPageSource,
    /const onSubmit = \(\) => \{[\s\S]*?imagePreparationGuard\.isActive\(\)/u,
  );
});

test('suggestion submit confirmations do not claim delivery before it is confirmed', () => {
  assert.match(suggestionPageSource, /title: 'Предложение сохранено'/u);
  assert.doesNotMatch(suggestionPageSource, /Предложение отправлено/u);
  assert.match(
    legacyDialogPageSource,
    /dialogType === 'suggest' \? 'Предложение сохранено' : 'Комментарий отправлен'/u,
  );
  assert.doesNotMatch(
    legacyDialogPageSource,
    /dialogType === 'suggest' \? 'Предложение отправлено'/u,
  );
});
