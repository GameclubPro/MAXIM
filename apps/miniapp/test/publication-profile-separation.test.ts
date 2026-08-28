import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripPublisherOnlyPublicationRouteParams } from '../src/features/publications/publication-page-options';

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const publicationsSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const targetSourcesSource = readFileSync(
  new URL('../src/features/publications/use-publication-target-sources.ts', import.meta.url),
  'utf8',
);
const composerSource = readFileSync(
  new URL('../src/features/publications/use-publication-composer.ts', import.meta.url),
  'utf8',
);
const detailsSource = readFileSync(
  new URL('../src/features/publications/publication-details-sheet.tsx', import.meta.url),
  'utf8',
);
const feedCardSource = readFileSync(
  new URL('../src/features/publications/publication-feed-card.tsx', import.meta.url),
  'utf8',
);
const reviewSheetSource = readFileSync(
  new URL('../src/components/broadcast-publish-review-sheet.tsx', import.meta.url),
  'utf8',
);
const majorHandoffSource = readFileSync(
  new URL('../src/components/publication-workspace-handoff.tsx', import.meta.url),
  'utf8',
);
const chatSettingsSource = readFileSync(
  new URL('../src/pages/settings-page.legacy.tsx', import.meta.url),
  'utf8',
);
const channelSettingsSource = readFileSync(
  new URL('../src/pages/channel-settings-page.tsx', import.meta.url),
  'utf8',
);

test('publication route binds an explicit workspace profile', () => {
  assert.match(
    appSource,
    /moderationProfile \? \([\s\S]*?path="\/publications"[\s\S]*?profile="moderation"[\s\S]*?profile="publisher"/u,
  );
  assert.doesNotMatch(appSource, /LazyPublicationsPage api=\{apiClient\} profile=\{me\.profile\}/u);
});

test('Major keeps legacy-routed management but cannot enter the publication editor', () => {
  assert.match(
    publicationsSource,
    /const isEditor = isPublisherProfile && editorContext !== null;/u,
  );
  assert.match(
    publicationsSource,
    /if \(!isPublisherProfile \|\| !hydrated \|\| initialComposeRouteAppliedRef\.current\)/u,
  );
  assert.match(publicationsSource, /stripPublisherOnlyPublicationRouteParams\(searchParams\)/u);
  assert.match(
    publicationsSource,
    /canEdit=\{isPublisherProfile && actionCapabilities\.canEdit\}/u,
  );
  assert.match(publicationsSource, /canDuplicate=\{isPublisherProfile\}/u);
  assert.match(publicationsSource, /allowEdit=\{isPublisherProfile\}/u);
  assert.match(publicationsSource, /isPublisherProfile && hasSavedDraft/u);
  assert.match(publicationsSource, /isPublisherProfile &&[\s\S]*?publisherCanCreate/u);
  assert.match(publicationsSource, /enabled: !isEditor && !isLegacyView/u);
  assert.match(detailsSource, /allowEdit && actionCapabilities\.canEdit/u);
});

test('Major drops direct composer and target routes without changing list filters', () => {
  const sanitized = stripPublisherOnlyPublicationRouteParams(
    new URLSearchParams(
      'compose=1&create=1&draft=draft-1&import=import_token_123456&entityType=chat&entityId=chat-1&view=schedules&status=paused&legacy=1',
    ),
  );

  assert.equal(sanitized?.toString(), 'view=schedules&status=paused&legacy=1');
  assert.equal(stripPublisherOnlyPublicationRouteParams(new URLSearchParams('view=history')), null);
});

test('Major never hydrates drafts or publication targets', () => {
  assert.match(
    publicationsSource,
    /usePublicationComposer\([\s\S]*?persistenceEnabled,[\s\S]*?isPublisherProfile/u,
  );
  assert.match(publicationsSource, /usePublicationTargetSources\(api, isPublisherProfile\)/u);
  assert.match(composerSource, /if \(!enabled\) \{[\s\S]*?setHydrated\(true\)/u);
  assert.match(targetSourcesSource, /enabled,[\s\S]*?staleTime: 15_000/u);
  assert.doesNotMatch(targetSourcesSource, /root-client|getChats|getChannels/u);
});

test('publication editor and details preserve the server text format', () => {
  assert.match(publicationsSource, /sourceFormat=\{draft\.textFormat\}/u);
  assert.match(
    publicationsSource,
    /setDraft\(\(current\) => \(\{ \.\.\.current, text, textFormat: 'markdown' \}\)\)/u,
  );
  assert.match(detailsSource, /sourceFormat=\{details\.content\.textFormat\}/u);
  assert.match(publicationsSource, /previewFormat=\{publication\.contentPreviewFormat\}/u);
  assert.match(feedCardSource, /sourceFormat=\{previewFormat\}/u);
  assert.match(
    publicationsSource,
    /<BroadcastPublishReviewSheet[\s\S]*?text=\{draft\.text\}[\s\S]*?sourceFormat=\{draft\.textFormat\}/u,
  );
  assert.match(reviewSheetSource, /sourceFormat=\{sourceFormat\}/u);
  assert.doesNotMatch(publicationsSource, /<small>\{draft\.text\.trim\(\)/u);
  assert.match(
    publicationsSource,
    /sourceFormat=\{actionTarget\.publication\.contentPreviewFormat\}/u,
  );
});

test('Major settings open legacy schedules without a dead compose handoff', () => {
  assert.match(majorHandoffSource, /to="\/publications"/u);
  assert.match(majorHandoffSource, />Расписания</u);
  assert.doesNotMatch(majorHandoffSource, /compose=1|создать/iu);
  assert.doesNotMatch(chatSettingsSource, /\/publications\?compose=1/u);
  assert.doesNotMatch(channelSettingsSource, /\/publications\?compose=1/u);
});
