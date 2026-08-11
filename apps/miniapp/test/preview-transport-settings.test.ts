import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedEntityAccessDiagnostics } from '@maxim/contracts/managed-entities';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview settings include schema-complete managed broadcast summaries', async () => {
  const api = createPreviewApiTransport();

  const chatSettings = (await api.request('/chats/preview-chat/settings-screen')) as {
    botSpeechPreviewProfile: {
      persona: string;
      characterName: string;
    };
    header: {
      primaryBotId: string | null;
      assignedBots: unknown[];
    };
    requiredSubscriptionChannels: Array<{
      primaryBotId: string | null;
      assignedBots: unknown[];
    }>;
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };
  const channelSettings = (await api.request('/channels/preview-channel/settings-screen')) as {
    postSignature: { enabled: boolean; text: string; url: string };
    managedBroadcasts: Array<{
      id: string;
      targetMode: string;
      blockedChats: number;
      failureBreakdown: {
        transient: number;
        permanentTarget: number;
        quarantined: number;
        unknown: number;
      };
    }>;
  };

  assert.deepEqual(chatSettings.botSpeechPreviewProfile, {
    persona: 'male',
    characterName: 'Майор Максимов',
  });
  assert.equal(chatSettings.header.primaryBotId, null);
  assert.deepEqual(chatSettings.header.assignedBots, []);
  assert.equal(chatSettings.requiredSubscriptionChannels[0]?.primaryBotId, null);
  assert.deepEqual(chatSettings.requiredSubscriptionChannels[0]?.assignedBots, []);
  assert.equal(chatSettings.managedBroadcasts[0]?.targetMode, 'current');
  assert.equal(chatSettings.managedBroadcasts[0]?.blockedChats, 0);
  assert.deepEqual(chatSettings.managedBroadcasts[0]?.failureBreakdown, {
    transient: 0,
    permanentTarget: 0,
    quarantined: 0,
    unknown: 0,
  });
  assert.equal(channelSettings.managedBroadcasts[0]?.targetMode, 'current');
  assert.deepEqual(channelSettings.postSignature, {
    enabled: false,
    text: 'Подписаться на канал',
    url: '',
  });
  assert.equal(channelSettings.managedBroadcasts[0]?.blockedChats, 0);
  assert.deepEqual(channelSettings.managedBroadcasts[0]?.failureBreakdown, {
    transient: 0,
    permanentTarget: 0,
    quarantined: 0,
    unknown: 0,
  });
});

test('preview channel signature update is isolated from channel settings', async () => {
  const api = createPreviewApiTransport();

  await api.request('/channels/preview-channel/post-signature', {
    method: 'PATCH',
    body: JSON.stringify({
      enabled: true,
      text: 'Заказать рекламу',
      url: 'https://max.ru/advertising-manager',
    }),
  });
  const signature = (await api.request('/channels/preview-channel/post-signature')) as {
    enabled: boolean;
    text: string;
    url: string;
  };
  const screen = (await api.request('/channels/preview-channel/settings-screen')) as {
    postSignature: { enabled: boolean; text: string; url: string };
  };

  assert.deepEqual(signature, {
    enabled: true,
    text: 'Заказать рекламу',
    url: 'https://max.ru/advertising-manager',
  });
  assert.deepEqual(screen.postSignature, signature);
});

test('preview access query exposes deterministic lost and degraded settings diagnostics', async () => {
  const endpoints = [
    '/chats/preview-chat/settings-screen',
    '/channels/preview-channel/settings-screen',
  ];

  for (const endpoint of endpoints) {
    const lostApi = createPreviewApiTransport({ search: '?access=lost' });
    const lostScreen = (await lostApi.request(endpoint)) as {
      header: { accessDiagnostics: ManagedEntityAccessDiagnostics };
    };

    assert.deepEqual(lostScreen.header.accessDiagnostics, {
      state: 'bot_access_lost',
      lastDetectedAt: '2026-07-14T06:15:00.000Z',
      lastCheckedAt: '2026-07-14T06:20:00.000Z',
      freshUntil: null,
      source: 'access_edge',
      activeBotCount: 0,
      lostBots: [
        {
          botId: '777001_bot',
          botLabel: 'Майор Максимова',
          reason: 'bot_removed',
          detectedAt: '2026-07-14T06:15:00.000Z',
        },
      ],
    });

    const degradedApi = createPreviewApiTransport({ search: '?access=degraded' });
    const degradedScreen = (await degradedApi.request(endpoint)) as {
      header: { accessDiagnostics: ManagedEntityAccessDiagnostics };
    };

    assert.equal(degradedScreen.header.accessDiagnostics.state, 'bot_access_lost');
    assert.equal(degradedScreen.header.accessDiagnostics.activeBotCount, 1);
    assert.equal(degradedScreen.header.accessDiagnostics.lostBots[0]?.reason, 'bot_denied');
  }
});

test('preview apply section without target stays scoped to current chat', async () => {
  const api = createPreviewApiTransport();

  const preview = (await api.request('/chats/preview-chat/settings/apply-section-preview', {
    method: 'POST',
    body: JSON.stringify({}),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };
  const applied = (await api.request('/chats/preview-chat/settings/apply-section-to-all', {
    method: 'POST',
    body: JSON.stringify({ section: 'links' }),
  })) as {
    targetMode: string;
    updatedChats: number;
    appliedChatIds: string[];
  };

  assert.equal(preview.targetMode, 'current');
  assert.equal(preview.updatedChats, 1);
  assert.deepEqual(preview.appliedChatIds, ['preview-chat']);
  assert.equal(applied.targetMode, 'current');
  assert.equal(applied.updatedChats, 1);
  assert.deepEqual(applied.appliedChatIds, ['preview-chat']);
});

test('preview allowlist canonicalizes every navigation target kind and legacy requests', async () => {
  const api = createPreviewApiTransport();
  const requests = [
    { domain: 'typed.example', kind: 'WEB_DOMAIN' },
    { domain: 'https://typed.example/path', kind: 'WEB_EXACT' },
    { domain: 'max://user/42', kind: 'MAX_PROFILE' },
    { domain: 'https://max.ru/join/typed-team', kind: 'MAX_ENTITY' },
    {
      domain: 'https://max.ru/MajorBot?startapp=chat-settings-42',
      kind: 'MINI_APP',
    },
    { domain: 'legacy.example', matchType: 'DOMAIN' },
  ] as const;

  for (const payload of requests) {
    await api.request('/chats/preview-chat/domain-allowlist', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  const details = (await api.request('/chats/preview-chat/domain-allowlist/details')) as Array<{
    target: string;
    kind: string;
    normalizedValue: string;
  }>;

  assert.deepEqual(
    details
      .filter((entry) =>
        [
          'domain:typed.example',
          'https://typed.example/path',
          'max-profile:user-id%3A42',
          'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Ftyped-team',
          'mini-app:bot%3Amajorbot',
          'domain:legacy.example',
        ].includes(entry.normalizedValue),
      )
      .map(({ target, kind, normalizedValue }) => ({ target, kind, normalizedValue })),
    [
      {
        target: 'legacy.example',
        kind: 'WEB_DOMAIN',
        normalizedValue: 'domain:legacy.example',
      },
      {
        target: 'bot:majorbot',
        kind: 'MINI_APP',
        normalizedValue: 'mini-app:bot%3Amajorbot',
      },
      {
        target: 'url:https://max.ru/join/typed-team',
        kind: 'MAX_ENTITY',
        normalizedValue: 'max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Ftyped-team',
      },
      {
        target: 'user-id:42',
        kind: 'MAX_PROFILE',
        normalizedValue: 'max-profile:user-id%3A42',
      },
      {
        target: 'https://typed.example/path',
        kind: 'WEB_EXACT',
        normalizedValue: 'https://typed.example/path',
      },
      {
        target: 'typed.example',
        kind: 'WEB_DOMAIN',
        normalizedValue: 'domain:typed.example',
      },
    ],
  );
});
