import assert from 'node:assert/strict';
import test from 'node:test';
import { getChatParticipantDetails } from '../src/lib/api/participant-details-client';
import { participantDetailsKey } from '../src/lib/participant-card';
import type { ApiTransport } from '../src/lib/api/transport';

const details = {
  userId: 'user-1',
  userDisplayName: 'Same name',
  role: 'member',
  membershipStatus: 'member',
  canManage: true,
};
test('loads the exact event identity with a bounded detail request and abort signal', async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  const api: ApiTransport = {
    requestKeepalive: () => {},
    request: async (path, init) => {
      requests.push(path);
      assert.equal(init?.signal, controller.signal);
      return details;
    },
  };
  const result = await getChatParticipantDetails(api, 'chat-1', 'user-1', '7d', controller.signal);
  assert.equal(result.userId, 'user-1');
  assert.deepEqual(requests, ['/chats/chat-1/members/user-1?range=7d']);
});
test('rejects another person even when display names are identical', async () => {
  const api: ApiTransport = {
    requestKeepalive: () => {},
    request: async () => ({ ...details, userId: 'user-2' }),
  };
  await assert.rejects(
    getChatParticipantDetails(api, 'chat-1', 'user-1', '7d'),
    /подтвердить участника/u,
  );
});
test('keeps cached participant details isolated by chat, identity and period', () => {
  assert.notDeepEqual(
    participantDetailsKey('chat-1', 'same', '7d'),
    participantDetailsKey('chat-2', 'same', '7d'),
  );
  assert.notDeepEqual(
    participantDetailsKey('chat-1', 'same', '7d'),
    participantDetailsKey('chat-1', 'other', '7d'),
  );
  assert.notDeepEqual(
    participantDetailsKey('chat-1', 'same', '7d'),
    participantDetailsKey('chat-1', 'same', '30d'),
  );
});
