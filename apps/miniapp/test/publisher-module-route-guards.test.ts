import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const modulesSource = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.tsx', import.meta.url),
  'utf8',
);
const modulesCss = readFileSync(
  new URL('../src/pages/publisher-entity-modules-page.css', import.meta.url),
  'utf8',
);
test('Publik entity modules route is registered only for the publisher profile', () => {
  assert.match(
    appSource,
    /!moderationProfile\s*\?\s*\([\s\S]*?path="\/publisher\/:entityType\/:entityId"[\s\S]*?LazyPublisherEntityModulesPage/u,
  );
});

test('Publik module workspace owns its header without a duplicate shell topbar', () => {
  assert.match(
    shellSource,
    /isPublisherEntityModulesRoute[\s\S]*?profile === 'publisher'[\s\S]*?\/publisher/u,
  );
  assert.match(shellSource, /!isPublisherEntityModulesRoute/u);
});

test('blocked Publik modules explain readiness and run one bounded targeted recheck', () => {
  assert.match(modulesSource, /<small>\{readiness\.detail\}<\/small>/u);
  assert.match(modulesSource, /shouldOfferPublisherRecheck\(entity\)/u);
  assert.match(
    modulesSource,
    /await refreshPublisherEntity\(api, entityType, initialEntity\.id\)/u,
  );
  assert.match(modulesSource, /pollPublisherEntityRefresh\(\{/u);
  assert.match(modulesCss, /\.publisher-entity-modules-page__recheck \{[\s\S]*?min-height: 44px;/u);
});

test('channel suggestions expose only the Publisher module switch', () => {
  assert.match(
    modulesSource,
    /<strong>Предложения<\/strong>[\s\S]*?checked=\{entity\.moduleSettings\.channelSuggestionsEnabled === true\}/u,
  );
  assert.match(
    modulesSource,
    /onChange=\{\(channelSuggestionsEnabled\) =>[\s\S]*?mutation\.mutate\(\{ channelSuggestionsEnabled \}\)/u,
  );
  assert.doesNotMatch(
    modulesSource,
    /LazyPublisherSuggestionsInbox|publisher-suggestions-inbox|publisherSuggestions\(/u,
  );
  assert.doesNotMatch(modulesCss, /publisher-suggestions|publisher-suggestion-row/u);
});
