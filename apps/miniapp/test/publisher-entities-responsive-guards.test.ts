import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pageSource = readFileSync(
  new URL('../src/pages/publisher-entities-page.tsx', import.meta.url),
  'utf8',
);
const pageCss = readFileSync(
  new URL('../src/pages/publisher-entities-page.css', import.meta.url),
  'utf8',
);
const pickerSource = readFileSync(
  new URL('../src/features/publications/publication-target-picker.tsx', import.meta.url),
  'utf8',
);
const targetSourcesSource = readFileSync(
  new URL('../src/features/publications/use-publication-target-sources.ts', import.meta.url),
  'utf8',
);
const pickerCss = readFileSync(
  new URL('../src/features/publications/publication-target-picker.css', import.meta.url),
  'utf8',
);

test('publisher virtual list uses the same stable row height in TypeScript and CSS', () => {
  const sourceHeight = Number(pageSource.match(/PUBLISHER_ENTITY_ROW_HEIGHT = (\d+);/u)?.[1]);
  const cssHeight = Number(
    pageCss.match(
      /\.publisher-entities-page__list\.is-virtual \.publisher-entity-row \{[\s\S]*?height: (\d+)px;/u,
    )?.[1],
  );

  assert.equal(sourceHeight, 154);
  assert.equal(cssHeight, sourceHeight);
  assert.match(pageCss, /overflow-y: auto;[\s\S]*?touch-action: pan-y;/u);
  assert.match(
    pageCss,
    /padding-bottom: calc\([\s\S]*?var\(--bottom-nav-height\)[\s\S]*?scroll-padding-bottom: calc\(/u,
  );
});

test('publisher entity actions keep native touch targets at least 44px tall', () => {
  assert.match(pageCss, /\.publisher-entity-row__module-action \{[\s\S]*?min-height: 44px;/u);
  assert.match(
    pageCss,
    /\.publisher-entity-row__refresh \{\s*width: 44px;\s*min-width: 44px;\s*height: 44px;/u,
  );
});

test('publisher searches hide stale rows and next-page retries preserve loaded pages', () => {
  assert.match(pageSource, /const searchSettling = query\.trim\(\) !== debouncedQuery/u);
  assert.match(pageSource, /searchSettling \? \(/u);
  assert.match(pickerSource, /remoteSource\.settling/u);
  assert.match(targetSourcesSource, /isFetchNextPageError[\s\S]*?resetQueries/u);
  assert.match(
    pageSource,
    /retryPublisherEntitiesNextPage\(\{[\s\S]*?fetchNextPage: \(\) => entitiesQuery\.fetchNextPage\(\)[\s\S]*?resetInvalidCursor:/u,
  );
  assert.doesNotMatch(
    pageSource,
    /entitiesQuery\.isFetchNextPageError\s*\?\s*queryClient\.resetQueries/u,
  );
  assert.doesNotMatch(pageSource, /setQueriesData/u);
});

test('expanded target picker removes the fixed publish dock from mobile hit testing', () => {
  assert.match(
    pickerCss,
    /\.publications-page\.is-editor:has\(\.publication-target-picker__editor\)[\s\S]*?\.publications-publish-bar \{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/u,
  );
});

test('publisher catalog relies on bottom navigation without duplicate type tabs', () => {
  assert.doesNotMatch(pageSource, /SegmentedControl|publisher-entities-page__tabs/u);
  assert.match(pageSource, /view === 'channel' \? 'Каналы' : 'Чаты'/u);
  assert.match(pageSource, /Добавьте Публик/u);
  assert.match(pageSource, /buildPublisherEntityModulesRoute\(entity\)/u);
  assert.doesNotMatch(pageSource, /suggestionsViaPublik: enabled/u);
});
