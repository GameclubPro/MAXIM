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
const summarySource = readFileSync(
  new URL('../src/features/publications/publisher-readiness-overview.tsx', import.meta.url),
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

  assert.equal(sourceHeight, 196);
  assert.equal(cssHeight, sourceHeight);
  assert.match(pageCss, /overflow-y: auto;[\s\S]*?touch-action: pan-y;/u);
  assert.match(
    pageCss,
    /padding-bottom: calc\([\s\S]*?var\(--bottom-nav-height\)[\s\S]*?scroll-padding-bottom: calc\(/u,
  );
});

test('publisher entity actions keep native touch targets at least 44px tall', () => {
  assert.match(pageCss, /\.publisher-entity-row__primary \{[\s\S]*?min-height: 44px;/u);
  assert.match(
    pageCss,
    /\.publisher-entity-row__refresh \{\s*width: 44px;\s*min-width: 44px;\s*height: 44px;/u,
  );
});

test('publisher searches hide stale rows and expired cursors restart from page one', () => {
  assert.match(pageSource, /const searchSettling = query\.trim\(\) !== debouncedQuery/u);
  assert.match(pageSource, /searchSettling \? \(/u);
  assert.match(pickerSource, /remoteSource\.settling/u);
  assert.match(targetSourcesSource, /isFetchNextPageError[\s\S]*?resetQueries/u);
  assert.doesNotMatch(pageSource, /setQueriesData/u);
});

test('expanded target picker removes the fixed publish dock from mobile hit testing', () => {
  assert.match(
    pickerCss,
    /@media \(max-width: 719px\), \(max-height: 719px\) \{[\s\S]*?\.publications-page\.is-editor:has\(\.publication-target-picker__editor\)[\s\S]*?\.publications-publish-bar \{[\s\S]*?visibility: hidden;[\s\S]*?opacity: 0;[\s\S]*?pointer-events: none;/u,
  );
});

test('publication hub links to the full cabinet instead of hiding a second catalog', () => {
  assert.match(summarySource, /<Link to="\/" className="publisher-readiness-overview__link">/u);
  assert.doesNotMatch(summarySource, /useState|publisher-readiness-overview__list/u);
});

test('publication hub summary resets its native refresh button chrome', () => {
  const summaryCss = readFileSync(
    new URL('../src/features/publications/publisher-readiness-overview.css', import.meta.url),
    'utf8',
  );

  assert.match(summaryCss, /\.publisher-readiness-overview__link \{[\s\S]*?min-height: 44px;/u);
  assert.match(
    summaryCss,
    /\.publisher-readiness-overview__refresh \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/u,
  );
});
