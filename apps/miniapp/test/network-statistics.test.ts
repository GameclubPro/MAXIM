import assert from 'node:assert/strict';
import test from 'node:test';
import type { NetworkStatisticsResponse } from '@maxim/contracts/networks-stats';
import { ApiRequestError } from '../src/lib/api-request-error';
import type { ApiTransport } from '../src/lib/api/transport';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  getManagedEntityNetworks,
  updateManagedEntityNetworkComposition,
} from '../src/lib/api/managed-entity-networks-client';
import {
  getNetworkStatistics,
  NetworkStatisticsScopeChanged,
  runNetworkStatisticsSession,
} from '../src/features/networks/network-statistics';

const cursor = '00000000-0000-4000-8000-000000000001';
const coverage = {
  status: 'partial' as const,
  includedEntities: 1,
  totalEntities: 3,
  observedFrom: null,
  asOf: null,
};
function response(checked: number, nextCursor: string | null = cursor): NetworkStatisticsResponse {
  return {
    entityType: 'chat',
    favoriteType: 'important',
    label: 'Важное',
    compositionVersion: 'v1',
    period: {
      range: '7d',
      from: '2026-10-15T21:00:00.000Z',
      to: '2026-10-22T12:00:00.000Z',
      timezone: 'Europe/Moscow',
      bucket: 'day',
    },
    authorization: { checked, total: 3, allowed: checked, denied: 0, unavailable: 0 },
    audience: { value: checked * 10, coverage },
    netGrowth: { value: 0, coverage },
    viewsGained: null,
    series: [
      { at: '2026-10-15T21:00:00.000Z', netGrowth: null, viewsGained: null, viewsComplete: false },
    ],
    items: Array.from({ length: checked }, (_, index) => ({
      entityId: `-${index + 1}`,
      title: `Чат ${index}`,
      audience: 10,
      audienceObservedAt: null,
      netGrowth: 0,
      viewsGained: null,
      viewsCoverage: null,
    })),
    unallocatedViews: 0,
    nextCursor,
    retryAfterMs: 500,
    method: 'current-composition-observed-intervals-v2',
  };
}
const transport = (request: ApiTransport['request']): ApiTransport => ({
  request,
  requestKeepalive: () => undefined,
});
const scope = (api: ApiTransport) => ({
  api,
  scopeKey: 'actor',
  entityType: 'chat' as const,
  favoriteType: 'important' as const,
  range: '7d' as const,
  compositionVersion: 'v1',
});
const immediate = async () => undefined;

test('progressive statistics accepts the same cursor and replaces complete snapshots', async () => {
  const paths: string[] = [];
  const snapshots: NetworkStatisticsResponse[] = [];
  const api = transport(async (path) => {
    paths.push(path);
    return response(paths.length, paths.length === 3 ? null : cursor);
  });
  await runNetworkStatisticsSession(scope(api), {
    signal: new AbortController().signal,
    onResponse: (value) => snapshots.push(value),
    wait: immediate,
  });
  assert.deepEqual(
    snapshots.map((value) => value.items.length),
    [1, 2, 3],
  );
  assert.deepEqual(
    snapshots.map((value) => value.audience.value),
    [10, 20, 30],
  );
  assert.equal(new URL(paths[0], 'https://test/').searchParams.has('cursor'), false);
  assert.equal(new URL(paths[1], 'https://test/').searchParams.get('cursor'), cursor);
  assert.equal(new URL(paths[2], 'https://test/').searchParams.get('cursor'), cursor);
});
test('wrong actor-scoped composition response never becomes displayable', async () => {
  let invalidated = 0;
  let published = 0;
  const api = transport(async () => ({ ...response(3, null), compositionVersion: 'other' }));
  await assert.rejects(
    runNetworkStatisticsSession(scope(api), {
      signal: new AbortController().signal,
      onResponse: () => published++,
      onScopeInvalidated: () => {
        invalidated++;
      },
    }),
    NetworkStatisticsScopeChanged,
  );
  assert.equal(published, 0);
  assert.equal(invalidated, 1);
});
test('expired cursors restart without cursor after metadata refresh, with bounded recovery', async () => {
  const paths: string[] = [];
  let reset = 0;
  const api = transport(async (path) => {
    paths.push(path);
    if (paths.length === 2)
      throw new ApiRequestError(
        409,
        JSON.stringify({ code: 'NETWORK_STATISTICS_CURSOR_EXPIRED' }),
        'expired',
      );
    return response(paths.length === 1 ? 1 : 3, paths.length === 1 ? cursor : null);
  });
  await runNetworkStatisticsSession(scope(api), {
    signal: new AbortController().signal,
    onResponse: () => undefined,
    onReset: () => {
      reset++;
    },
    wait: immediate,
  });
  assert.equal(reset, 1);
  assert.equal(new URL(paths[2], 'https://test').searchParams.has('cursor'), false);
  let attempts = 0;
  const broken = transport(async () => {
    attempts++;
    throw new ApiRequestError(
      409,
      JSON.stringify({ code: 'NETWORK_STATISTICS_COMPOSITION_CHANGED' }),
      'changed',
    );
  });
  await assert.rejects(
    runNetworkStatisticsSession(scope(broken), {
      signal: new AbortController().signal,
      onResponse: () => undefined,
    }),
  );
  assert.equal(attempts, 1);
});
test('shared FIFO holds two entire sessions and removes an aborted waiting actor', async () => {
  const entered: string[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstWait = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondWait = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const api = (name: string, gate?: Promise<void>) =>
    transport(async () => {
      entered.push(name);
      await gate;
      return response(3, null);
    });
  const launch = (name: string, gate?: Promise<void>, controller = new AbortController()) =>
    runNetworkStatisticsSession(scope(api(name, gate)), {
      signal: controller.signal,
      onResponse: () => undefined,
    });
  const first = launch('first', firstWait);
  const second = launch('second', secondWait);
  const cancelled = new AbortController();
  const third = launch('cancelled', undefined, cancelled);
  const rejection = assert.rejects(third, { name: 'AbortError' });
  const fourth = launch('fourth');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(entered, ['first', 'second']);
  cancelled.abort();
  await rejection;
  releaseFirst();
  await Promise.all([first, fourth]);
  assert.deepEqual(entered, ['first', 'second', 'fourth']);
  releaseSecond();
  await second;
});
test('composition/access conflicts mask protected data before notifying root and never silently restart', async () => {
  for (const reason of ['composition', 'access'] as const) {
    let calls = 0;
    let display: NetworkStatisticsResponse | null = null;
    let notified = 0;
    const api = transport(async () => {
      calls++;
      if (calls === 1) return response(1);
      throw new ApiRequestError(
        409,
        JSON.stringify({
          code:
            reason === 'access'
              ? 'NETWORK_STATISTICS_ACCESS_CHANGED'
              : 'NETWORK_STATISTICS_COMPOSITION_CHANGED',
        }),
        'changed',
      );
    });
    await assert.rejects(
      runNetworkStatisticsSession(scope(api), {
        signal: new AbortController().signal,
        onResponse: (value) => {
          display = value;
        },
        onReset: () => {
          display = null;
        },
        wait: immediate,
        onScopeInvalidated: (actual) => {
          assert.equal(actual, reason);
          assert.equal(display, null);
          notified++;
        },
      }),
      NetworkStatisticsScopeChanged,
    );
    assert.equal(calls, 2);
    assert.equal(notified, 1);
    assert.equal(display, null);
  }
});
test('stalled/regressed progress, changed totals and duplicate authorized IDs clear the previous snapshot', async () => {
  const duplicate = response(2);
  duplicate.items[1].entityId = duplicate.items[0].entityId;
  const totalChanged = response(2);
  totalChanged.authorization.total = 4;
  totalChanged.audience.coverage = { ...coverage, totalEntities: 4 };
  totalChanged.netGrowth.coverage = { ...coverage, totalEntities: 4 };
  for (const invalid of [response(1), response(0), duplicate, totalChanged]) {
    let calls = 0;
    let display: NetworkStatisticsResponse | null = null;
    await assert.rejects(
      runNetworkStatisticsSession(
        scope(transport(async () => (++calls === 1 ? response(1) : invalid))),
        {
          signal: new AbortController().signal,
          onResponse: (value) => {
            display = value;
          },
          onReset: () => {
            display = null;
          },
          wait: immediate,
        },
      ),
    );
    assert.equal(calls, 2);
    assert.equal(display, null);
  }
});
test('one-page API rejects cross-type/range responses, malformed payload and impossible authorization counts', async () => {
  const denied = response(3, null);
  denied.authorization.allowed = 4;
  for (const invalid of [
    null,
    { ...response(3, null), entityType: 'channel' },
    { ...response(3, null), period: { ...response(3, null).period, range: '30d' } },
    {
      ...response(3, null),
      period: { ...response(3, null).period, from: '2026-10-10T21:00:00.000Z' },
    },
    denied,
  ])
    await assert.rejects(
      getNetworkStatistics(
        transport(async () => invalid),
        { entityType: 'chat', favoriteType: 'important', range: '7d' },
      ),
    );
});
test('progressive snapshot time may advance while regressing time or a new cursor generation clears old data', async () => {
  const advanced = response(3, null);
  advanced.period.to = '2026-10-22T12:01:00.000Z';
  let calls = 0;
  const times: string[] = [];
  await runNetworkStatisticsSession(
    scope(transport(async () => (++calls === 1 ? response(1) : advanced))),
    {
      signal: new AbortController().signal,
      onResponse: (data) => times.push(data.period.to),
      wait: immediate,
    },
  );
  assert.deepEqual(times, ['2026-10-22T12:00:00.000Z', '2026-10-22T12:01:00.000Z']);
  const regressed = response(2);
  regressed.period.to = '2026-10-22T11:59:00.000Z';
  const changedCursor = response(2, '00000000-0000-4000-8000-000000000002');
  for (const invalid of [regressed, changedCursor]) {
    let requests = 0;
    let display: NetworkStatisticsResponse | null = null;
    await assert.rejects(
      runNetworkStatisticsSession(
        scope(transport(async () => (++requests === 1 ? response(1) : invalid))),
        {
          signal: new AbortController().signal,
          onResponse: (data) => {
            display = data;
          },
          onReset: () => {
            display = null;
          },
          wait: immediate,
        },
      ),
    );
    assert.equal(display, null);
  }
});
test('server cursor expiry gets one automatic restart and never an authorization loop', async () => {
  let calls = 0;
  let resets = 0;
  await assert.rejects(
    runNetworkStatisticsSession(
      scope(
        transport(async () => {
          calls++;
          throw new ApiRequestError(
            409,
            JSON.stringify({ code: 'NETWORK_STATISTICS_CURSOR_EXPIRED' }),
            'expired',
          );
        }),
      ),
      {
        signal: new AbortController().signal,
        onResponse: () => assert.fail('No observations'),
        onReset: () => {
          resets++;
        },
      },
    ),
  );
  assert.equal(calls, 2);
  assert.ok(resets >= 1);
});
test('late response after cancellation never publishes protected data', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = new AbortController();
  let published = 0;
  const promise = runNetworkStatisticsSession(
    scope(
      transport(async () => {
        await gate;
        return response(3, null);
      }),
    ),
    {
      signal: controller.signal,
      onResponse: () => {
        published++;
      },
    },
  );
  const rejection = assert.rejects(promise, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  release();
  await rejection;
  assert.equal(published, 0);
});
test('preview statistics share real category composition/version and invalidate progressive sessions on edits', async () => {
  const api = createPreviewApiTransport({ search: '?networks=1&networksScenario=partial' });
  const catalogue = await getManagedEntityNetworks(api, 'channel');
  const card = catalogue.items.find((item) => item.favoriteType === 'important')!;
  const snapshots: NetworkStatisticsResponse[] = [];
  await runNetworkStatisticsSession(
    { ...scope(api), entityType: 'channel', compositionVersion: card.compositionVersion },
    {
      signal: new AbortController().signal,
      onResponse: (value) => snapshots.push(value),
      wait: immediate,
    },
  );
  assert.ok(snapshots.length > 1);
  const last = snapshots.at(-1)!;
  assert.equal(last.authorization.total, card.entityCount);
  assert.equal(last.compositionVersion, card.compositionVersion);
  assert.ok(last.unallocatedViews > 0);
  assert.ok(last.series.some((point) => point.netGrowth === null));
  assert.equal(
    last.series.reduce((total, point) => total + (point.netGrowth ?? 0), 0),
    last.netGrowth.value,
  );
  assert.equal(
    last.series.reduce((total, point) => total + (point.viewsGained ?? 0), 0) +
      last.unallocatedViews,
    last.viewsGained?.value,
  );
  const partial = snapshots[0];
  await updateManagedEntityNetworkComposition(api, 'channel', [
    { entityId: last.items[0].entityId, expectedFavoriteType: 'important', favoriteType: 'watch' },
  ]);
  await assert.rejects(
    api.request(
      `/managed-entities/networks/channel/stats?favoriteType=important&range=7d&cursor=${partial.nextCursor}`,
    ),
    (error: unknown) =>
      error instanceof ApiRequestError && error.code === 'NETWORK_STATISTICS_COMPOSITION_CHANGED',
  );
});
