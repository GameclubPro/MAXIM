import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStatisticsRouteSearch,
  parseChannelStatisticsRouteQuery,
  parseChatStatisticsRouteQuery,
} from '../src/lib/statistics-route-query';

test('channel statistics route restores a valid section and range', () => {
  assert.deepEqual(parseChannelStatisticsRouteQuery('?section=events&range=30d'), {
    section: 'events',
    range: '30d',
  });
});

test('channel statistics route falls back from missing or invalid values', () => {
  assert.deepEqual(parseChannelStatisticsRouteQuery('?section=unknown&range=year'), {
    section: 'overview',
    range: '7d',
  });
});

test('chat statistics route accepts the legacy events section alias', () => {
  assert.deepEqual(parseChatStatisticsRouteQuery('?section=events&range=7d'), {
    section: 'activity',
    range: '7d',
  });
});

test('chat statistics route restores participants and uses safe defaults', () => {
  assert.deepEqual(parseChatStatisticsRouteQuery('?section=participants&range=30d'), {
    section: 'participants',
    range: '30d',
  });
  assert.deepEqual(parseChatStatisticsRouteQuery('?section=unknown&range=year'), {
    section: 'moderation',
    range: '24h',
  });
});

test('statistics route updates preserve unrelated launch parameters', () => {
  const nextSearch = buildStatisticsRouteSearch('?startapp=abc&theme=dark&section=overview', {
    section: 'events',
    range: '24h',
  });
  const params = new URLSearchParams(nextSearch);

  assert.equal(params.get('startapp'), 'abc');
  assert.equal(params.get('theme'), 'dark');
  assert.equal(params.get('section'), 'events');
  assert.equal(params.get('range'), '24h');
  assert.equal(params.size, 4);
});
