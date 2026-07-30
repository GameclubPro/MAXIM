import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  channelSettingsSchema,
  chatRulesSchema,
  chatSettingsSchema,
  type ChannelSettingsScreenResponse,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts';
import {
  getChannelPostSignature,
  getChannelSettingsScreen,
  updateChannelPostSignature,
} from '../src/lib/api/channel-settings-client';
import { getSettingsScreen } from '../src/lib/api/chat-settings-client';
import type { ApiTransport } from '../src/lib/api/transport';

type ApiCall = {
  path: string;
  init?: RequestInit;
};

function createApiMock(response: unknown, calls: ApiCall[]): ApiTransport {
  return {
    async request(path: string, init?: RequestInit) {
      calls.push({ path, init });
      return response;
    },
    requestKeepalive() {
      // Not used by these client helpers.
    },
  };
}

function createChatSettingsScreenResponse(): ChatSettingsScreenResponse {
  return {
    settings: chatSettingsSchema.parse({}),
    rules: chatRulesSchema.parse({}),
    header: {
      id: 'chat-1',
      title: 'Чат',
      entityType: 'chat',
      link: null,
      participantsCount: null,
    },
    botSpeechPreviewProfile: {
      persona: 'female',
      characterName: 'Майор Максимова',
    },
    requiredSubscriptionChannels: [],
    domains: [],
    managedBroadcasts: [],
  };
}

function createChannelSettingsScreenResponse(): ChannelSettingsScreenResponse {
  return {
    settings: channelSettingsSchema.parse({}),
    postSignature: {
      enabled: false,
      text: CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
    },
    header: {
      id: 'channel-1',
      title: 'Канал',
      entityType: 'channel',
      link: null,
      participantsCount: null,
    },
    managedBroadcasts: [],
  };
}

test('chat settings screen client only adds prefetch query when requested', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(createChatSettingsScreenResponse(), calls);
  const controller = new AbortController();

  const screen = await getSettingsScreen(api, 'chat-1', { signal: controller.signal });
  await getSettingsScreen(api, 'chat-1', { signal: controller.signal, prefetch: true });

  assert.deepEqual(screen.botSpeechPreviewProfile, {
    persona: 'female',
    characterName: 'Майор Максимова',
  });
  assert.equal(screen.header.primaryBotId, null);
  assert.deepEqual(screen.header.assignedBots, []);
  assert.equal(calls[0]?.path, '/chats/chat-1/settings-screen');
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.equal(calls[1]?.path, '/chats/chat-1/settings-screen?prefetch=1');
  assert.equal(calls[1]?.init?.signal, controller.signal);
});

test('channel post signature client uses its independent GET and PATCH endpoints', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock({ enabled: true, text: 'Читать канал' }, calls);

  const current = await getChannelPostSignature(api, 'channel-1');
  const updated = await updateChannelPostSignature(api, 'channel-1', {
    enabled: true,
    text: 'Читать канал',
  });

  assert.deepEqual(current, { enabled: true, text: 'Читать канал' });
  assert.deepEqual(updated, current);
  assert.equal(calls[0]?.path, '/channels/channel-1/post-signature');
  assert.equal(calls[1]?.path, '/channels/channel-1/post-signature');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.equal(calls[1]?.init?.body, JSON.stringify(current));
});

test('channel settings screen client only adds prefetch query when requested', async () => {
  const calls: ApiCall[] = [];
  const api = createApiMock(createChannelSettingsScreenResponse(), calls);
  const controller = new AbortController();

  await getChannelSettingsScreen(api, 'channel-1', { signal: controller.signal });
  await getChannelSettingsScreen(api, 'channel-1', {
    signal: controller.signal,
    prefetch: true,
  });

  assert.equal(calls[0]?.path, '/channels/channel-1/settings-screen');
  assert.equal(calls[0]?.init?.signal, controller.signal);
  assert.equal(calls[1]?.path, '/channels/channel-1/settings-screen?prefetch=1');
  assert.equal(calls[1]?.init?.signal, controller.signal);
});
