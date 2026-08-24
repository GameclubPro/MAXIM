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

test('both suggestion histories render the aggregate status explanation', () => {
  for (const source of [dedicatedHistorySource, legacyPageSource]) {
    assert.match(source, /className="channel-suggest-card__status-copy"/u);
    assert.match(source, /<strong>\{status\.headline\}<\/strong>/u);
    assert.match(source, /<span>\{status\.note\}<\/span>/u);
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
  assert.match(dedicatedPageSource, /return \{ default: LazySuggestionChunkLoadFailure/u);
});

test('suggestion status copy stays compact and unframed', () => {
  assert.match(suggestionCss, /\.channel-suggest-card__status-copy \{[\s\S]*?display: grid;/u);
  assert.match(
    suggestionCss,
    /\.channel-suggest-card__status-copy strong \{[\s\S]*?font-size: 0\.75rem;/u,
  );
  assert.doesNotMatch(suggestionCss, /\.channel-suggest-card__status-copy \{[^}]*background:/u);
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
