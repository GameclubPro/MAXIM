import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isChannelStatsResponseForRange,
  resolveAudienceChartAverageGrowthLabel,
  resolveAudienceChartDisplayValue,
  resolveAverageViewsFromSeries,
  resolveChannelStatsAverageViews,
  resolveChannelStatsSliderIndex,
  resolveInitialAudienceChartIndex,
  shouldPreferMembershipFlowForAudienceChart,
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

test('audience chart uses backend participant values instead of local flow reconstruction', () => {
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
    [3_567, 3_567, 3_567, 3_567, 3_567, 3_567, 3_718, 3_721],
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
    null,
  );
});

test('audience chart does not reconstruct a zero history from an unbaselined import burst', () => {
  const points = [
    { participantsCount: null, joined: 0, left: 0, cumulativeNet: 0 },
    { participantsCount: null, joined: 0, left: 0, cumulativeNet: 0 },
    { participantsCount: null, joined: 250, left: 0, cumulativeNet: 250 },
    { participantsCount: 250, joined: 0, left: 0, cumulativeNet: 250 },
  ];

  assert.equal(shouldPreferMembershipFlowForAudienceChart(points, 250, true), false);
  assert.deepEqual(
    points.map((point) => resolveAudienceChartDisplayValue(point, null, 250, false)),
    [null, null, null, 250],
  );
  assert.deepEqual(
    points.map((point) => resolveAudienceChartDisplayValue(point, 250, 250, false)),
    [null, null, null, 250],
  );
});

test('audience chart does not choose frontend membership flow after an earlier audience baseline', () => {
  const points = [
    { participantsCount: 100, joined: 0, left: 0, cumulativeNet: 0 },
    { participantsCount: 100, joined: 12, left: 2, cumulativeNet: 10 },
    { participantsCount: 100, joined: 4, left: 1, cumulativeNet: 13 },
  ];

  assert.equal(shouldPreferMembershipFlowForAudienceChart(points, 113, true), false);
});

test('audience chart keeps first-active-bucket values from backend participants', () => {
  const points = [
    { participantsCount: 4_008, joined: 41, left: 11, cumulativeNet: 30 },
    { participantsCount: 4_008, joined: 36, left: 11, cumulativeNet: 55 },
    { participantsCount: 4_100, joined: 37, left: 0, cumulativeNet: 92 },
  ];

  assert.equal(shouldPreferMembershipFlowForAudienceChart(points, 4_100, true), false);
  assert.deepEqual(
    points.map((point) => resolveAudienceChartDisplayValue(point, 4_100, 92, true)),
    [4_008, 4_008, 4_100],
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

test('does not render unavailable channel views as a real zero', () => {
  const stats = {
    official: {
      content: {
        views: 0,
        posts: 0,
      },
    },
    meta: {
      viewsAvailable: false,
    },
  };

  assert.equal(resolveChannelStatsAverageViews(stats), null);
});

test('channel chart slider supports arrows and boundary keys', () => {
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'ArrowLeft'), 1);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'ArrowDown'), 1);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'ArrowRight'), 3);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'ArrowUp'), 3);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'Home'), 0);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'End'), 4);
  assert.equal(resolveChannelStatsSliderIndex(2, 5, 'Enter'), null);
  assert.equal(resolveChannelStatsSliderIndex(0, 5, 'ArrowLeft'), 0);
  assert.equal(resolveChannelStatsSliderIndex(4, 5, 'ArrowRight'), 4);
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
