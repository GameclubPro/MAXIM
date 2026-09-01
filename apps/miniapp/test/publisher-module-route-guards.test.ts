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
const suggestionsSource = readFileSync(
  new URL('../src/pages/publisher-suggestions-inbox.tsx', import.meta.url),
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

test('channel suggestions confirm terminal actions and page both server views independently', () => {
  assert.match(modulesSource, /<LazyPublisherSuggestionsInbox/u);
  assert.match(modulesSource, /await import\('\.\/publisher-suggestions-inbox'\)/u);
  assert.match(
    modulesSource,
    /entity\.moduleSettings\.channelSuggestionsEnabled === true \? \([\s\S]*?<LazyPublisherSuggestionsInbox/u,
  );
  assert.match(
    suggestionsSource,
    /enabled: shouldLoadPublisherSuggestions\(\{[\s\S]*?requestView: 'pending'/u,
  );
  assert.match(
    suggestionsSource,
    /enabled: shouldLoadPublisherSuggestions\(\{[\s\S]*?requestView: 'history'/u,
  );
  assert.match(suggestionsSource, /if \(!enabled\) \{\s*return null;/u);
  assert.match(suggestionsSource, /<LazyActionConfirmSheet/u);
  assert.match(suggestionsSource, /await import\('\.\.\/components\/ui\/action-confirm-sheet'\)/u);
  assert.match(suggestionsSource, /'Открыть предложку в редакторе\?'/u);
  assert.match(suggestionsSource, /'Отклонить предложку\?'/u);
  assert.match(
    suggestionsSource,
    /setConfirmation\(\{ suggestionId: suggestion\.id, action: 'draft' \}\)/u,
  );
  assert.match(
    suggestionsSource,
    /setConfirmation\(\{ suggestionId: suggestion\.id, action: 'cancel' \}\)/u,
  );
  assert.match(suggestionsSource, /Отменить это действие нельзя\./u);
  assert.match(
    suggestionsSource,
    /tone=\{confirmation\.action === 'draft' \? 'accent' : 'danger'\}/u,
  );
  assert.match(suggestionsSource, /isBusy=\{reviewMutation\.isPending\}/u);
  assert.match(suggestionsSource, /onClose=\{\(\) => setConfirmation\(null\)\}/u);
  assert.match(suggestionsSource, /action: confirmation\.action/u);
  assert.doesNotMatch(
    suggestionsSource,
    /onClick=\{\(\) =>\s*reviewMutation\.mutate\(\{ suggestionId: suggestion\.id/u,
  );
  assert.match(suggestionsSource, /useInfiniteQuery/u);
  assert.match(suggestionsSource, /requestView: 'pending'/u);
  assert.match(suggestionsSource, /requestView: 'history'/u);
  assert.match(suggestionsSource, /pendingQuery\.data\?\.pages\[0\]\?\.total/u);
  assert.match(suggestionsSource, /historyQuery\.data\?\.pages\[0\]\?\.total/u);
  assert.match(suggestionsSource, /activeQuery\.fetchNextPage\(\)/u);
  assert.match(suggestionsSource, /queryClient\.invalidateQueries\(\{ queryKey: queryRoot \}\)/u);
  assert.match(suggestionsSource, /containsPublishingSuggestion/u);
  assert.match(suggestionsSource, /view === 'pending'/u);
  assert.match(suggestionsSource, /\/publications\?draft=/u);
  assert.match(suggestionsSource, /suggestion\.imageCount > 0/u);
  assert.match(
    suggestionsSource,
    /suggestion\.reviewStatus === 'drafted'[\s\S]*?Открыть черновик/u,
  );
  assert.doesNotMatch(
    suggestionsSource,
    /setConfirmation\(\{ suggestionId: suggestion\.id, action: 'publish' \}\)/u,
  );
  assert.match(suggestionsSource, /<MaxMarkdownPreview/u);
  assert.match(suggestionsSource, /sourceFormat=\{suggestion\.textFormat\}/u);
  assert.match(suggestionsSource, /sourceFormat=\{confirmationSuggestion\.textFormat\}/u);
  assert.doesNotMatch(suggestionsSource, /<p>\{suggestion\.text\}<\/p>/u);
  assert.doesNotMatch(suggestionsSource, /items\.slice\(0, 20\)/u);
  assert.doesNotMatch(suggestionsSource, /Передано в посты/u);
  assert.match(
    modulesCss,
    /\.publisher-suggestion-row__actions button \{[\s\S]*?min-height: 44px;/u,
  );
});
