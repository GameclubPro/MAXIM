import assert from 'node:assert/strict';
import test from 'node:test';
import { banChannelMember, getChannelStats } from '../src/lib/api/channel-stats-client';
import type { ApiTransport } from '../src/lib/api/transport';
import { channelStatsQueryKey } from '../src/lib/query-key-builders';

test('channel ban uses the exact channel and member with no broad scope payload', async () => {
  const calls: Array<[string, RequestInit | undefined]> = [];
  const api: ApiTransport = {
    async request(path, init) {
      calls.push([path, init]);
      return { ok: true };
    },
    requestKeepalive() {},
  };
  await banChannelMember(api, ' channel/one ', ' user/2 ');
  assert.deepEqual(calls, [
    [
      '/channels/channel%2Fone/members/user%2F2/ban',
      { method: 'POST', timeoutMs: 55_000, retryMutationOnTransportError: false },
    ],
  ]);
  await assert.rejects(banChannelMember(api, '', 'user-1'));
  await assert.rejects(banChannelMember(api, 'channel-1', ' '));
  assert.equal(calls.length, 1);
});

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
