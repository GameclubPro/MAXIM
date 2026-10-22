import { useEffect, useRef, useState } from 'react';
import type { ManagedEntityFavoriteType, ManagedEntityType } from '@maxim/contracts';
import type {
  NetworkStatisticsQuery,
  NetworkStatisticsResponse,
} from '@maxim/contracts/networks-stats';
import { ApiRequestError } from '../../lib/api-request-error';
import type { ApiTransport } from '../../lib/api/transport';

export type NetworkStatisticsRange = NetworkStatisticsQuery['range'];
export type NetworkStatisticsPhase =
  | 'idle'
  | 'loading'
  | 'checking'
  | 'settled'
  | 'stale'
  | 'error';
export type NetworkStatisticsInvalidationReason = 'composition' | 'access';
export interface NetworkStatisticsLoadError {
  code: string;
  message: string;
  retryable: boolean;
}
export interface NetworkStatisticsRequest {
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
  range: NetworkStatisticsRange;
  cursor?: string;
  signal?: AbortSignal;
}
export interface NetworkStatisticsState {
  data: NetworkStatisticsResponse | null;
  phase: NetworkStatisticsPhase;
  error: NetworkStatisticsLoadError | null;
  refresh: () => void;
}
type StatisticsScope = {
  api: ApiTransport;
  scopeKey: string;
  entityType: ManagedEntityType;
  favoriteType: ManagedEntityFavoriteType;
  range: NetworkStatisticsRange;
  compositionVersion: string;
};
type Waiter = { signal: AbortSignal; enter: () => void; cancel: () => void };
const waiting: Waiter[] = [];
let activeSessions = 0;
function drain() {
  while (activeSessions < 2 && waiting.length) waiting.shift()!.enter();
}
// A slot covers the whole progressive authorization session, including its waits.
function acquire(signal: AbortSignal): Promise<() => void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      signal,
      enter: () => {
        signal.removeEventListener('abort', waiter.cancel);
        activeSessions += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          activeSessions -= 1;
          drain();
        });
      },
      cancel: () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
    };
    signal.addEventListener('abort', waiter.cancel, { once: true });
    waiting.push(waiter);
    drain();
  });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export interface UseNetworkStatisticsOptions extends StatisticsScope {
  enabled: boolean;
  onScopeInvalidated?: (reason: NetworkStatisticsInvalidationReason) => void;
}
export class NetworkStatisticsScopeChanged extends Error {
  constructor(readonly reason: NetworkStatisticsInvalidationReason) {
    super('Обновите доступ и состав сетки.');
  }
}
export async function getNetworkStatistics(
  api: ApiTransport,
  request: NetworkStatisticsRequest,
): Promise<NetworkStatisticsResponse> {
  const { networkStatisticsResponseSchema } = await import('@maxim/contracts/networks-stats');
  const query = new URLSearchParams({ favoriteType: request.favoriteType, range: request.range });
  if (request.cursor) query.set('cursor', request.cursor);
  const data = networkStatisticsResponseSchema.parse(
    await api.request(`/managed-entities/networks/${request.entityType}/stats?${query}`, {
      signal: request.signal,
    }),
  );
  if (
    data.entityType !== request.entityType ||
    data.favoriteType !== request.favoriteType ||
    data.period.range !== request.range
  )
    throw new Error('Статистика не соответствует выбранной сетке.');
  const to = new Date(data.period.to).getTime();
  const day = 86_400_000;
  const expectedFrom =
    Math.floor((to + 3 * 3_600_000) / day) * day -
    3 * 3_600_000 -
    (request.range === '7d' ? 6 : 29) * day;
  if (new Date(data.period.from).getTime() !== expectedFrom)
    throw new Error('Период статистики не соответствует выбранному диапазону.');
  const auth = data.authorization;
  if (
    auth.checked > auth.total ||
    auth.allowed + auth.denied + auth.unavailable !== auth.checked ||
    data.items.length > auth.allowed ||
    new Set(data.items.map((item) => item.entityId)).size !== data.items.length ||
    (data.nextCursor ? auth.checked >= auth.total : auth.checked !== auth.total) ||
    [data.audience, data.netGrowth, data.viewsGained].some(
      (metric) =>
        metric &&
        (metric.coverage.includedEntities > auth.allowed ||
          metric.coverage.includedEntities > metric.coverage.totalEntities ||
          metric.coverage.totalEntities !== auth.total),
    )
  )
    throw new Error('Получена неполная проверка статистики. Повторите запрос.');
  return data;
}
export async function runNetworkStatisticsSession(
  scope: StatisticsScope,
  options: {
    signal: AbortSignal;
    onResponse: (data: NetworkStatisticsResponse) => void;
    onReset?: () => void;
    onScopeInvalidated?: (reason: NetworkStatisticsInvalidationReason) => void | Promise<void>;
    wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<void> {
  const release = await acquire(options.signal);
  try {
    let cursor: string | undefined;
    let recoveries = 0;
    let previousChecked = -1;
    let total: number | undefined;
    let previousTo = -Infinity;
    let generationStartedAt = Date.now();
    for (;;) {
      options.signal.throwIfAborted();
      if (Date.now() - generationStartedAt >= 10 * 60_000)
        throw new Error('Проверка доступа не завершилась вовремя. Повторите попытку.');
      let data: NetworkStatisticsResponse;
      try {
        data = await getNetworkStatistics(scope.api, { ...scope, cursor, signal: options.signal });
      } catch (error) {
        options.signal.throwIfAborted();
        if (
          error instanceof ApiRequestError &&
          error.status === 409 &&
          ['NETWORK_STATISTICS_COMPOSITION_CHANGED', 'NETWORK_STATISTICS_ACCESS_CHANGED'].includes(
            error.code ?? '',
          )
        ) {
          options.onReset?.();
          const reason =
            error.code === 'NETWORK_STATISTICS_ACCESS_CHANGED' ? 'access' : 'composition';
          await options.onScopeInvalidated?.(reason);
          throw new NetworkStatisticsScopeChanged(reason);
        }
        if (
          error instanceof ApiRequestError &&
          error.status === 409 &&
          error.code === 'NETWORK_STATISTICS_CURSOR_EXPIRED' &&
          recoveries < 1
        ) {
          recoveries += 1;
          options.onReset?.();
          cursor = undefined;
          previousChecked = -1;
          total = undefined;
          previousTo = -Infinity;
          generationStartedAt = Date.now();
          continue;
        }
        throw error;
      }
      options.signal.throwIfAborted();
      if (data.compositionVersion !== scope.compositionVersion) {
        options.onReset?.();
        await options.onScopeInvalidated?.('composition');
        throw new NetworkStatisticsScopeChanged('composition');
      }
      if (
        (total !== undefined && data.authorization.total !== total) ||
        data.authorization.checked <= previousChecked ||
        new Date(data.period.to).getTime() < previousTo ||
        Date.now() - generationStartedAt >= 10 * 60_000 ||
        (cursor && data.nextCursor && cursor !== data.nextCursor)
      )
        throw new Error('Проверка доступа остановилась. Повторите попытку.');
      total = data.authorization.total;
      previousChecked = data.authorization.checked;
      previousTo = new Date(data.period.to).getTime();
      // The response is a complete replacement. nextCursor is not row pagination.
      options.onResponse(data);
      if (!data.nextCursor) return;
      cursor = data.nextCursor;
      await (options.wait ?? pause)(data.retryAfterMs, options.signal);
    }
  } catch (error) {
    if (!options.signal.aborted) options.onReset?.();
    throw error;
  } finally {
    release();
  }
}

export function useNetworkStatistics(options: UseNetworkStatisticsOptions): NetworkStatisticsState {
  const [revision, setRevision] = useState(0);
  const identity = JSON.stringify([
    options.scopeKey,
    options.entityType,
    options.favoriteType,
    options.range,
    options.compositionVersion,
    options.enabled,
    revision,
  ]);
  const [result, setResult] = useState<{
    identity: string;
    data: NetworkStatisticsResponse | null;
    phase: NetworkStatisticsState['phase'];
    error: NetworkStatisticsLoadError | null;
    api: ApiTransport;
  }>({ identity, data: null, phase: 'idle', error: null, api: options.api });
  const invalidate = useRef(options.onScopeInvalidated);
  invalidate.current = options.onScopeInvalidated;
  useEffect(() => {
    const controller = new AbortController();
    const update = (
      data: NetworkStatisticsResponse | null,
      phase: NetworkStatisticsState['phase'],
      error: NetworkStatisticsLoadError | null = null,
    ) => {
      if (!controller.signal.aborted) setResult({ identity, data, phase, error, api: options.api });
    };
    update(null, options.enabled ? 'loading' : 'idle');
    if (options.enabled) {
      void runNetworkStatisticsSession(options, {
        signal: controller.signal,
        onResponse: (data) => update(data, data.nextCursor ? 'checking' : 'settled'),
        onReset: () => update(null, 'loading'),
        onScopeInvalidated: (reason) => invalidate.current?.(reason),
      }).catch((error: unknown) => {
        update(null, error instanceof NetworkStatisticsScopeChanged ? 'stale' : 'error', {
          code:
            error instanceof ApiRequestError
              ? (error.code ?? 'NETWORK_STATISTICS_UNAVAILABLE')
              : 'NETWORK_STATISTICS_INCOMPLETE',
          message: 'Не удалось завершить проверку статистики. Обновите данные.',
          retryable: !(error instanceof ApiRequestError && [401, 403].includes(error.status)),
        });
      });
    }
    return () => controller.abort();
    // FLAG: identity includes every actor, composition and request scope; api identity is separate.
  }, [identity, options.api]);
  return {
    data: result.identity === identity && result.api === options.api ? result.data : null,
    phase:
      result.identity === identity && result.api === options.api
        ? result.phase
        : options.enabled
          ? 'loading'
          : 'idle',
    error: result.identity === identity && result.api === options.api ? result.error : null,
    refresh: () => setRevision((value) => value + 1),
  };
}
