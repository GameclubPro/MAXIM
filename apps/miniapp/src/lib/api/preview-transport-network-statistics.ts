import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type {
  NetworkMetricCoverage,
  NetworkStatisticsResponse,
} from '@maxim/contracts/networks-stats';
import { networkStatisticsQuerySchema } from '@maxim/contracts/networks-stats';
import { ApiRequestError } from '../api-request-error';
import type { PreviewRequestContext } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';
import {
  getPreviewNetworkEntities,
  getPreviewNetworkVersion,
} from './preview-transport-network-state';

type Generation = {
  type: ManagedEntityType;
  category: ManagedEntityFavoriteType;
  range: '7d' | '30d';
  version: string;
  checked: number;
  at: Date;
};
const generations = new WeakMap<PreviewState, Map<string, Generation>>();
function fail(code: string): never {
  throw new ApiRequestError(409, JSON.stringify({ code }), 'Обновите статистику сетки.');
}
export function handleNetworkStatisticsPreviewRequest(
  context: PreviewRequestContext,
  type: ManagedEntityType,
  category: ManagedEntityFavoriteType,
): NetworkStatisticsResponse {
  const { state, url } = context;
  const query = networkStatisticsQuerySchema.parse(Object.fromEntries(url.searchParams));
  const rows = getPreviewNetworkEntities(state, type).filter(
    (row) => row.favoriteTypes?.[0] === category,
  );
  const version = getPreviewNetworkVersion(state, type, category);
  let sessions = generations.get(state);
  if (!sessions) {
    sessions = new Map();
    generations.set(state, sessions);
  }
  const cursor = query.cursor ?? crypto.randomUUID();
  let session = sessions.get(cursor);
  if (query.cursor) {
    if (
      !session ||
      session.type !== type ||
      session.category !== category ||
      session.range !== query.range
    )
      fail('NETWORK_STATISTICS_CURSOR_EXPIRED');
    if (session.version !== version) fail('NETWORK_STATISTICS_COMPOSITION_CHANGED');
  } else {
    session = { type, category, range: query.range, version, checked: 0, at: new Date() };
    sessions.set(cursor, session);
    // Preview sessions are bounded independently of browsing duration.
    if (sessions.size > 64) sessions.delete(sessions.keys().next().value!);
  }
  const current = session!;
  current.checked = Math.min(rows.length, current.checked + 20);
  const denied = state.networksScenario === 'denied' ? Math.min(3, current.checked) : 0;
  const allowedRows = rows.slice(denied, current.checked);
  const partial = state.networksScenario === 'partial';
  const noData = state.networksScenario === 'unavailable';
  const zero = state.networksScenario === 'zero';
  const negative = state.networksScenario === 'negative';
  const at = current.at;
  const from = new Date(at);
  from.setUTCHours(21, 0, 0, 0);
  if (from > at) from.setUTCDate(from.getUTCDate() - 1);
  from.setUTCDate(from.getUTCDate() - (query.range === '7d' ? 6 : 29));
  const dayCount = query.range === '7d' ? 7 : 30;
  const dailyWeights = Array.from({ length: dayCount }, (_, day) =>
    day % 6 === 1 ? null : zero ? 0 : (negative ? -1 : day % 4 === 0 ? -1 : 1) * (day + 3),
  );
  const growthWeight = dailyWeights.reduce<number>((total, value) => total + (value ?? 0), 0);
  const coverage = (included: number, asOf = at): NetworkMetricCoverage => ({
    status:
      included === 0
        ? 'unavailable'
        : partial || current.checked < rows.length || included < rows.length
          ? 'partial'
          : 'ready',
    includedEntities: included,
    totalEntities: rows.length,
    observedFrom: included ? from.toISOString() : null,
    asOf: included ? asOf.toISOString() : null,
  });
  const items = allowedRows.map((row, index) => {
    const missing = noData || (partial && index % 4 === 0);
    const growth = missing ? null : growthWeight * ((index % 9) + 1);
    return {
      entityId: row.id,
      title: row.title,
      audience: missing ? null : 1_200 + index * 371,
      audienceObservedAt: missing ? null : at.toISOString(),
      netGrowth: growth,
      viewsGained: type === 'channel' && !missing ? (zero ? 0 : 4_200 + index * 105) : null,
      viewsCoverage:
        type === 'channel'
          ? {
              ...coverage(missing ? 0 : 1),
              totalEntities: 1,
              status: missing ? ('unavailable' as const) : ('partial' as const),
            }
          : null,
    };
  });
  const included = items.filter((row) => row.audience != null).length;
  const sum = (key: 'audience' | 'netGrowth' | 'viewsGained') =>
    included ? items.reduce((total, row) => total + (row[key] ?? 0), 0) : null;
  const entityWeight = items.reduce(
    (total, row, index) => total + (row.netGrowth == null ? 0 : (index % 9) + 1),
    0,
  );
  const unallocatedViews = type === 'channel' && partial && included ? 1_240 : 0;
  const observedDays = dailyWeights.filter((weight) => weight != null).length;
  const allocatedViews = (sum('viewsGained') ?? 0) - unallocatedViews;
  let allocatedDays = 0;
  let viewsAssigned = 0;
  const series: NetworkStatisticsResponse['series'] = [];
  for (let day = 0; day < dayCount; day += 1) {
    const point = new Date(from.getTime() + day * 86_400_000);
    const gap = !included || dailyWeights[day] == null;
    let views: number | null = null;
    if (type === 'channel' && !gap) {
      allocatedDays++;
      views =
        allocatedDays === observedDays
          ? allocatedViews - viewsAssigned
          : Math.floor(allocatedViews / observedDays);
      viewsAssigned += views;
    }
    series.push({
      at: point.toISOString(),
      netGrowth: gap ? null : dailyWeights[day]! * entityWeight,
      viewsGained: views,
      viewsComplete: false,
    });
  }
  return {
    entityType: type,
    favoriteType: category,
    label: state.favoriteLabels[category] ?? category,
    compositionVersion: version,
    period: {
      range: query.range,
      from: from.toISOString(),
      to: at.toISOString(),
      timezone: 'Europe/Moscow',
      bucket: 'day',
    },
    authorization: {
      checked: current.checked,
      total: rows.length,
      allowed: allowedRows.length,
      denied,
      unavailable: 0,
    },
    audience: { value: sum('audience'), coverage: coverage(included) },
    netGrowth: {
      value: sum('netGrowth'),
      coverage: {
        ...coverage(included, new Date(at.getTime() - 3_600_000)),
        status: included ? 'partial' : 'unavailable',
      },
    },
    viewsGained:
      type === 'channel'
        ? {
            value: sum('viewsGained'),
            coverage: { ...coverage(included), status: included ? 'partial' : 'unavailable' },
          }
        : null,
    series,
    items,
    unallocatedViews,
    nextCursor: current.checked < rows.length ? cursor : null,
    retryAfterMs: 500,
    method: 'current-composition-observed-intervals-v2',
  };
}
