import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isChannelStatsResponseForRange,
  resolveAverageViewsFromSeries,
  resolveChannelStatsAverageViews,
  resolveInitialAudienceChartIndex,
  resolveInitialViewsChartIndex,
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
      { views: 0 },
      { views: 0 },
      { views: 0 },
    ]),
    2,
  );
});

test('selects the latest non-zero views bucket before the current empty bucket', () => {
  assert.equal(
    resolveInitialViewsChartIndex([
      { views: 80 },
      { views: 160 },
      { views: 0 },
    ]),
    1,
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
          { views: 1_000 },
          { views: 1_000 },
          { views: 2_000 },
          { views: 2_000 },
          { views: 1_000 },
          { views: 2_000 },
          { views: 1_500 },
        ],
      },
    },
  };

  assert.equal(resolveAverageViewsFromSeries(stats.official.series.views), 1_500);
  assert.equal(resolveChannelStatsAverageViews(stats), 1_313);
});

test('keeps displayed zero buckets in average views', () => {
  assert.equal(
    resolveAverageViewsFromSeries([{ views: 1_000 }, { views: 0 }, { views: 2_000 }]),
    1_000,
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
        views: [{ views: 1_000 }, { views: 2_000 }, { views: 1_500 }],
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
