import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview channel stats marks empty view buckets with zero posts', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=24h',
  )) as ChannelStatsResponse;
  const currentViews = stats.official.series.views;
  const currentMembership = stats.official.series.membership;
  const currentParticipants = stats.official.series.participants;
  const previousViews = stats.comparison.series?.views ?? [];

  assert.equal(stats.period.bucket, 'hour');
  assert.equal(currentViews.length > 0, true);
  assert.equal(previousViews.length > 0, true);
  assert.deepEqual(
    currentMembership.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  assert.deepEqual(
    currentParticipants.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  for (let index = 1; index < currentViews.length; index += 1) {
    assert.equal(
      Date.parse(currentViews[index]!.at) - Date.parse(currentViews[index - 1]!.at),
      60 * 60 * 1000,
    );
  }
  assert.equal(
    currentViews.some((point) => point.posts > 0),
    true,
  );
  assert.equal(
    currentViews.some((point) => point.posts === 0 && point.views === 0),
    true,
  );
  assert.equal(
    previousViews.every((point) => Number.isInteger(point.posts)),
    true,
  );
  assert.equal(stats.summary.daily.at(-1)?.source, 'flow');
  assert.equal(stats.summary.daily.at(-1)?.confidence, 'medium');
});

test('preview channel stats overview mirrors production lightweight fields', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=7d&mode=overview&includeActivityPreview=false',
  )) as ChannelStatsResponse;
  const expectedAverage = Math.round(
    stats.official.content.views / Math.max(1, stats.official.content.posts),
  );

  assert.equal(stats.official.content.topPosts.length, 0);
  assert.equal(stats.official.content.topReactions.length, 0);
  assert.equal(stats.signals.bestWindows.length, 0);
  assert.equal(stats.comparison.series, undefined);
  assert.equal(stats.comparison.deltas.averageViewsPerPost.current, expectedAverage);
  assert.equal(stats.activityFeed.items.length, 0);
});

test('preview post-age reach metrics stay fixed across chart ranges', async () => {
  const api = createPreviewApiTransport();
  const stats24h = (await api.request(
    '/channels/preview-channel/stats?range=24h&mode=full',
  )) as ChannelStatsResponse;
  const stats30d = (await api.request(
    '/channels/preview-channel/stats?range=30d&mode=full',
  )) as ChannelStatsResponse;

  const { asOf: asOf24h, ...reach24h } = stats24h.summary.reach;
  const { asOf: asOf30d, ...reach30d } = stats30d.summary.reach;
  assert.deepEqual(reach24h, reach30d);
  assert.equal(Number.isFinite(Date.parse(asOf24h ?? '')), true);
  assert.equal(Number.isFinite(Date.parse(asOf30d ?? '')), true);
  assert.equal(stats24h.summary.reach.method, 'post-age-cohort');
  assert.equal(stats24h.summary.reach.coverage24h, 'ready');
  assert.equal(stats24h.summary.reach.coverage48h, 'ready');
  assert.equal(
    stats24h.summary.reach.err48Percent,
    Math.round(
      ((stats24h.summary.reach.averageViews48h ?? 0) /
        (stats24h.summary.reach.subscriberDenominator ?? 1)) *
        100 *
        10,
    ) / 10,
  );
});
