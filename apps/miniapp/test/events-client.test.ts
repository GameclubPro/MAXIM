import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatParticipantsPage } from '../src/lib/api/events-client';
import type { ApiTransport } from '../src/lib/api/transport';

test('participant requests keep the selected period and role filter server-side', async () => {
  let requestedPath = '';
  const api: ApiTransport = {
    async request(path) {
      requestedPath = path;
      return { items: [], totalCount: 0, hasMore: false, nextCursor: null };
    },
    requestKeepalive() {},
  };

  await getChatParticipantsPage(api, 'chat-1', {
    range: '30d',
    roleFilter: 'admins',
    limit: 24,
    search: 'Иван',
  });

  const url = new URL(requestedPath, 'https://miniapp.local');
  assert.equal(url.pathname, '/chats/chat-1/members');
  assert.equal(url.searchParams.get('range'), '30d');
  assert.equal(url.searchParams.get('roleFilter'), 'admins');
  assert.equal(url.searchParams.get('search'), 'Иван');
});

test('participant requests reject unknown role filters before transport', async () => {
  const api: ApiTransport = {
    async request() {
      throw new Error('transport must not run');
    },
    requestKeepalive() {},
  };

  await assert.rejects(
    () =>
      getChatParticipantsPage(api, 'chat-1', {
        roleFilter: 'unknown' as never,
      }),
    /Invalid participant role filter/u,
  );
});
