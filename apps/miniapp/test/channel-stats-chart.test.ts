import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveAverageViewsFromSeries,
  resolveChannelStatsAverageViews,
  resolveChannelStatsDisplayViews,
  resolveChannelStatsViewsModeLabel,
  resolveInitialAudienceChartIndex,
  resolveInitialViewsChartIndex,
  shouldUseChannelStatsPeriodViews,
} from '../src/lib/channel-stats-chart';

test('selects the latest informative audience bucket instead of a trailing zero bucket', () => {
  assert.equal(
    resolveInitialAudienceChartIndex([
      { participantsCount: 120, joined: 0, left: 0, cumulativeNet: 0 },
      { participantsCount: 124, joined: 5, left: 1, cumulativeNet: 4 },
      { participantsCount: 124, joined: 0, left: 0, cumulativeNet: 4 },
    ]),
    2,
  );

  assert.equal(
    resolveInitialAudienceChartIndex([
      { participantsCount: 120, joined: 1, left: 0, cumulativeNet: 1 },
      { participantsCount: 119, joined: 0, left: 1, cumulativeNet: 0 },
      { participantsCount: 119, joined: 0, left: 0, cumulativeNet: 0 },
    ]),
    1,
  );
});

test('falls back to known audience and view totals when per-bucket activity is absent', () => {
  assert.equal(
    resolveInitialAudienceChartIndex([
      { participantsCount: null, joined: 0, left: 0, cumulativeNet: 0 },
      { participantsCount: 240, joined: 0, left: 0, cumulativeNet: 0 },
      { participantsCount: 240, joined: 0, left: 0, cumulativeNet: 0 },
    ]),
    2,
  );

  assert.equal(
    resolveInitialViewsChartIndex([
      { views: 0, cumulativeViews: 0 },
      { views: 0, cumulativeViews: 300 },
      { views: 0, cumulativeViews: 300 },
    ]),
    2,
  );
});

test('selects the latest non-zero views bucket before the current empty bucket', () => {
  assert.equal(
    resolveInitialViewsChartIndex([
      { views: 80, cumulativeViews: 80 },
      { views: 160, cumulativeViews: 240 },
      { views: 0, cumulativeViews: 240 },
    ]),
    1,
  );
});

test('does not use post lifetime totals when observed view deltas are not available', () => {
  const stats = {
    official: {
      content: {
        views: 0,
        viewsTotal: 12_400,
        viewsMode: 'observedDelta' as const,
        posts: 4,
      },
    },
  };

  assert.equal(resolveChannelStatsDisplayViews(stats), 0);
  assert.equal(resolveChannelStatsAverageViews(stats), 0);
  assert.equal(shouldUseChannelStatsPeriodViews(stats), true);
  assert.equal(resolveChannelStatsViewsModeLabel(stats), 'за период');
});

test('keeps period views primary when observed deltas exist', () => {
  const stats = {
    official: {
      content: {
        views: 3_200,
        viewsTotal: 15_000,
        viewsMode: 'observedDelta' as const,
        posts: 8,
      },
    },
  };

  assert.equal(resolveChannelStatsDisplayViews(stats), 3_200);
  assert.equal(resolveChannelStatsAverageViews(stats), 400);
  assert.equal(shouldUseChannelStatsPeriodViews(stats), true);
  assert.equal(resolveChannelStatsViewsModeLabel(stats), 'за период');
});

test('derives average views from daily graph points', () => {
  const stats = {
    official: {
      content: {
        views: 10_500,
        viewsTotal: 20_000,
        viewsMode: 'observedDelta' as const,
        posts: 8,
      },
      series: {
        views: [
          { views: 1_000, cumulativeViews: 1_000 },
          { views: 1_000, cumulativeViews: 2_000 },
          { views: 2_000, cumulativeViews: 4_000 },
          { views: 2_000, cumulativeViews: 6_000 },
          { views: 1_000, cumulativeViews: 7_000 },
          { views: 2_000, cumulativeViews: 9_000 },
          { views: 1_500, cumulativeViews: 10_500 },
        ],
      },
    },
  };

  assert.equal(resolveAverageViewsFromSeries(stats.official.series.views), 1_500);
  assert.equal(resolveChannelStatsAverageViews(stats), 1_500);
});

test('keeps displayed zero buckets in average views', () => {
  assert.equal(
    resolveAverageViewsFromSeries([
      { views: 1_000, cumulativeViews: 1_000 },
      { views: 0, cumulativeViews: 1_000 },
      { views: 2_000, cumulativeViews: 3_000 },
    ]),
    1_000,
  );
});

test('prefers graph point average over period views per post', () => {
  const stats = {
    official: {
      content: {
        posts: 5,
        views: 1_250,
        viewsTotal: 9_000,
        viewsMode: 'observedDelta' as const,
      },
      series: {
        views: [
          { views: 1_000, cumulativeViews: 1_000 },
          { views: 2_000, cumulativeViews: 3_000 },
          { views: 1_500, cumulativeViews: 4_500 },
        ],
      },
    },
    comparison: {
      deltas: {
        averageViewsPerPost: {
          current: 260,
        },
      },
    },
  };

  assert.equal(resolveChannelStatsDisplayViews(stats), 1_250);
  assert.equal(resolveChannelStatsAverageViews(stats), 1_500);
});
