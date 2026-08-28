import assert from 'node:assert/strict';
import test from 'node:test';
import type { VkParsingFeed } from '@maxim/contracts';
import { ApiRequestError } from '../src/lib/api-request-error';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  buildVkParsingAutopostModeUpdate,
  buildVkParsingSourceConnectionToast,
  buildVkParsingSourceMetrics,
  mergeVkParsingMutationFeed,
  resolveVkParsingAutopostMode,
} from '../src/components/vk-parsing/model';
import {
  VK_PARSING_INITIAL_STATUS_FILTER,
  VK_PARSING_STATUS_FILTERS,
} from '../src/components/vk-parsing/types';

const HEALTHY_MANUAL_SOURCE = {
  importEnabled: true,
  autoPublishEnabled: false,
  autoPublishPausedReason: 'manual',
  publishMode: 'QUEUE',
  syncStatus: 'IDLE',
  terminalFailureCount: 0,
  circuitOpenedAt: null,
} as const;

test('VK top-level modes send one atomic command without raw flags', () => {
  assert.deepEqual(buildVkParsingAutopostModeUpdate('auto'), { autoPublishMode: 'AUTO' });
  assert.deepEqual(buildVkParsingAutopostModeUpdate('manual'), { autoPublishMode: 'MANUAL' });
  assert.deepEqual(buildVkParsingAutopostModeUpdate('pause'), { autoPublishMode: 'PAUSED' });
});

test('VK top-level mode exposes Auto as a repair action for legacy manual sources', () => {
  assert.equal(
    resolveVkParsingAutopostMode(
      { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
      [HEALTHY_MANUAL_SOURCE],
    ),
    'manual',
  );
  assert.equal(
    resolveVkParsingAutopostMode(
      { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
      [],
    ),
    'auto',
  );
  assert.equal(
    resolveVkParsingAutopostMode(
      { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
      [{ ...HEALTHY_MANUAL_SOURCE, autoPublishEnabled: true }],
    ),
    'auto',
  );
  assert.equal(
    resolveVkParsingAutopostMode({ autoPublishEnabled: true, autoPublishKillSwitchEnabled: true }, [
      HEALTHY_MANUAL_SOURCE,
    ]),
    'pause',
  );
  assert.equal(
    resolveVkParsingAutopostMode(
      { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
      [{ ...HEALTHY_MANUAL_SOURCE, syncStatus: 'ERROR' }],
    ),
    'auto',
  );
  assert.equal(
    resolveVkParsingAutopostMode(
      { autoPublishEnabled: true, autoPublishKillSwitchEnabled: false },
      [{ ...HEALTHY_MANUAL_SOURCE, circuitOpenedAt: '2031-04-05T06:00:00.000Z' }],
    ),
    'auto',
  );
});

test('VK opens on the concise incoming work filter without removing All', () => {
  assert.equal(VK_PARSING_INITIAL_STATUS_FILTER, 'NEW');
  assert.equal(
    VK_PARSING_STATUS_FILTERS.find((filter) => filter.value === 'NEW')?.label,
    'Входящие',
  );
  assert.equal(
    VK_PARSING_STATUS_FILTERS.some((filter) => filter.value === 'ALL'),
    true,
  );
});

test('VK source summary keeps incoming posts separate from the publication queue', () => {
  assert.deepEqual(
    buildVkParsingSourceMetrics({
      newPostCount: 17,
      queuedPostCount: 2,
      failedPostCount: 1,
    }),
    [
      { label: 'Входящие', value: 17, danger: false },
      { label: 'Очередь', value: 2, danger: false },
      { label: 'Ошибки', value: 1, danger: true },
    ],
  );
});

test('VK source connection copy does not claim an idempotent refresh', () => {
  const source = { importEnabled: true, autoPublishEnabled: true };
  assert.deepEqual(buildVkParsingSourceConnectionToast(source, true), {
    title: 'Источник уже подключён',
    description: 'Авто',
  });
  assert.deepEqual(buildVkParsingSourceConnectionToast(source, false), {
    title: 'Источник подключён',
    description: 'Авто · обновление запущено',
  });
});

test('VK mutation feed refreshes control state without replacing a scoped post list', () => {
  const currentFeed = {
    settings: { state: 'current' },
    sources: [{ id: 'source-current' }],
    posts: [{ id: 'post-filtered' }],
    queue: [{ id: 'queue-current' }],
    pagination: { total: 1, offset: 50 },
  } as unknown as VkParsingFeed;
  const mutationFeed = {
    settings: { state: 'updated' },
    sources: [{ id: 'source-updated' }],
    posts: [{ id: 'post-from-unfiltered-response' }],
    queue: [{ id: 'queue-updated' }],
    pagination: { total: 99, offset: 0 },
  } as unknown as VkParsingFeed;

  const merged = mergeVkParsingMutationFeed(currentFeed, mutationFeed);

  assert.equal(merged?.settings, mutationFeed.settings);
  assert.equal(merged?.sources, mutationFeed.sources);
  assert.equal(merged?.queue, mutationFeed.queue);
  assert.equal(merged?.posts, currentFeed.posts);
  assert.equal(merged?.pagination, currentFeed.pagination);
});

test('VK mutation feed does not seed an empty scoped cache with unfiltered posts', () => {
  const mutationFeed = {
    posts: [{ id: 'post-from-unfiltered-response' }],
    pagination: { total: 1, offset: 0 },
  } as unknown as VkParsingFeed;

  assert.equal(mergeVkParsingMutationFeed(undefined, mutationFeed), undefined);
});

test('VK preview applies atomic modes without persisting the command as settings', async () => {
  const api = createPreviewApiTransport({
    clock: { now: () => new Date('2031-04-05T06:07:08.009Z') },
  });
  const path = '/channels/preview-channel/vk-parsing';

  const pausedAutoFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'PAUSED' }),
  })) as VkParsingFeed;
  assert.equal('autoPublishMode' in pausedAutoFeed.settings, false);
  assert.equal(pausedAutoFeed.settings.autoPublishEnabled, true);
  assert.equal(pausedAutoFeed.settings.autoPublishKillSwitchEnabled, true);
  assert.deepEqual(
    pausedAutoFeed.sources.map((source) => source.autoPublishEnabled),
    [true, false],
  );

  const resumedFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'AUTO' }),
  })) as VkParsingFeed;
  assert.equal(resumedFeed.settings.autoPublishKillSwitchEnabled, false);
  assert.deepEqual(
    resumedFeed.sources.map((source) => source.autoPublishEnabled),
    pausedAutoFeed.sources.map((source) => source.autoPublishEnabled),
  );

  const manualFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'MANUAL' }),
  })) as VkParsingFeed;
  assert.equal(manualFeed.settings.autoPublishEnabled, false);
  assert.equal(
    manualFeed.sources.every((source) => !source.autoPublishEnabled),
    true,
  );

  const pausedManualFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'PAUSED' }),
  })) as VkParsingFeed;
  assert.equal(pausedManualFeed.settings.autoPublishEnabled, false);

  const activatedFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'AUTO' }),
  })) as VkParsingFeed;
  assert.equal(activatedFeed.settings.autoPublishEnabled, true);
  assert.equal(activatedFeed.settings.autoPublishKillSwitchEnabled, false);
  assert.deepEqual(
    activatedFeed.sources.map((source) => source.autoPublishEnabled),
    [true, false],
  );
});

test('VK preview normalizes legacy raw mode flags through the atomic mode behavior', async () => {
  const api = createPreviewApiTransport();
  const path = '/channels/preview-channel/vk-parsing';

  const manualFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      autoPublishEnabled: false,
      autoPublishKillSwitchEnabled: true,
    }),
  })) as VkParsingFeed;
  assert.equal(manualFeed.settings.autoPublishKillSwitchEnabled, false);
  assert.equal(
    manualFeed.sources.every((source) => !source.autoPublishEnabled),
    true,
  );

  const autoFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: false,
    }),
  })) as VkParsingFeed;
  assert.deepEqual(
    autoFeed.sources.map((source) => source.autoPublishEnabled),
    [true, false],
  );

  const pausedFeed = (await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: true,
    }),
  })) as VkParsingFeed;
  assert.equal(pausedFeed.settings.autoPublishKillSwitchEnabled, true);
  assert.deepEqual(
    pausedFeed.sources.map((source) => source.autoPublishEnabled),
    autoFeed.sources.map((source) => source.autoPublishEnabled),
  );
});

test('VK preview bulk presets preserve and establish source automation baselines', async () => {
  const nowIso = '2031-04-05T06:07:08.009Z';
  const api = createPreviewApiTransport({ clock: { now: () => new Date(nowIso) } });
  const path = '/channels/preview-channel/vk-parsing';
  const initialFeed = (await api.request(path)) as VkParsingFeed;
  const [alreadyAuto, manual] = initialFeed.sources;
  assert.ok(alreadyAuto?.autoPublishEnabledAt);
  assert.ok(manual);

  const activeFeed = (await api.request(`${path}/sources/bulk`, {
    method: 'POST',
    body: JSON.stringify({ sourceIds: [alreadyAuto.id], preset: 'NEWS' }),
  })) as VkParsingFeed;
  assert.equal(
    activeFeed.sources.find((source) => source.id === alreadyAuto.id)?.autoPublishEnabledAt,
    alreadyAuto.autoPublishEnabledAt,
  );

  const enabledFeed = (await api.request(`${path}/sources/bulk`, {
    method: 'POST',
    body: JSON.stringify({ sourceIds: [manual.id], preset: 'SLOW' }),
  })) as VkParsingFeed;
  assert.equal(
    enabledFeed.sources.find((source) => source.id === manual.id)?.autoPublishEnabledAt,
    nowIso,
  );

  const reviewFeed = (await api.request(`${path}/sources/bulk`, {
    method: 'POST',
    body: JSON.stringify({
      sourceIds: initialFeed.sources.map((source) => source.id),
      preset: 'REVIEW',
    }),
  })) as VkParsingFeed;
  assert.equal(
    reviewFeed.sources.every((source) => !source.autoPublishEnabled),
    true,
  );
  assert.equal(
    reviewFeed.sources.every((source) => source.autoPublishEnabledAt === null),
    true,
  );
});

test('VK preview add and re-add inherit paused Auto and stay idempotent', async () => {
  const nowIso = '2031-04-05T06:07:08.009Z';
  const api = createPreviewApiTransport({ clock: { now: () => new Date(nowIso) } });
  const path = '/channels/preview-channel/vk-parsing';
  await api.request(`${path}/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ autoPublishMode: 'PAUSED' }),
  });
  const before = (await api.request(path)) as VkParsingFeed;

  const added = (await api.request(`${path}/sources`, {
    method: 'POST',
    body: JSON.stringify({ url: 'vk.com/paused_auto_source' }),
  })) as VkParsingFeed & { queued: number };
  const connected = added.sources.find((source) => source.screenName === 'paused_auto_source');
  assert.ok(connected);
  assert.equal(connected.autoPublishEnabled, true);
  assert.equal(connected.autoPublishEnabledAt, nowIso);
  assert.equal(added.sources.length, before.sources.length + 1);
  assert.equal(added.queued, 1);

  const duplicate = (await api.request(`${path}/sources`, {
    method: 'POST',
    body: JSON.stringify({ url: 'https://vk.com/paused_auto_source/' }),
  })) as VkParsingFeed & { queued: number };
  assert.equal(duplicate.sources.length, added.sources.length);
  assert.equal(
    duplicate.sources.find((source) => source.screenName === 'paused_auto_source')?.id,
    connected.id,
  );
  assert.equal(duplicate.queued, 0);

  await api.request(`${path}/sources/${encodeURIComponent(connected.id)}`, { method: 'DELETE' });
  const restored = (await api.request(`${path}/sources`, {
    method: 'POST',
    body: JSON.stringify({ url: 'vk.com/paused_auto_source' }),
  })) as VkParsingFeed & { queued: number };
  const restoredSource = restored.sources.find(
    (source) => source.screenName === 'paused_auto_source',
  );
  assert.equal(restoredSource?.id, connected.id);
  assert.equal(restoredSource?.autoPublishEnabled, true);
  assert.equal(restored.sources.length, added.sources.length);
  assert.equal(restored.queued, 1);
});

test('VK preview disconnect clears source publication queue before re-add', async () => {
  const api = createPreviewApiTransport();
  const path = '/channels/preview-channel/vk-parsing';
  const initialFeed = (await api.request(path)) as VkParsingFeed;
  const queuedPost = initialFeed.queue[0];
  assert.ok(queuedPost);
  const source = initialFeed.sources.find((item) => item.id === queuedPost.sourceId);
  assert.ok(source);

  const disconnectedFeed = (await api.request(`${path}/sources/${encodeURIComponent(source.id)}`, {
    method: 'DELETE',
  })) as VkParsingFeed;
  assert.equal(
    disconnectedFeed.queue.some((post) => post.sourceId === source.id),
    false,
  );

  const restoredFeed = (await api.request(`${path}/sources`, {
    method: 'POST',
    body: JSON.stringify({ url: source.url }),
  })) as VkParsingFeed;
  const restoredPosts = restoredFeed.posts.filter((post) => post.sourceId === source.id);
  assert.ok(restoredPosts.length > 0);
  assert.equal(
    restoredFeed.queue.some((post) => post.sourceId === source.id),
    false,
  );
  assert.equal(
    restoredPosts.every((post) => post.publishQueuedAt === null),
    true,
  );
});

test('VK preview dry-run rejects an unknown source like the API', async () => {
  const api = createPreviewApiTransport();

  await assert.rejects(
    () =>
      api.request(
        '/channels/preview-channel/vk-parsing/autopublish/dry-run?sourceId=missing-source',
      ),
    (error: unknown) => {
      assert.ok(error instanceof ApiRequestError);
      assert.equal(error.status, 404);
      assert.equal(error.message, 'VK-источник не найден.');
      return true;
    },
  );
});
