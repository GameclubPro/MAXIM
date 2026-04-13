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

test('keeps channels without a public link selectable for required subscription', () => {
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
    ['channel-public', 'channel-private'],
  );
  assert.deepEqual(collections.unavailableManagedChannels, []);
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

test('prefers fresh managed channel metadata over stale resolved fallback for the same channel', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChannels: [
      createChannel('channel-public', {
        title: 'Свежий managed title',
        link: 'https://max.ru/managed-channel-public',
      }),
    ],
    resolvedChannels: [
      createResolvedChannel('channel-public', {
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
    },
  ]);
});

test('uses resolved metadata when the managed channel snapshot still has no public link', () => {
  const collections = buildRequiredSubscriptionChannelCollections({
    managedChannels: [
      createChannel('channel-public', {
        title: 'Managed without link',
        link: '   ',
      }),
    ],
    resolvedChannels: [
      createResolvedChannel('channel-public', {
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
    },
  ]);
  assert.deepEqual(collections.selectedUnavailableChannels, []);
});

test('keeps selected channels without a public link in the chosen required subscription list', () => {
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
    {
      id: 'channel-no-link',
      title: 'Без ссылки',
      link: '',
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
