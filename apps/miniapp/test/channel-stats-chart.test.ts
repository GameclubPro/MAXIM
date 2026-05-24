import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveInitialAudienceChartIndex,
  resolveInitialViewsChartIndex,
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
