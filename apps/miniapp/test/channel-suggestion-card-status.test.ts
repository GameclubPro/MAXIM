import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const dedicatedPageSource = readFileSync(
  new URL('../src/pages/channel-suggest-dialog-page.tsx', import.meta.url),
  'utf8',
);
const dedicatedHistorySource = readFileSync(
  new URL('../src/components/channel-suggestion-history.tsx', import.meta.url),
  'utf8',
);
const legacyPageSource = readFileSync(
  new URL('../src/pages/channel-dialog-page.tsx', import.meta.url),
  'utf8',
);
const suggestionCss = readFileSync(
  new URL('../src/styles/channel-dialog-suggest.css', import.meta.url),
  'utf8',
);

test('both suggestion histories render a concise status and exceptional detail only', () => {
  for (const source of [dedicatedHistorySource, legacyPageSource]) {
    assert.match(source, /\{status\.badge\}/u);
    assert.match(source, /status\.detail/u);
    assert.match(source, /\{hasSuggestionText \? \([\s\S]*?<p>/u);
    assert.doesNotMatch(source, /channel-suggest-card__status-copy/u);
    assert.doesNotMatch(source, /status\.(?:headline|note)/u);
    assert.doesNotMatch(source, /Предложение отправлено.*(?:фото|видео|медиа)/u);
  }
  assert.match(
    dedicatedPageSource,
    /const loadChannelSuggestionHistory = \(\) =>\s*import\('\.\.\/components\/channel-suggestion-history'\)/u,
  );
  assert.match(
    dedicatedPageSource,
    /lazySuggestionComponent\(\s*loadChannelSuggestionHistory,\s*'ChannelSuggestionHistory',\s*true/u,
  );
  assert.match(
    dedicatedPageSource,
    /const onSubmit = \(\) => \{[\s\S]*?loadChannelSuggestionHistory\(\)[\s\S]*?sendMutation\.mutate/u,
  );
});

test('suggestion child chunks recover without crashing the route', () => {
  assert.match(dedicatedPageSource, /reloadAfterLazyPageLoadFailure\(exportName, cause\)/u);
  assert.match(
    dedicatedPageSource,
    /lazySuggestionComponent\(\s*loadChannelSuggestionComposeImageGrid,\s*'ChannelSuggestionComposeImageGrid',\s*false/u,
  );
  assert.match(
    dedicatedPageSource,
    /lazySuggestionComponent\(\s*loadMaxRichTextEditor,\s*'MaxRichTextEditor',\s*true/u,
  );
  assert.doesNotMatch(dedicatedPageSource, /const LazyMaxRichTextEditor = lazy\(/u);
  assert.match(dedicatedPageSource, /return \{ default: LazySuggestionChunkLoadFailure/u);
});

test('suggestion status stays compact without an explanatory block', () => {
  assert.match(
    suggestionCss,
    /\.channel-suggest-status \{[\s\S]*?min-height: 28px;[\s\S]*?font-size: 0\.7rem;/u,
  );
  assert.doesNotMatch(suggestionCss, /channel-suggest-card__status-copy/u);
  assert.match(suggestionCss, /\.channel-suggest-card__status-detail/u);
});

test('legacy comments use one factual empty state and direct success messages', () => {
  assert.match(legacyPageSource, /<strong>Комментариев пока нет<\/strong>/u);
  assert.doesNotMatch(legacyPageSource, /Здесь пока тихо|Напишите первый комментарий/u);
  assert.doesNotMatch(
    legacyPageSource,
    /title: 'Готово',[\s\S]*?Комментарий (?:отправлен|обновлён|удалён)/u,
  );
});

test('suggestion keyboard effects survive polling and restore existing focus', () => {
  for (const source of [dedicatedPageSource, legacyPageSource]) {
    assert.match(source, /if \(isSuggestEditorTarget\(document\.activeElement\)\)/u);
    assert.match(source, /style\.removeProperty\('--suggest-keyboard-reserve'\)/u);
  }

  assert.match(dedicatedPageSource, /\}, \[dialogQuery\.isSuccess\]\);/u);
  assert.match(legacyPageSource, /\}, \[dialogQuery\.isSuccess, dialogType\]\);/u);
  assert.match(suggestionCss, /--suggest-bar-bottom:[\s\S]*?var\(--suggest-keyboard-reserve\)/u);
});
