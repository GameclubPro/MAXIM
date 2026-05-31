import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts';
import { buildRequiredSubscriptionChannelCollections } from '../src/pages/settings-required-subscription-state';

function createEntity(
  id: string,
  entityType: 'chat' | 'channel',
  overrides: Partial<ChatSummary> = {},
): ChatSummary {
  return {
    id,
    title: `${entityType === 'chat' ? 'Chat' : 'Channel'} ${id}`,
    createdAt: '2026-04-03T12:00:00.000Z',
    entityType,
    link: `https://max.ru/${id}`,
    avatarUrl: null,
    channelOverview: null,
    assignedBots: [],
    primaryBotId: null,
    sharedMode: 'owned',
    ...overrides,
  };
}

function createResolvedChannel(
  id: string,
  entityType: 'chat' | 'channel',
  overrides: Partial<ManagedEntityHeader> = {},
): ManagedEntityHeader {
  return {
    id,
    title: `Resolved ${id}`,
    entityType,
    link: `https://max.ru/${id}`,
    participantsCount: null,
    avatarUrl: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
    ...overrides,
  };
}

test('keeps channels without a public link selectable for required subscription', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [],
    managedChannels: [
      createEntity('channel-public', 'channel'),
      createEntity('channel-private', 'channel', { link: null, title: 'Закрытый канал' }),
    ],
    resolvedChannels: [],
    selectedChannelIds: [],
  });

  assert.deepEqual(
    collections.availableChoices.map((channel) => channel.id),
    ['channel-public', 'channel-private'],
  );
  assert.deepEqual(collections.unavailableManagedChannels, []);
});

test('shows chats in the available required subscription picker', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [
      createEntity('chat-public', 'chat', { title: 'Открытый чат' }),
      createEntity('chat-private', 'chat', { link: null, title: 'Закрытый чат' }),
    ],
    managedChannels: [],
    resolvedChannels: [],
    selectedChannelIds: [],
  });

  assert.deepEqual(
    collections.availableChoices.map((channel) => ({
      id: channel.id,
      entityType: channel.entityType,
    })),
    [
      { id: 'chat-public', entityType: 'chat' },
      { id: 'chat-private', entityType: 'chat' },
    ],
  );
});

test('does not keep removed external channels in the available picker list', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [],
    managedChannels: [createEntity('channel-public', 'channel')],
    resolvedChannels: [
      createResolvedChannel('external-channel', 'channel', { title: 'Внешний канал' }),
    ],
    selectedChannelIds: [],
  });

  assert.deepEqual(
    collections.availableChoices.map((channel) => channel.id),
    ['channel-public'],
  );
});

test('prefers fresh managed channel metadata over stale resolved fallback for the same channel', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [],
    managedChannels: [
      createEntity('channel-public', 'channel', {
        title: 'Свежий managed title',
        link: 'https://max.ru/managed-channel-public',
      }),
    ],
    resolvedChannels: [
      createResolvedChannel('channel-public', 'channel', {
        title: 'Старый resolved title',
        link: 'https://max.ru/stale-channel-public',
      }),
    ],
    selectedChannelIds: ['channel-public'],
  });

  assert.deepEqual(collections.selectedChannels, [
    {
      id: 'channel-public',
      title: 'Свежий managed title',
      link: 'https://max.ru/managed-channel-public',
      entityType: 'channel',
    },
  ]);
});

test('uses resolved metadata when the managed channel snapshot still has no public link', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [],
    managedChannels: [
      createEntity('channel-public', 'channel', {
        title: 'Managed without link',
        link: '   ',
      }),
    ],
    resolvedChannels: [
      createResolvedChannel('channel-public', 'channel', {
        title: 'Resolved with link',
        link: 'https://max.ru/resolved-channel-public',
      }),
    ],
    selectedChannelIds: ['channel-public'],
  });

  assert.deepEqual(collections.selectedChannels, [
    {
      id: 'channel-public',
      title: 'Resolved with link',
      link: 'https://max.ru/resolved-channel-public',
      entityType: 'channel',
    },
  ]);
  assert.deepEqual(collections.selectedUnavailableChannels, []);
});

test('keeps selected chats in the chosen required subscription list', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [createEntity('chat-public', 'chat', { title: 'Чат MAX' })],
    managedChannels: [],
    resolvedChannels: [],
    selectedChannelIds: ['chat-public'],
  });

  assert.deepEqual(collections.selectedChannels, [
    {
      id: 'chat-public',
      title: 'Чат MAX',
      link: 'https://max.ru/chat-public',
      entityType: 'chat',
    },
  ]);
});

test('keeps selected channels without a public link in the chosen required subscription list', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChats: [],
    managedChannels: [
      createEntity('channel-public', 'channel'),
      createEntity('channel-no-link', 'channel', { link: '   ', title: 'Без ссылки' }),
    ],
    resolvedChannels: [],
    selectedChannelIds: ['channel-public', 'channel-no-link', 'channel-missing'],
  });

  assert.deepEqual(collections.selectedChannels, [
    {
      id: 'channel-public',
      title: 'Channel channel-public',
      link: 'https://max.ru/channel-public',
      entityType: 'channel',
    },
    {
      id: 'channel-no-link',
      title: 'Без ссылки',
      link: '',
      entityType: 'channel',
    },
  ]);
  assert.deepEqual(collections.selectedUnavailableChannels, [
    {
      id: 'channel-missing',
      title: 'channel-missing',
      reason: 'unavailable',
      description: 'Обновите список и проверьте права.',
    },
  ]);
});
