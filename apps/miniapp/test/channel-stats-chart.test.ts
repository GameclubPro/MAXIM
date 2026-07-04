import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isChannelStatsResponseForRange,
  resolveAudienceChartAverageGrowthLabel,
  resolveAudienceChartDisplayValue,
  resolveAverageViewsFromSeries,
  resolveChannelStatsAverageViews,
  resolveInitialAudienceChartIndex,
  shouldRenderChannelStatsPointMarkers,
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

test('audience chart prefers membership flow over stale carried participant snapshots', () => {
  const points = [
    { participantsCount: 3_567, joined: 0, left: 0, cumulativeNet: 0 },
    { participantsCount: 3_567, joined: 32, left: 21, cumulativeNet: 11 },
    { participantsCount: 3_567, joined: 42, left: 17, cumulativeNet: 36 },
    { participantsCount: 3_567, joined: 38, left: 19, cumulativeNet: 55 },
    { participantsCount: 3_567, joined: 44, left: 11, cumulativeNet: 88 },
    { participantsCount: 3_567, joined: 44, left: 22, cumulativeNet: 110 },
    { participantsCount: 3_718, joined: 52, left: 10, cumulativeNet: 152 },
    { participantsCount: 3_721, joined: 8, left: 3, cumulativeNet: 157 },
  ];

  assert.deepEqual(
    points.map((point) => resolveAudienceChartDisplayValue(point, 3_721, 157, true)),
    [3_564, 3_575, 3_600, 3_619, 3_652, 3_674, 3_716, 3_721],
  );
  assert.deepEqual(
    points.map((point) => resolveAudienceChartDisplayValue(point, 3_721, 157, false)),
    [3_567, 3_567, 3_567, 3_567, 3_567, 3_567, 3_718, 3_721],
  );

  assert.equal(
    resolveAudienceChartDisplayValue(
      { participantsCount: null, joined: 150, left: 0, cumulativeNet: 150 },
      3_721,
      150,
      false,
    ),
    3_721,
  );
});

test('falls back to known audience totals when per-bucket activity is absent', () => {
  assert.equal(
    resolveInitialAudienceChartIndex([
      { participantsCount: null, joined: 0, left: 0, cumulativeNet: 0 },
      { participantsCount: 240, joined: 0, left: 0, cumulativeNet: 0 },
      { participantsCount: 240, joined: 0, left: 0, cumulativeNet: 0 },
    ]),
    2,
  );
});

test('returns zero average views per post when period views are absent', () => {
  const stats = {
    official: {
      content: {
        views: 0,
        posts: 4,
      },
    },
  };

  assert.equal(resolveChannelStatsAverageViews(stats), 0);
});

test('derives average views from period content totals before graph points', () => {
  const stats = {
    official: {
      content: {
        views: 10_500,
        posts: 8,
      },
      series: {
        views: [
          { posts: 1, views: 1_000 },
          { posts: 1, views: 1_000 },
          { posts: 1, views: 2_000 },
          { posts: 1, views: 2_000 },
          { posts: 1, views: 1_000 },
          { posts: 1, views: 2_000 },
          { posts: 1, views: 1_500 },
        ],
      },
    },
  };

  assert.equal(resolveAverageViewsFromSeries(stats.official.series.views), 1_500);
  assert.equal(resolveChannelStatsAverageViews(stats), 1_313);
});

test('keeps real zero-view post buckets but skips empty view gaps', () => {
  assert.equal(
    resolveAverageViewsFromSeries([
      { posts: 1, views: 1_000 },
      { posts: 1, views: 0 },
      { posts: 0, views: 0 },
      { posts: 1, views: 2_000 },
    ]),
    1_000,
  );

  assert.equal(
    resolveAverageViewsFromSeries([
      { posts: 1, views: 500 },
      { posts: 0, views: 0 },
      { posts: 2, views: 650 },
    ]),
    600,
  );
});

test('prefers selected-period average over last-day summary average', () => {
  const stats = {
    official: {
      content: {
        posts: 5,
        views: 1_025,
      },
      series: {
        views: [
          { posts: 1, views: 1_000 },
          { posts: 1, views: 2_000 },
          { posts: 1, views: 1_500 },
        ],
      },
    },
    summary: {
      views: {
        perPost: 260,
      },
    },
    comparison: {
      deltas: {
        averageViewsPerPost: {
          current: 205,
        },
      },
    },
  };

  assert.equal(resolveChannelStatsAverageViews(stats), 205);
});

test('accepts cached channel stats only for the requested channel and range', () => {
  const stats = {
    channel: {
      id: 'channel-1',
    },
    period: {
      range: '7d',
    },
    official: {
      content: {
        posts: 1,
        views: 100,
      },
    },
  };

  assert.equal(isChannelStatsResponseForRange(stats, 'channel-1', '7d'), true);
  assert.equal(isChannelStatsResponseForRange(stats, 'channel-1', '24h'), false);
  assert.equal(isChannelStatsResponseForRange(stats, 'channel-2', '7d'), false);
  assert.equal(isChannelStatsResponseForRange(null, 'channel-1', '7d'), false);
});

test('does not render point markers for the 24 hour channel stats range', () => {
  assert.equal(shouldRenderChannelStatsPointMarkers('24h', 24), false);
  assert.equal(shouldRenderChannelStatsPointMarkers('24h', 25), false);
  assert.equal(shouldRenderChannelStatsPointMarkers('7d', 7), true);
  assert.equal(shouldRenderChannelStatsPointMarkers('30d', 30), false);
});

test('labels audience chart average growth by bucket granularity', () => {
  assert.equal(resolveAudienceChartAverageGrowthLabel('hour'), 'В час');
  assert.equal(resolveAudienceChartAverageGrowthLabel('day'), 'В день');
});
