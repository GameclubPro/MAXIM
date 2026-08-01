import assert from 'node:assert/strict';
import test from 'node:test';
import { getChannelStats } from '../src/lib/api/channel-stats-client';
import type { ApiTransport } from '../src/lib/api/transport';
import { channelStatsQueryKey } from '../src/lib/query-key-builders';

test('channel stats query keys isolate overview and full payloads', () => {
  assert.deepEqual(channelStatsQueryKey('channel-1', '7d'), [
    'channel-stats',
    'channel-1',
    '7d',
    'overview',
  ]);
  assert.notDeepEqual(
    channelStatsQueryKey('channel-1', '7d', 'overview'),
    channelStatsQueryKey('channel-1', '7d', 'full'),
  );
});

test('full channel stats requests declare their payload mode', async () => {
  let requestedPath = '';
  const api: ApiTransport = {
    async request(path) {
      requestedPath = path;
      return {};
    },
    requestKeepalive() {},
  };

  await getChannelStats(
    api,
    'channel-1',
    '30d',
    {},
    { includeActivityPreview: false, mode: 'full' },
  );

  const url = new URL(requestedPath, 'https://miniapp.local');
  assert.equal(url.pathname, '/channels/channel-1/stats');
  assert.equal(url.searchParams.get('range'), '30d');
  assert.equal(url.searchParams.get('mode'), 'full');
  assert.equal(url.searchParams.get('includeActivityPreview'), 'false');
});
