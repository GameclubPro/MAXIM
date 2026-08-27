import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const shellSource = readFileSync(new URL('../src/components/shell.tsx', import.meta.url), 'utf8');
const headerSource = readFileSync(
  new URL('../src/features/publications/publication-hub-header.tsx', import.meta.url),
  'utf8',
);
const headerCss = readFileSync(
  new URL('../src/features/publications/publication-hub-header.css', import.meta.url),
  'utf8',
);
const pickerSource = readFileSync(
  new URL('../src/features/publications/publication-target-picker.tsx', import.meta.url),
  'utf8',
);
const pickerCss = readFileSync(
  new URL('../src/features/publications/publication-target-picker.css', import.meta.url),
  'utf8',
);
const targetNoticesSource = readFileSync(
  new URL('../src/features/publications/publication-target-notices.tsx', import.meta.url),
  'utf8',
);
const targetSourcesSource = readFileSync(
  new URL('../src/features/publications/use-publication-target-sources.ts', import.meta.url),
  'utf8',
);
const publicationsSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const initialTargetSource = readFileSync(
  new URL('../src/features/publications/use-initial-publication-target-route.ts', import.meta.url),
  'utf8',
);
const editorAutofocusSource = readFileSync(
  new URL('../src/features/publications/use-publication-editor-autofocus.ts', import.meta.url),
  'utf8',
);

test('Publik launches directly into Posts without a managed-entity catalog route', () => {
  assert.doesNotMatch(appSource, /LazyPublisherEntitiesPage|publisher-entities-page/u);
  assert.match(appSource, /const profileHomeRoute = me\.homeRoute;/u);
  assert.match(
    appSource,
    /<Route path="\/" element=\{<ProfileHomeRedirect homeRoute=\{profileHomeRoute\} \/>\}/u,
  );
  assert.match(shellSource, /profile === 'publisher' \? '\/publications'/u);
  assert.match(
    shellSource,
    /profile === 'moderation' && \(isChatsRoute \|\| isPublicationsRoute\)/u,
  );
});

test('Posts uses one compact recipient status instead of a second catalog card', () => {
  assert.match(headerSource, /className=\{cn\('publication-publisher-status'/u);
  assert.match(headerSource, /Нет подключений · настройка в Майоре/u);
  assert.match(headerSource, /openMaxBotLink\(setupHandoffUrl\)/u);
  assert.doesNotMatch(headerSource, /<Link|Чаты и каналы|PublisherReadinessOverview/u);
  assert.match(
    headerCss,
    /\.publication-publisher-status \{[\s\S]*?grid-template-columns: 28px minmax\(0, 1fr\) 44px;/u,
  );
  assert.match(
    headerCss,
    /\.publication-publisher-status__copy small \{[\s\S]*?white-space: normal;/u,
  );
});

test('publisher target selection is a full-screen sheet with stable virtual rows', () => {
  const sourceHeight = Number(pickerSource.match(/TARGET_ROW_HEIGHT = (\d+);/u)?.[1]);
  const cssHeight = Number(
    pickerCss.match(
      /\.publication-target-picker__list\.is-virtual \.publication-target-row \{[\s\S]*?height: (\d+)px;/u,
    )?.[1],
  );

  assert.equal(sourceHeight, 58);
  assert.equal(cssHeight, sourceHeight);
  assert.match(pickerSource, /remoteSource && 'is-sheet'/u);
  assert.match(pickerSource, /role=\{remoteSource \? 'dialog' : 'region'\}/u);
  assert.match(pickerSource, /useNativeBackHandler/u);
  assert.match(pickerSource, /useVisualViewportOverlayStyle\(sheetOpen\)/u);
  assert.match(pickerSource, /event\.key !== 'Escape'/u);
  assert.match(
    pickerCss,
    /\.publication-target-picker__editor\.is-sheet \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?z-index: 140;/u,
  );
  assert.match(
    pickerCss,
    /\.publications-page\.is-editor:has\(\.publication-target-picker__editor\)[\s\S]*?\.publications-publish-bar \{[\s\S]*?visibility: hidden;[\s\S]*?pointer-events: none;/u,
  );
});

test('publisher editor keeps its header visible and its dock action within 320px', () => {
  assert.match(editorAutofocusSource, /focus\(\{ preventScroll: true \}\)/u);
  assert.match(
    headerCss,
    /\.publications-page\.is-publisher[\s\S]*?\.broadcast-publish-bar__primary \{[\s\S]*?grid-column: 1 \/ -1;/u,
  );
});

test('unavailable targets are truly disabled unless already selected for removal', () => {
  assert.match(pickerSource, /disabled=\{disabled \|\| \(unavailable && !selected\)\}/u);
  assert.doesNotMatch(pickerCss, /publication-target-row\.is-unavailable \{\s*opacity:/u);
});

test('next-page retry preserves pages and expired cursors reseed the query', () => {
  assert.match(targetSourcesSource, /readiness: 'ready'/u);
  assert.match(targetSourcesSource, /const result = await publisher\.fetchNextPage\(\)/u);
  assert.match(targetSourcesSource, /isInvalidPublisherEntitiesCursorError\(result\.error\)/u);
  assert.match(targetSourcesSource, /resetQueries\(\{ queryKey: publisherQueryKey, exact: true \}\)/u);
  assert.doesNotMatch(
    targetSourcesSource,
    /fetchNextPage:\s*\(\) =>\s*publisher\.isFetchNextPageError/u,
  );
});

test('direct-target errors stay actionable and validation issues persist after submit', () => {
  assert.match(targetNoticesSource, /Получатель из ссылки пока не готов/u);
  assert.match(targetNoticesSource, /initialRoute\.retry/u);
  assert.match(publicationsSource, /issues=\{validationStarted \? validationIssues : \[\]\}/u);
  assert.match(initialTargetSource, /routeFailure\?\.routeKey === routeKey/u);
  assert.match(initialTargetSource, /appliedRouteRef\.current === routeKey/u);
});
