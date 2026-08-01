import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityAssignedBot } from '@maxim/contracts';
import { getCachedBotDialogUrl, getMe } from '../src/lib/api/me-client';
import { getChats } from '../src/lib/api/root-client';
import type { ApiTransport } from '../src/lib/api/transport';

function createApiStub(response: unknown, calls: string[]): ApiTransport {
  return {
    request: async (path: string) => {
      calls.push(path);
      return response;
    },
    requestKeepalive: () => undefined,
  };
}

function createAssignedBot(
  overrides: Partial<ManagedEntityAssignedBot> = {},
): ManagedEntityAssignedBot {
  return {
    botId: 'bot-1',
    label: 'Primary Bot',
    role: 'primary',
    membershipStatus: 'active',
    lifecycleState: 'active',
    speechPersona: 'male',
    characterName: 'Primary Bot',
    avatarUrl: null,
    capabilities: [],
    permissionsSummary: {
      checkedAt: '2026-04-04T10:03:00.000Z',
      isAdmin: true,
      isOwner: true,
      permissions: ['all'],
    },
    ...overrides,
  };
}

test('getMe parses the current admin profile from /me', async () => {
  const calls: string[] = [];
  const api = createApiStub(
    {
      userId: 'admin-1',
      username: 'designer',
      displayName: 'Designer',
      avatarUrl: 'https://cdn.max/avatar.png',
      profileUrl: 'https://max.ru/designer',
      profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
      botDialogUrl: 'https://max.ru/777000_bot',
      canAccessSystem: true,
    },
    calls,
  );

  const me = await getMe(api);

  assert.deepEqual(me, {
    userId: 'admin-1',
    username: 'designer',
    displayName: 'Designer',
    avatarUrl: 'https://cdn.max/avatar.png',
    profileUrl: 'https://max.ru/designer',
    profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
    botDialogUrl: 'https://max.ru/777000_bot',
    canAccessSystem: true,
  });
  assert.deepEqual(calls, ['/me']);
  assert.equal(getCachedBotDialogUrl(api), 'https://max.ru/777000_bot');
});

test('getMe keeps the last validated bot dialog URL scoped to its transport', async () => {
  const api = createApiStub(
    {
      userId: 'admin-1',
      botDialogUrl: 'https://max.ru/777000_bot',
    },
    [],
  );
  const otherApi = createApiStub({ userId: 'admin-2', botDialogUrl: null }, []);

  assert.equal(getCachedBotDialogUrl(api), null);
  assert.equal(getCachedBotDialogUrl(otherApi), null);
  await getMe(api);
  await getMe(otherApi);

  assert.equal(getCachedBotDialogUrl(api), 'https://max.ru/777000_bot');
  assert.equal(getCachedBotDialogUrl(otherApi), null);
});

test('getMe rejects bot dialog handoffs outside the strict MAX bot URL shape', async () => {
  const invalidUrls = [
    'https://example.com/777000_bot',
    'https://max.ru/777000_bot/extra',
    'https://max.ru/777000_bot?start=payload',
    'https://max.ru/777000_bot#fragment',
    'https://max.ru/',
  ];

  for (const botDialogUrl of invalidUrls) {
    const me = await getMe(
      createApiStub(
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          botDialogUrl,
        },
        [],
      ),
    );
    assert.equal(me.botDialogUrl, null, botDialogUrl);
  }
});

test('getChats keeps refresh progress counters from the API response', async () => {
  const calls: string[] = [];
  const api = createApiStub(
    {
      items: [],
      snapshot: {
        version: 'snapshot-v1',
        builtAt: '2026-04-04T10:00:00.000Z',
        lastSyncedAt: '2026-04-04T09:59:30.000Z',
        source: 'published_snapshot',
        stale: true,
      },
      refresh: {
        complete: false,
        cursor: 8,
        backoffActive: false,
        userVisibleComplete: false,
        nextPollAfterMs: 1500,
        processedCandidates: 8,
        totalCandidates: 20,
        progressPercent: 40,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    },
    calls,
  );

  const response = await getChats(api, {
    refresh: true,
    includeRefreshState: true,
  });

  assert.equal(response.refresh.processedCandidates, 8);
  assert.equal(response.refresh.totalCandidates, 20);
  assert.equal(response.refresh.progressPercent, 40);
  assert.equal(response.refresh.manualRefreshBlockedReason, 'in_progress');
  assert.equal(response.refresh.userVisibleComplete, false);
  assert.deepEqual(response.snapshot, {
    version: 'snapshot-v1',
    builtAt: '2026-04-04T10:00:00.000Z',
    lastSyncedAt: '2026-04-04T09:59:30.000Z',
    source: 'published_snapshot',
    stale: true,
  });
  assert.deepEqual(calls, ['/chats?refresh=1&includeRefreshState=1']);
});

test('getChats parses a diff-aware refresh response and sends sinceVersion', async () => {
  const calls: string[] = [];
  const api = createApiStub(
    {
      items: [],
      snapshot: {
        version: 'snapshot-v2',
        builtAt: '2026-04-04T10:05:00.000Z',
        lastSyncedAt: '2026-04-04T10:04:30.000Z',
        source: 'published_snapshot',
        stale: false,
      },
      diff: {
        mode: 'patch',
        baseVersion: 'snapshot-v1',
        nextVersion: 'snapshot-v2',
        added: [
          {
            id: 'chat-2',
            title: 'Новый чат',
            createdAt: '2026-04-04T10:04:00.000Z',
            entityType: 'chat',
            link: null,
            avatarUrl: null,
            channelOverview: null,
            assignedBots: [
              createAssignedBot(),
              createAssignedBot({
                botId: 'bot-2',
                label: 'Standby Bot',
                role: 'standby',
                speechPersona: 'female',
                characterName: 'Standby Bot',
                capabilities: ['access_prewarm', 'membership_prewarm'],
                permissionsSummary: {
                  checkedAt: '2026-04-04T10:03:30.000Z',
                  isAdmin: true,
                  isOwner: false,
                  permissions: ['read', 'write'],
                },
              }),
            ],
            primaryBotId: 'bot-1',
            sharedMode: 'shared-standby',
            botCount: 2,
            hasSharedAutomation: true,
          },
        ],
        updated: [],
        removedIds: [],
        orderedIds: ['chat-2'],
      },
      refresh: {
        complete: false,
        cursor: 8,
        backoffActive: false,
        userVisibleComplete: true,
        nextPollAfterMs: 1500,
        processedCandidates: 8,
        totalCandidates: 20,
        progressPercent: 40,
        lastSyncedAt: null,
        manualRefreshBlockedReason: null,
        manualRefreshRetryAfterMs: null,
      },
    },
    calls,
  );

  const response = await getChats(api, {
    refresh: true,
    includeRefreshState: true,
    sinceVersion: 'snapshot-v1',
  });

  assert.deepEqual(response.diff, {
    mode: 'patch',
    baseVersion: 'snapshot-v1',
    nextVersion: 'snapshot-v2',
    added: [
      {
        id: 'chat-2',
        title: 'Новый чат',
        createdAt: '2026-04-04T10:04:00.000Z',
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        channelOverview: null,
        assignedBots: [
          createAssignedBot(),
          createAssignedBot({
            botId: 'bot-2',
            label: 'Standby Bot',
            role: 'standby',
            speechPersona: 'female',
            characterName: 'Standby Bot',
            capabilities: ['access_prewarm', 'membership_prewarm'],
            permissionsSummary: {
              checkedAt: '2026-04-04T10:03:30.000Z',
              isAdmin: true,
              isOwner: false,
              permissions: ['read', 'write'],
            },
          }),
        ],
        primaryBotId: 'bot-1',
        sharedMode: 'shared-standby',
        botCount: 2,
        hasSharedAutomation: true,
      },
    ],
    updated: [],
    removedIds: [],
    orderedIds: ['chat-2'],
  });
  assert.equal(response.refresh.userVisibleComplete, true);
  assert.deepEqual(calls, ['/chats?refresh=1&includeRefreshState=1&sinceVersion=snapshot-v1']);
});

test('getChats recovery refresh uses MAX cache bypass and cursor reset query params', async () => {
  const calls: string[] = [];
  const api = createApiStub(
    {
      items: [],
      refresh: {
        complete: false,
        cursor: 0,
        backoffActive: false,
        userVisibleComplete: false,
        nextPollAfterMs: 1500,
        processedCandidates: null,
        totalCandidates: null,
        progressPercent: null,
        lastSyncedAt: null,
        manualRefreshBlockedReason: 'in_progress',
        manualRefreshRetryAfterMs: 1500,
      },
    },
    calls,
  );

  await getChats(api, {
    refresh: true,
    includeRefreshState: true,
    bypassRemoteCache: true,
    resetRefreshCursor: true,
  });

  assert.deepEqual(calls, ['/chats?refresh=1&includeRefreshState=1&bypassCache=1&resetCursor=1']);
});
