import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const eventsPageSource = readFileSync(
  new URL('../src/pages/events-page.tsx', import.meta.url),
  'utf8',
);
const channelStatsPageSource = readFileSync(
  new URL('../src/pages/channel-stats-page.tsx', import.meta.url),
  'utf8',
);
const chatsPageSource = readFileSync(
  new URL('../src/pages/chats-page.tsx', import.meta.url),
  'utf8',
);

test('chat statistics identity only consumes a dashboard validated for the current route', () => {
  assert.match(
    eventsPageSource,
    /const dashboard =\s*chatId && isLogsDashboardResponseForRange\(dashboardQuery\.data, chatId, range\)/u,
  );
  assert.match(eventsPageSource, /remoteTitle: currentDashboardIdentity\?\.chat\.title/u);
  assert.match(eventsPageSource, /remoteFallbackTitles: chatId/u);
  assert.match(
    eventsPageSource,
    /const fromDashboard = currentDashboardIdentity\?\.chat\.avatarUrl/u,
  );
  assert.match(eventsPageSource, /chatTitleResolution\.source === 'fallback'/u);
  assert.match(
    eventsPageSource,
    /dashboard && !dashboardQuery\.isPlaceholderData \? dashboard : null/u,
  );
  assert.match(
    eventsPageSource,
    /chatTitleResolution\.source === 'remote'[\s\S]*?dashboardQuery\.isFetching[\s\S]*?dashboardQuery\.isRefetchError[\s\S]*?dashboardQuery\.dataUpdatedAt <= 0/u,
  );
  assert.doesNotMatch(eventsPageSource, /remoteTitle: dashboardQuery\.data\?\.chat\.title/u);
});

test('channel statistics identity rejects cross-channel placeholder data', () => {
  assert.match(
    channelStatsPageSource,
    /const stats = isChannelStatsResponseForRange\(statsQuery\.data, chatId, range\)/u,
  );
  assert.match(channelStatsPageSource, /remoteTitle: currentStatsIdentity\?\.channel\.title/u);
  assert.match(channelStatsPageSource, /remoteFallbackTitles: \[/u);
  assert.match(channelStatsPageSource, /resolvedTitleResolution\.source === 'fallback'/u);
  assert.match(channelStatsPageSource, /stats && !statsQuery\.isPlaceholderData \? stats : null/u);
  assert.match(
    channelStatsPageSource,
    /resolvedTitleResolution\.source === 'remote'[\s\S]*?statsQuery\.isFetching[\s\S]*?statsQuery\.isRefetchError[\s\S]*?statsQuery\.dataUpdatedAt <= 0/u,
  );
  assert.doesNotMatch(channelStatsPageSource, /remoteTitle: statsQuery\.data\?\.channel\.title/u);
});

test('statistics pages expose truthful unavailable and partial metric states', () => {
  assert.match(eventsPageSource, /participantsTotalPresentation\.status === 'loading'/u);
  assert.match(eventsPageSource, /Количество участников недоступно/u);
  assert.match(eventsPageSource, /className="events-dashboard__hero-number"/u);
  assert.match(channelStatsPageSource, /metric\.coverage === 'insufficient'/u);
  assert.match(channelStatsPageSource, /resolveChannelReachMetric\(summary\.reach/u);
  assert.match(channelStatsPageSource, /Недостаточно данных/u);
  assert.doesNotMatch(channelStatsPageSource, /resolveTopPostsAverageSince/u);
  assert.doesNotMatch(channelStatsPageSource, /Реакции от просмотров/u);
  assert.match(channelStatsPageSource, /!stats \|\| !stats\.meta\.churnAvailable/u);
});

test('channel statistics keep overview and full request caches isolated', () => {
  assert.match(
    channelStatsPageSource,
    /queryKey: queryKeys\.channelStats\(chatId, range, 'full'\)/u,
  );
  assert.match(channelStatsPageSource, /includeActivityPreview: false,\s*mode: 'full'/u);
  assert.match(
    chatsPageSource,
    /const range = preference\.range \?\? DEFAULT_CHANNEL_STATS_RANGE/u,
  );
  assert.match(chatsPageSource, /channelStatsQueryKey\(chatId, range, 'overview'\)/u);
  assert.match(chatsPageSource, /includeActivityPreview: false,\s*mode: 'overview'/u);
});

test('statistics navigation and chart controls retain explicit semantics', () => {
  assert.match(
    eventsPageSource,
    /<ManagedEntityWorkspaceHeader[\s\S]*?entityType="chat"[\s\S]*?screen="stats"[\s\S]*?counterpartTo=\{buildManagedEntitySettingsRoute\('chat', chatId\)\}/u,
  );
  assert.match(
    channelStatsPageSource,
    /<ManagedEntityWorkspaceHeader[\s\S]*?entityType="channel"[\s\S]*?screen="stats"[\s\S]*?counterpartTo=\{buildManagedEntitySettingsRoute\('channel', chatId\)\}/u,
  );
  assert.match(
    eventsPageSource,
    /className="events-screen page-enter" data-managed-entity-workspace/u,
  );
  assert.match(
    channelStatsPageSource,
    /className="channel-insights page-enter" data-managed-entity-workspace/u,
  );
  assert.doesNotMatch(
    channelStatsPageSource,
    /useAutoHideHeader|isHeaderHidden|<CompactStickyHeader/u,
  );
  for (const source of [eventsPageSource, channelStatsPageSource]) {
    assert.match(source, /createManagedEntityWorkspaceState\(/u);
    assert.match(source, /mergeManagedEntityStatsPreference\(/u);
    assert.match(source, /mergeManagedEntityWorkspaceRouteState\(routeState, workspace\)/u);
  }
  assert.match(channelStatsPageSource, /resolveChannelStatsSliderIndex\(/u);
  assert.match(channelStatsPageSource, /channel-posts-chart__row--linked/u);
  assert.match(channelStatsPageSource, /IconOpenNewWindow/u);
  assert.match(channelStatsPageSource, /откроется в новой вкладке/u);
});
