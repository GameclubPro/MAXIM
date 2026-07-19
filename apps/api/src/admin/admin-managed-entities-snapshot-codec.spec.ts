import type { ChatSummary } from '@maxim/contracts';
import type { ManagedEntitiesPublishedSnapshot } from '../chat-context/chat-context-cache.service';
import {
  areManagedEntitySummariesSnapshotEquivalent,
  buildManagedEntitiesPublishedSnapshotDiff,
  buildManagedEntitiesPublishedSnapshotHash,
  cloneManagedEntitySummarySnapshotValue,
  serializeManagedEntitySummaryForSnapshot,
} from './admin-managed-entities-snapshot-codec';

function createSummary(overrides: Partial<ChatSummary> = {}): ChatSummary {
  return {
    id: 'channel-1',
    title: 'MAX Team',
    createdAt: '2026-07-19T09:00:00.000Z',
    entityType: 'channel',
    link: null,
    avatarUrl: ' https://cdn.max.ru/channel-1.webp ',
    channelOverview: {
      enabledScenariosCount: 2,
      commentsEnabled: true,
      postSuggestionsEnabled: false,
      commentsModerationEnabled: true,
    },
    primaryBotId: 'bot-1',
    assignedBots: [
      {
        botId: 'bot-1',
        label: 'Primary',
        role: 'primary',
        membershipStatus: 'active',
        lifecycleState: 'active',
        speechPersona: 'male',
        characterName: null,
        avatarUrl: null,
        capabilities: ['background_scans', 'channel_stats'],
        permissionsSummary: {
          checkedAt: '2026-07-19T09:30:00.000Z',
          isAdmin: true,
          isOwner: false,
          permissions: ['write', 'delete'],
        },
      },
    ],
    sharedMode: 'shared-standby',
    botCount: 2,
    hasSharedAutomation: true,
    favoriteTypes: ['service', 'important', 'service'],
    ...overrides,
  };
}

function createSnapshot(
  version: string,
  items: ChatSummary[],
  itemCount = items.length,
): ManagedEntitiesPublishedSnapshot {
  return {
    version,
    builtAt: '2026-07-19T10:00:00.000Z',
    lastSyncedAt: '2026-07-19T09:59:00.000Z',
    itemCount,
    itemsHash: `hash-${version}`,
    items,
  };
}

describe('managed entities published snapshot codec', () => {
  it('serializes only the canonical persisted fields and normalizes optional values', () => {
    const summary = createSummary();

    const serialized = serializeManagedEntitySummaryForSnapshot(summary);

    expect(serialized).toEqual({
      id: 'channel-1',
      title: 'MAX Team',
      createdAt: '2026-07-19T09:00:00.000Z',
      entityType: 'channel',
      link: null,
      avatarUrl: 'https://cdn.max.ru/channel-1.webp',
      channelOverview: {
        enabledScenariosCount: 2,
        commentsEnabled: true,
        postSuggestionsEnabled: false,
        commentsModerationEnabled: true,
      },
      primaryBotId: 'bot-1',
      assignedBots: [
        {
          botId: 'bot-1',
          label: 'Primary',
          role: 'primary',
          membershipStatus: 'active',
          lifecycleState: 'active',
          speechPersona: 'male',
          characterName: null,
          avatarUrl: null,
          capabilities: ['background_scans', 'channel_stats'],
          permissionsSummary: {
            checkedAt: '2026-07-19T09:30:00.000Z',
            isAdmin: true,
            isOwner: false,
            permissions: ['write', 'delete'],
          },
        },
      ],
      sharedMode: 'shared-standby',
    });
    expect(serialized).not.toHaveProperty('botCount');
    expect(serialized).not.toHaveProperty('hasSharedAutomation');
    expect(serialized).not.toHaveProperty('favoriteTypes');
    expect(serialized.assignedBots).not.toBe(summary.assignedBots);
  });

  it('keeps the published hash format stable', () => {
    expect(
      buildManagedEntitiesPublishedSnapshotHash([createSummary()], '2026-07-19T10:00:00.000Z'),
    ).toBe('cd1e075037fdff97b2e96dbc1761ef52da058dbd7157cdee070f6675c19c4df2');

    expect(
      buildManagedEntitiesPublishedSnapshotHash(
        [createSummary({ botCount: 99, hasSharedAutomation: false, favoriteTypes: ['watch'] })],
        '2026-07-19T10:00:00.000Z',
      ),
    ).toBe('cd1e075037fdff97b2e96dbc1761ef52da058dbd7157cdee070f6675c19c4df2');
  });

  it('compares summaries through the canonical snapshot representation', () => {
    expect(
      areManagedEntitySummariesSnapshotEquivalent(
        createSummary(),
        createSummary({
          botCount: 50,
          favoriteTypes: ['watch'],
          avatarUrl: 'https://cdn.max.ru/channel-1.webp',
        }),
      ),
    ).toBe(true);
    expect(
      areManagedEntitySummariesSnapshotEquivalent(
        createSummary(),
        createSummary({ title: 'Renamed channel' }),
      ),
    ).toBe(false);
  });

  it('normalizes cloned summary values without aliasing mutable top-level children', () => {
    const summary = createSummary();

    const cloned = cloneManagedEntitySummarySnapshotValue(summary);

    expect(cloned).not.toBe(summary);
    expect(cloned.channelOverview).not.toBe(summary.channelOverview);
    expect(cloned.assignedBots).not.toBe(summary.assignedBots);
    expect(cloned.assignedBots[0]).not.toBe(summary.assignedBots[0]);
    expect(cloned.favoriteTypes).toEqual(['important', 'service']);
  });

  it('builds a bounded one-change patch with cloned values and stable ordering', () => {
    const currentItems = Array.from({ length: 4 }, (_, index) =>
      createSummary({ id: `channel-${index + 1}`, title: `Channel ${index + 1}` }),
    );
    const nextItems = currentItems.map((item) => ({ ...item }));
    nextItems[1] = { ...nextItems[1], title: 'Renamed channel' };

    const diff = buildManagedEntitiesPublishedSnapshotDiff(
      createSnapshot('v1', currentItems),
      createSnapshot('v2', nextItems),
    );

    expect(diff).toEqual({
      baseVersion: 'v1',
      nextVersion: 'v2',
      added: [],
      updated: [expect.objectContaining({ id: 'channel-2', title: 'Renamed channel' })],
      removedIds: [],
      orderedIds: ['channel-1', 'channel-2', 'channel-3', 'channel-4'],
      changeCount: 1,
    });
    expect(diff?.updated[0]).not.toBe(nextItems[1]);
  });

  it('rejects empty, same-version, and over-threshold patches', () => {
    const currentItems = Array.from({ length: 4 }, (_, index) =>
      createSummary({ id: `channel-${index + 1}`, title: `Channel ${index + 1}` }),
    );
    const twoUpdates = currentItems.map((item, index) =>
      index < 2 ? { ...item, title: `Renamed ${index + 1}` } : { ...item },
    );

    expect(
      buildManagedEntitiesPublishedSnapshotDiff(null, createSnapshot('v2', currentItems)),
    ).toBeNull();
    expect(
      buildManagedEntitiesPublishedSnapshotDiff(
        createSnapshot('v1', currentItems),
        createSnapshot('v1', twoUpdates),
      ),
    ).toBeNull();
    expect(
      buildManagedEntitiesPublishedSnapshotDiff(
        createSnapshot('v1', currentItems),
        createSnapshot(
          'v2',
          currentItems.map((item) => ({ ...item })),
        ),
      ),
    ).toBeNull();
    expect(
      buildManagedEntitiesPublishedSnapshotDiff(
        createSnapshot('v1', currentItems),
        createSnapshot('v2', twoUpdates),
      ),
    ).toBeNull();
  });
});
