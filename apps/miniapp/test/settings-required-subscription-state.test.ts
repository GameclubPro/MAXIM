import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatSummary, ManagedEntityHeader } from '@maxim/contracts';
import { buildRequiredSubscriptionChannelCollections } from '../src/pages/settings-required-subscription-state';

function createChannel(id: string, overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id,
    title: `Channel ${id}`,
    createdAt: '2026-04-03T12:00:00.000Z',
    entityType: 'channel',
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
  overrides: Partial<ManagedEntityHeader> = {},
): ManagedEntityHeader {
  return {
    id,
    title: `Resolved ${id}`,
    entityType: 'channel',
    link: `https://max.ru/${id}`,
    participantsCount: null,
    avatarUrl: null,
    primaryBotId: null,
    assignedBots: [],
    sharedMode: 'owned',
    ...overrides,
  };
}

test('separates channels without a public link from selectable required subscription channels', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChannels: [
      createChannel('channel-public'),
      createChannel('channel-private', { link: null, title: 'Закрытый канал' }),
    ],
    resolvedChannels: [],
    selectedChannelIds: [],
  });

  assert.deepEqual(
    collections.availableChoices.map((channel) => channel.id),
    ['channel-public'],
  );
  assert.deepEqual(collections.unavailableManagedChannels, [
    {
      id: 'channel-private',
      title: 'Закрытый канал',
      reason: 'missing_link',
      description: 'Нужна публичная ссылка для проверки подписки.',
    },
  ]);
});

test('keeps resolved external channels reusable after they were removed from selection', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChannels: [createChannel('channel-public')],
    resolvedChannels: [createResolvedChannel('external-channel', { title: 'Внешний канал' })],
    selectedChannelIds: [],
  });

  assert.deepEqual(
    collections.availableChoices.map((channel) => channel.id),
    ['channel-public', 'external-channel'],
  );
});

test('marks selected channels without a public link as unavailable instead of silently dropping them', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChannels: [
      createChannel('channel-public'),
      createChannel('channel-no-link', { link: '   ', title: 'Без ссылки' }),
    ],
    resolvedChannels: [],
    selectedChannelIds: ['channel-public', 'channel-no-link', 'channel-missing'],
  });

  assert.deepEqual(collections.selectedChannels, [
    {
      id: 'channel-public',
      title: 'Channel channel-public',
      link: 'https://max.ru/channel-public',
    },
  ]);
  assert.deepEqual(collections.selectedUnavailableChannels, [
    {
      id: 'channel-no-link',
      title: 'Без ссылки',
      reason: 'missing_link',
      description: 'Нужна публичная ссылка для проверки подписки.',
    },
    {
      id: 'channel-missing',
      title: 'channel-missing',
      reason: 'unavailable',
      description: 'Обновите список и проверьте права.',
    },
  ]);
});
