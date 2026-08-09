import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_ENTITY_WORKSPACE_STATE_VERSION,
  buildManagedEntityHomeSnapshotStorageKey,
  buildManagedEntitySettingsRoute,
  buildManagedEntityStatsPreferenceStorageKey,
  buildManagedEntityStatisticsRoute,
  createManagedEntityWorkspaceState,
  decideManagedEntityWorkspaceBack,
  mergeManagedEntityStatsPreference,
  mergeManagedEntityWorkspaceRouteState,
  preserveManagedEntityRouteContext,
  readManagedEntityWorkspaceState,
  readManagedEntityHomeSnapshot,
  readManagedEntityStatsPreference,
  resolveManagedEntityHomeAnchor,
  sanitizeManagedEntityHomeSnapshot,
  sanitizeManagedEntityStatsPreference,
  sanitizeManagedEntityWorkspaceState,
  saveManagedEntityHomeSnapshot,
  saveManagedEntityStatsPreferenceForWorkspace,
} from '../src/lib/managed-entity-workspace';
import {
  buildManagedEntityHomeRoute,
  buildManagedEntityLaunchRouteState,
  canReturnToManagedEntityHome,
  prepareManagedEntityDirectEntry,
  resolveManagedEntityLaunchHomeStep,
} from '../src/lib/managed-entity-direct-entry';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

test('builds encoded settings and default statistics routes', () => {
  assert.equal(
    buildManagedEntitySettingsRoute('chat', ' chat/42 with space '),
    '/chat/chat%2F42%20with%20space/settings',
  );
  assert.equal(
    buildManagedEntitySettingsRoute('channel', 'channel#7'),
    '/channel/channel%237/settings',
  );
  assert.equal(
    buildManagedEntityStatisticsRoute('chat', 'chat/42'),
    '/chat/chat%2F42/events?section=activity',
  );
  assert.equal(
    buildManagedEntityStatisticsRoute('channel', 'channel/7'),
    '/channel/channel%2F7/stats?section=overview',
  );
  assert.throws(() => buildManagedEntitySettingsRoute('chat', '   '), TypeError);
});

test('statistics routes preserve only entity-specific section and valid range preferences', () => {
  assert.equal(
    buildManagedEntityStatisticsRoute('chat', 'chat-1', {
      section: 'participants',
      range: '30d',
    }),
    '/chat/chat-1/events?section=participants&range=30d',
  );
  assert.equal(
    buildManagedEntityStatisticsRoute('channel', 'channel-1', {
      section: 'events',
      range: '24h',
    }),
    '/channel/channel-1/stats?section=events&range=24h',
  );
  assert.equal(
    buildManagedEntityStatisticsRoute('channel', 'channel-1', {
      section: 'participants',
      range: 'invalid',
    }),
    '/channel/channel-1/stats?section=overview',
  );
  assert.equal(
    buildManagedEntityStatisticsRoute('chat', 'chat-1', { range: '7d' }),
    '/chat/chat-1/events?section=activity&range=7d',
  );
});

test('managed detail routes preserve launch context without leaking Home or prior stats state', () => {
  const route = preserveManagedEntityRouteContext(
    '/chat/chat-1/events?section=participants&range=30d',
    '?WebAppData=signed%3Dpayload&preview=1&device=iphone&view=chat&section=activity&range=24h',
    '#WebAppData=fragment-auth',
  );
  const parsed = new URL(route, 'https://miniapp.local');

  assert.equal(parsed.pathname, '/chat/chat-1/events');
  assert.equal(parsed.searchParams.get('section'), 'participants');
  assert.equal(parsed.searchParams.get('range'), '30d');
  assert.equal(parsed.searchParams.get('WebAppData'), 'signed=payload');
  assert.equal(parsed.searchParams.get('preview'), '1');
  assert.equal(parsed.searchParams.get('device'), 'iphone');
  assert.equal(parsed.searchParams.has('view'), false);
  assert.equal(parsed.hash, '#WebAppData=fragment-auth');
});

test('sanitizes a home snapshot using the current favorite filters', () => {
  assert.deepEqual(
    sanitizeManagedEntityHomeSnapshot({
      query: '  exact input  ',
      filter: 'partner',
      anchor: { id: ' chat-2 ', index: 4.9, offset: 18.5 },
      focusTarget: 'statistics',
      scrollMode: 'virtual',
      ignored: true,
    }),
    {
      query: '  exact input  ',
      filter: 'partner',
      anchor: { id: 'chat-2', index: 4, offset: 18.5 },
      focusTarget: 'statistics',
      scrollMode: 'virtual',
    },
  );
});

test('home snapshot sanitizer rejects obsolete filters and unsafe field values', () => {
  assert.deepEqual(
    sanitizeManagedEntityHomeSnapshot({
      query: 42,
      filter: 'work',
      anchor: { id: ' ', index: -3, offset: Number.POSITIVE_INFINITY },
      focusTarget: 'selector-from-state',
      scrollMode: 'window',
    }),
    {
      query: '',
      filter: 'all',
      anchor: { id: null, index: 0, offset: 0 },
      focusTarget: 'entity-title',
      scrollMode: 'document',
    },
  );
  assert.equal(sanitizeManagedEntityHomeSnapshot(null), null);
});

test('persists home snapshots in a user, location and entity scoped session key', () => {
  const storage = createMemoryStorage();
  const key = buildManagedEntityHomeSnapshotStorageKey({
    userId: 'user:42',
    locationKey: 'home/key',
    entityType: 'channel',
  });
  const snapshot = sanitizeManagedEntityHomeSnapshot({
    query: 'news',
    filter: 'watch',
    anchor: { id: 'channel-2', index: 3, offset: 48 },
    focusTarget: 'statistics',
    scrollMode: 'virtual',
  });
  assert.ok(snapshot);

  assert.equal(saveManagedEntityHomeSnapshot(storage, key, snapshot), true);
  assert.deepEqual(readManagedEntityHomeSnapshot(storage, key), snapshot);
  assert.match(key, /user%3A42:home%2Fkey:channel$/u);
});

test('home snapshot sanitizer accepts every supported favorite filter', () => {
  for (const filter of [
    'all',
    'important',
    'watch',
    'broadcast',
    'test',
    'partner',
    'service',
  ] as const) {
    assert.equal(sanitizeManagedEntityHomeSnapshot({ filter })?.filter, filter);
  }
});

test('sanitizes and merges statistics preferences without erasing valid prior fields', () => {
  assert.deepEqual(
    sanitizeManagedEntityStatsPreference('chat', {
      section: 'moderation',
      range: '7d',
      unknown: 'discarded',
    }),
    { section: 'moderation', range: '7d' },
  );
  assert.deepEqual(
    sanitizeManagedEntityStatsPreference('chat', {
      section: 'overview',
      range: 'year',
    }),
    {},
  );
  assert.deepEqual(
    mergeManagedEntityStatsPreference(
      'channel',
      { section: 'events', range: '7d' },
      { section: 'invalid', range: '30d' },
    ),
    { section: 'events', range: '30d' },
  );
});

test('reopens statistics with the last selection after Back to the same Home entry', () => {
  const storage = createMemoryStorage();
  const homeWorkspace = createManagedEntityWorkspaceState({
    entityType: 'chat',
    entityId: 'chat-1',
    origin: { locationKey: 'home-key', historyIndex: 4 },
    statsPreference: { section: 'activity', range: '7d' },
  });
  const preferenceKey = buildManagedEntityStatsPreferenceStorageKey({
    locationKey: 'home-key',
    entityType: 'chat',
    entityId: 'chat-1',
  });

  assert.equal(
    saveManagedEntityStatsPreferenceForWorkspace(
      storage,
      mergeManagedEntityWorkspaceRouteState(null, homeWorkspace),
      {
        entityType: 'chat',
        entityId: 'chat-1',
        preference: {
          section: 'participants',
          range: '30d',
          unsafe: true,
        },
      },
    ),
    true,
  );
  assert.equal(
    saveManagedEntityStatsPreferenceForWorkspace(
      storage,
      mergeManagedEntityWorkspaceRouteState(null, homeWorkspace),
      {
        entityType: 'chat',
        entityId: 'chat-2',
        preference: { section: 'moderation' },
      },
    ),
    false,
  );

  const reopenedPreference = mergeManagedEntityStatsPreference(
    'chat',
    homeWorkspace.statsPreference,
    readManagedEntityStatsPreference(storage, preferenceKey, 'chat'),
  );
  assert.deepEqual(reopenedPreference, { section: 'participants', range: '30d' });
  assert.equal(
    buildManagedEntityStatisticsRoute('chat', 'chat-1', reopenedPreference),
    '/chat/chat-1/events?section=participants&range=30d',
  );
  assert.notEqual(
    preferenceKey,
    buildManagedEntityStatsPreferenceStorageKey({
      locationKey: 'home-key',
      entityType: 'chat',
      entityId: 'chat-2',
    }),
  );
});

test('creates, sanitizes and reads a versioned workspace namespace', () => {
  const workspace = createManagedEntityWorkspaceState({
    entityType: 'channel',
    entityId: ' channel-9 ',
    origin: { locationKey: 'home-key', historyIndex: 3 },
    homeSnapshot: {
      query: 'sales',
      filter: 'important',
      anchor: { id: 'channel-9', index: 8, offset: 12 },
      focusTarget: 'settings',
      scrollMode: 'document',
    },
    statsPreference: { section: 'events', range: '30d' },
  });

  assert.equal(workspace.version, MANAGED_ENTITY_WORKSPACE_STATE_VERSION);
  assert.equal(workspace.entityId, 'channel-9');
  assert.deepEqual(
    readManagedEntityWorkspaceState({ managedEntityWorkspace: workspace }),
    workspace,
  );
});

test('workspace sanitizer rejects unknown versions and invalid identity', () => {
  const base = {
    version: MANAGED_ENTITY_WORKSPACE_STATE_VERSION,
    entityType: 'chat',
    entityId: 'chat-1',
    origin: null,
    homeSnapshot: null,
    statsPreference: {},
  };

  assert.equal(sanitizeManagedEntityWorkspaceState({ ...base, version: 2 }), null);
  assert.equal(sanitizeManagedEntityWorkspaceState({ ...base, entityType: 'group' }), null);
  assert.equal(sanitizeManagedEntityWorkspaceState({ ...base, entityId: ' ' }), null);
  assert.equal(sanitizeManagedEntityWorkspaceState('not-an-object'), null);
  assert.equal(
    readManagedEntityWorkspaceState({ managedEntityWorkspace: { ...base, version: 0 } }),
    null,
  );
});

test('workspace sanitizer strips unknown data and sanitizes nested state', () => {
  assert.deepEqual(
    sanitizeManagedEntityWorkspaceState({
      version: 1,
      entityType: 'chat',
      entityId: ' chat-1 ',
      origin: { locationKey: '', historyIndex: -1 },
      homeSnapshot: { query: 'abc', filter: 'personal' },
      statsPreference: { section: 'activity', range: '30d', unsafe: true },
      unsafe: true,
    }),
    {
      version: 1,
      entityType: 'chat',
      entityId: 'chat-1',
      origin: null,
      homeSnapshot: {
        query: 'abc',
        filter: 'all',
        anchor: { id: null, index: 0, offset: 0 },
        focusTarget: 'entity-title',
        scrollMode: 'document',
      },
      statsPreference: { section: 'activity', range: '30d' },
    },
  );
});

test('merges the workspace namespace without losing or mutating legacy route state', () => {
  const legacyState = {
    chatTitle: 'Legacy title',
    chatLink: 'https://max.ru/legacy',
    avatarUrl: null,
    futureFlag: { enabled: true },
  };
  const workspace = createManagedEntityWorkspaceState({
    entityType: 'chat',
    entityId: 'chat-1',
  });
  const merged = mergeManagedEntityWorkspaceRouteState(legacyState, workspace);

  assert.deepEqual(merged, {
    ...legacyState,
    managedEntityWorkspace: workspace,
  });
  assert.notEqual(merged, legacyState);
  assert.equal('managedEntityWorkspace' in legacyState, false);
  assert.deepEqual(mergeManagedEntityWorkspaceRouteState('legacy-string', workspace), {
    managedEntityWorkspace: workspace,
  });
});

test('trusts Back only for the adjacent entry with a distinct location key', () => {
  const origin = { locationKey: 'home-key', historyIndex: 4 };

  assert.equal(
    decideManagedEntityWorkspaceBack({
      origin,
      currentLocationKey: 'workspace-key',
      currentHistoryIndex: 5,
    }),
    'history-back',
  );
  assert.equal(
    decideManagedEntityWorkspaceBack({
      origin,
      currentLocationKey: 'home-key',
      currentHistoryIndex: 5,
    }),
    'home',
  );
  assert.equal(
    decideManagedEntityWorkspaceBack({
      origin,
      currentLocationKey: 'workspace-key',
      currentHistoryIndex: 6,
    }),
    'home',
  );
  assert.equal(
    decideManagedEntityWorkspaceBack({
      origin: { locationKey: 'home-key', historyIndex: '4' },
      currentLocationKey: 'workspace-key',
      currentHistoryIndex: 5,
    }),
    'home',
  );
});

test('direct-entry reuse requires the current detail entry to be adjacent to Home', () => {
  const workspace = createManagedEntityWorkspaceState({
    entityType: 'chat',
    entityId: 'chat-1',
    origin: { locationKey: 'home-key', historyIndex: 4 },
  });
  const currentRouteState = mergeManagedEntityWorkspaceRouteState(null, workspace);

  assert.equal(
    canReturnToManagedEntityHome({
      currentRouteState,
      currentLocationKey: 'detail-key',
      currentHistoryIndex: 5,
    }),
    true,
  );
  assert.equal(
    canReturnToManagedEntityHome({
      currentRouteState,
      currentLocationKey: 'home-key',
      currentHistoryIndex: 4,
    }),
    false,
  );
});

test('direct entry keeps launch and preview parameters on the synthetic Home URL', () => {
  const homeRoute = buildManagedEntityHomeRoute(
    'channel',
    '?WebAppData=signed%3Dpayload&preview=1&section=events&range=30d&device=iphone',
  );
  const parsed = new URL(homeRoute, 'https://miniapp.local');

  assert.equal(parsed.pathname, '/');
  assert.equal(parsed.searchParams.get('WebAppData'), 'signed=payload');
  assert.equal(parsed.searchParams.get('preview'), '1');
  assert.equal(parsed.searchParams.get('device'), 'iphone');
  assert.equal(parsed.searchParams.get('view'), 'channel');
  assert.equal(parsed.searchParams.has('section'), false);
  assert.equal(parsed.searchParams.has('range'), false);
});

test('browser-router direct entry preserves launch context in the synthetic history entry', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const replacedStates: unknown[] = [];
  const replacedUrls: string[] = [];
  const pushedStates: unknown[] = [];
  const pushedUrls: string[] = [];
  const location = new URL(
    'https://major-maksimov.ru/app/channel/channel-1/stats?init_data=signed%3Dpayload&preview=1&section=events&range=30d#WebAppData=fragment-auth',
  );
  const history = {
    state: null,
    replaceState: (state: unknown, _unused: string, url?: string | URL | null) => {
      replacedStates.push(state);
      replacedUrls.push(String(url));
    },
    pushState: (state: unknown, _unused: string, url?: string | URL | null) => {
      pushedStates.push(state);
      pushedUrls.push(String(url));
    },
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location, history },
  });

  try {
    prepareManagedEntityDirectEntry({
      hashRouterEnabled: false,
      publicRouterBasename: '/app',
    });
  } finally {
    if (originalWindow) {
      Object.defineProperty(globalThis, 'window', originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }

  assert.equal(replacedUrls.length, 1);
  const homeUrl = new URL(replacedUrls[0] as string, 'https://major-maksimov.ru');
  assert.equal(homeUrl.pathname, '/app/');
  assert.equal(homeUrl.searchParams.get('init_data'), 'signed=payload');
  assert.equal(homeUrl.searchParams.get('preview'), '1');
  assert.equal(homeUrl.searchParams.get('view'), 'channel');
  assert.equal(homeUrl.searchParams.has('section'), false);
  assert.equal(homeUrl.searchParams.has('range'), false);
  assert.equal(homeUrl.hash, '#WebAppData=fragment-auth');
  assert.equal(pushedUrls.length, 1);

  const homeHistoryState = replacedStates[0] as { usr?: unknown };
  const detailHistoryState = pushedStates[0] as { usr?: unknown };
  const homeWorkspace = readManagedEntityWorkspaceState(homeHistoryState.usr);
  const detailWorkspace = readManagedEntityWorkspaceState(detailHistoryState.usr);
  assert.ok(homeWorkspace);
  assert.ok(detailWorkspace);
  assert.deepEqual(homeWorkspace.statsPreference, { section: 'events', range: '30d' });
  assert.deepEqual(detailWorkspace.statsPreference, homeWorkspace.statsPreference);
  assert.deepEqual(homeWorkspace.origin, detailWorkspace.origin);
});

test('initial direct-entry statistics selection survives Back and reopening', () => {
  const storage = createMemoryStorage();
  const detailRouteState = buildManagedEntityLaunchRouteState({
    targetRoute: '/chat/chat-1/events',
    currentRouteState: null,
    currentLocationKey: 'direct-home-key',
    currentHistoryIndex: 0,
  });
  const initialWorkspace = readManagedEntityWorkspaceState(detailRouteState);
  assert.ok(initialWorkspace);
  assert.deepEqual(initialWorkspace.statsPreference, {});

  assert.equal(
    saveManagedEntityStatsPreferenceForWorkspace(storage, detailRouteState, {
      entityType: 'chat',
      entityId: 'chat-1',
      preference: { section: 'moderation', range: '24h' },
    }),
    true,
  );

  const preferenceKey = buildManagedEntityStatsPreferenceStorageKey({
    locationKey: 'direct-home-key',
    entityType: 'chat',
    entityId: 'chat-1',
  });
  const reopenedPreference = readManagedEntityStatsPreference(storage, preferenceKey, 'chat');
  assert.deepEqual(reopenedPreference, { section: 'moderation', range: '24h' });
  assert.equal(
    buildManagedEntityStatisticsRoute('chat', 'chat-1', reopenedPreference),
    '/chat/chat-1/events?section=moderation&range=24h',
  );
});

test('late managed launches normalize Home to the target entity type before opening detail', () => {
  assert.deepEqual(
    resolveManagedEntityLaunchHomeStep({
      targetEntityType: 'channel',
      currentSearch: '?preview=1&view=chat&device=iphone',
    }),
    {
      kind: 'normalize-home',
      route: '/?preview=1&view=channel&device=iphone',
    },
  );
  assert.deepEqual(
    resolveManagedEntityLaunchHomeStep({
      targetEntityType: 'channel',
      currentSearch: '?preview=1&view=channel',
    }),
    { kind: 'open-detail' },
  );

  const routeState = buildManagedEntityLaunchRouteState({
    targetRoute: '/channel/channel-2/stats?section=events',
    currentRouteState: null,
    currentLocationKey: 'normalized-channel-home-key',
    currentHistoryIndex: 0,
  });
  assert.deepEqual(readManagedEntityWorkspaceState(routeState)?.origin, {
    locationKey: 'normalized-channel-home-key',
    historyIndex: 0,
  });
});

test('resolves home anchors by id before the prior index', () => {
  const snapshot = sanitizeManagedEntityHomeSnapshot({
    query: '',
    filter: 'all',
    anchor: { id: 'chat-3', index: 0, offset: 14 },
    focusTarget: 'statistics',
    scrollMode: 'virtual',
  });
  assert.ok(snapshot);

  assert.deepEqual(resolveManagedEntityHomeAnchor(snapshot, ['chat-1', 'chat-2', 'chat-3']), {
    kind: 'entity',
    id: 'chat-3',
    index: 2,
    offset: 14,
    focusTarget: 'statistics',
    scrollMode: 'virtual',
  });
});

test('falls back to a clamped prior index and then the search heading', () => {
  const snapshot = sanitizeManagedEntityHomeSnapshot({
    query: 'missing',
    filter: 'service',
    anchor: { id: 'removed-chat', index: 20, offset: 6 },
    focusTarget: 'settings',
    scrollMode: 'document',
  });
  assert.ok(snapshot);

  assert.deepEqual(resolveManagedEntityHomeAnchor(snapshot, ['chat-1', 'chat-2']), {
    kind: 'entity',
    id: 'chat-2',
    index: 1,
    offset: 6,
    focusTarget: 'settings',
    scrollMode: 'document',
  });
  assert.deepEqual(resolveManagedEntityHomeAnchor(snapshot, []), {
    kind: 'search-heading',
    offset: 0,
    focusTarget: 'search-heading',
    scrollMode: 'document',
  });
});
