import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ListLegacyPublicationsQuery } from '@maxim/contracts/publication';
import type { ApiTransport } from '../../lib/api/transport';
import { listLegacyPublications, listPublications } from '../../lib/api/publication-client';
import {
  normalizePublicationView,
  normalizePublicationQuery,
  normalizePublicationEntityFilter,
  normalizePublicationStatusFilter,
  getPublicationListPollingInterval,
  type PublicationView,
  type PublicationEntityFilter,
  type PublicationStatusFilter,
} from './publication-model';
import { mergeLegacyPublicationPages, mergePublicationPages } from './publication-pagination';
import { publicationQueryKeys as queryKeys } from './publication-query-keys';
import { maxImpact } from '../../lib/max-bridge';
import { useNativeBackHandler } from '../../lib/native-back';
type LegacyPublicationView = ListLegacyPublicationsQuery['view'];
type LegacyPublicationKindFilter = ListLegacyPublicationsQuery['kind'];

const PUBLICATION_LIST_PAGE_SIZE = 30;
const LEGACY_PUBLICATION_LIST_PAGE_SIZE = 30;

function normalizeLegacyView(value: string | null): LegacyPublicationView {
  return value === 'history' ? 'history' : 'active';
}

function normalizeLegacyKindFilter(value: string | null): LegacyPublicationKindFilter {
  return value === 'autopost' || value === 'broadcast' ? value : 'all';
}

function normalizeLegacyEntityFilter(value: string | null): PublicationEntityFilter {
  return value === 'chat' || value === 'channel' ? value : 'all';
}

function normalizeLegacyQuery(value: string | null): string {
  return value?.trim().slice(0, 120) ?? '';
}

export function usePublicationList(
  api: ApiTransport,
  isPublisherProfile: boolean,
  isEditor: boolean,
) {
  const [searchParams, setSearchParams] = useSearchParams();
  const legacyRouteRequested = searchParams.get('legacy') === '1';
  const isLegacyView = !isPublisherProfile && legacyRouteRequested && !isEditor;
  const [view, setView] = useState<PublicationView>(() =>
    normalizePublicationView(searchParams.get('view')),
  );
  const [query, setQuery] = useState(() => normalizePublicationQuery(searchParams.get('query')));
  const [debouncedQuery, setDebouncedQuery] = useState(() =>
    normalizePublicationQuery(searchParams.get('query')),
  );
  const [entityFilter, setEntityFilter] = useState<PublicationEntityFilter>(() =>
    normalizePublicationEntityFilter(searchParams.get('entity')),
  );
  const [statusFilter, setStatusFilter] = useState<PublicationStatusFilter>(() =>
    normalizePublicationStatusFilter(
      searchParams.get('status'),
      normalizePublicationView(searchParams.get('view')),
    ),
  );
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [legacyView, setLegacyView] = useState<LegacyPublicationView>(() =>
    normalizeLegacyView(searchParams.get('legacyView')),
  );
  const [legacyQuery, setLegacyQuery] = useState(() =>
    normalizeLegacyQuery(searchParams.get('legacyQuery')),
  );
  const [legacyDebouncedQuery, setLegacyDebouncedQuery] = useState(() =>
    normalizeLegacyQuery(searchParams.get('legacyQuery')),
  );
  const [legacyKindFilter, setLegacyKindFilter] = useState<LegacyPublicationKindFilter>(() =>
    normalizeLegacyKindFilter(searchParams.get('legacyKind')),
  );
  const [legacyEntityFilter, setLegacyEntityFilter] = useState<PublicationEntityFilter>(() =>
    normalizeLegacyEntityFilter(searchParams.get('legacyEntity')),
  );
  const [legacyFiltersOpen, setLegacyFiltersOpen] = useState(false);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [query]);
  useEffect(() => {
    const routeView = normalizePublicationView(searchParams.get('view'));
    const routeQuery = normalizePublicationQuery(searchParams.get('query'));
    const routeEntity = normalizePublicationEntityFilter(searchParams.get('entity'));
    const routeStatus = normalizePublicationStatusFilter(searchParams.get('status'), routeView);

    setView((current) => (current === routeView ? current : routeView));
    setQuery((current) => (current === routeQuery ? current : routeQuery));
    setEntityFilter((current) => (current === routeEntity ? current : routeEntity));
    setStatusFilter((current) => (current === routeStatus ? current : routeStatus));

    if (searchParams.get('view') === 'plan') {
      const canonical = new URLSearchParams(searchParams);
      canonical.delete('view');
      setSearchParams(canonical, { replace: true });
    }
  }, [searchParams, setSearchParams]);
  useEffect(() => {
    const timeoutId = window.setTimeout(() => setLegacyDebouncedQuery(legacyQuery.trim()), 250);
    return () => window.clearTimeout(timeoutId);
  }, [legacyQuery]);
  const listEntityType = entityFilter === 'all' ? undefined : entityFilter;
  const listStatus = statusFilter === 'all' ? undefined : statusFilter;
  const legacyListEntityType = legacyEntityFilter === 'all' ? undefined : legacyEntityFilter;
  const legacyActiveProbeQuery = useQuery({
    queryKey: queryKeys.legacyProbe('active'),
    queryFn: () => listLegacyPublications(api, { view: 'active', limit: 1 }),
    enabled: !isPublisherProfile && !isEditor,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const legacyHistoryProbeQuery = useQuery({
    queryKey: queryKeys.legacyProbe('history'),
    queryFn: () => listLegacyPublications(api, { view: 'history', limit: 1 }),
    enabled: !isPublisherProfile && !isEditor,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const legacyListQuery = useInfiniteQuery({
    queryKey: queryKeys.legacyList(
      legacyView,
      legacyDebouncedQuery,
      legacyKindFilter,
      legacyEntityFilter,
    ),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listLegacyPublications(api, {
        view: legacyView,
        query: legacyDebouncedQuery,
        kind: legacyKindFilter,
        entityType: legacyListEntityType,
        limit: LEGACY_PUBLICATION_LIST_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !isPublisherProfile && isLegacyView,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const currentQuery = useInfiniteQuery({
    queryKey: queryKeys.list('current', debouncedQuery, entityFilter, statusFilter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, {
        view: 'current',
        query: debouncedQuery,
        entityType: listEntityType,
        status: listStatus,
        limit: PUBLICATION_LIST_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !isEditor && !isLegacyView && view === 'current',
    refetchInterval: (query) => {
      const items = query.state.data?.pages.flatMap((page) => page.items) ?? [];
      return getPublicationListPollingInterval('current', items);
    },
  });
  const schedulesQuery = useInfiniteQuery({
    queryKey: queryKeys.list('schedules', debouncedQuery, entityFilter, statusFilter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, {
        view: 'schedules',
        query: debouncedQuery,
        entityType: listEntityType,
        status: listStatus,
        limit: PUBLICATION_LIST_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !isEditor && !isLegacyView && view === 'schedules',
    refetchInterval: (query) => {
      const items = query.state.data?.pages.flatMap((page) => page.items) ?? [];
      return getPublicationListPollingInterval('schedules', items);
    },
  });
  const historyQuery = useInfiniteQuery({
    queryKey: queryKeys.list('history', debouncedQuery, entityFilter, statusFilter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, {
        view: 'history',
        query: debouncedQuery,
        entityType: listEntityType,
        status: listStatus,
        limit: PUBLICATION_LIST_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !isEditor && !isLegacyView && view === 'history',
  });
  const currentItems = useMemo(
    () => mergePublicationPages(currentQuery.data?.pages),
    [currentQuery.data?.pages],
  );
  const scheduleItems = useMemo(
    () => mergePublicationPages(schedulesQuery.data?.pages),
    [schedulesQuery.data?.pages],
  );
  const historyItems = useMemo(
    () => mergePublicationPages(historyQuery.data?.pages),
    [historyQuery.data?.pages],
  );
  const legacyItems = useMemo(
    () => mergeLegacyPublicationPages(legacyListQuery.data?.pages),
    [legacyListQuery.data?.pages],
  );
  const legacyActiveCount = legacyActiveProbeQuery.data?.totalCount ?? null;
  const legacyHistoryCount = legacyHistoryProbeQuery.data?.totalCount ?? null;
  const legacyKnownCount = (legacyActiveCount ?? 0) + (legacyHistoryCount ?? 0);
  const legacyProbeHasError = legacyActiveProbeQuery.isError || legacyHistoryProbeQuery.isError;
  const legacyProbeComplete =
    (legacyActiveProbeQuery.isSuccess || legacyActiveProbeQuery.isError) &&
    (legacyHistoryProbeQuery.isSuccess || legacyHistoryProbeQuery.isError);
  const showLegacyEntry =
    !isPublisherProfile && (legacyKnownCount > 0 || (legacyProbeComplete && legacyProbeHasError));
  const legacyEntryCount =
    legacyKnownCount > 0
      ? legacyKnownCount
      : legacyActiveCount !== null && legacyHistoryCount !== null
        ? 0
        : null;
  const legacyCurrentTotal = legacyListQuery.data?.pages[0]?.totalCount ?? null;

  const visibleItems =
    view === 'history' ? historyItems : view === 'schedules' ? scheduleItems : currentItems;
  const currentListQuery =
    view === 'history' ? historyQuery : view === 'schedules' ? schedulesQuery : currentQuery;
  useNativeBackHandler(
    () => {
      closeLegacyView();
      return true;
    },
    { enabled: isLegacyView, priority: 600 },
  );

  function setLegacyRoute(
    open: boolean,
    state: {
      view?: LegacyPublicationView;
      query?: string;
      kind?: LegacyPublicationKindFilter;
      entity?: PublicationEntityFilter;
    } = {},
  ) {
    const next = new URLSearchParams(searchParams);
    if (open) {
      const nextView = state.view ?? legacyView;
      const nextQuery = state.query ?? legacyQuery;
      const nextKind = state.kind ?? legacyKindFilter;
      const nextEntity = state.entity ?? legacyEntityFilter;
      next.set('legacy', '1');
      if (nextView === 'active') {
        next.delete('legacyView');
      } else {
        next.set('legacyView', nextView);
      }
      if (nextQuery.trim()) {
        next.set('legacyQuery', nextQuery.trim());
      } else {
        next.delete('legacyQuery');
      }
      if (nextKind === 'all') {
        next.delete('legacyKind');
      } else {
        next.set('legacyKind', nextKind);
      }
      if (nextEntity === 'all') {
        next.delete('legacyEntity');
      } else {
        next.set('legacyEntity', nextEntity);
      }
    } else {
      next.delete('legacy');
      next.delete('legacyView');
      next.delete('legacyQuery');
      next.delete('legacyKind');
      next.delete('legacyEntity');
    }
    setSearchParams(next, { replace: true });
  }

  function openLegacyView() {
    const nextView = view === 'history' ? 'history' : 'active';
    setLegacyView(nextView);
    setLegacyRoute(true, { view: nextView });
    window.scrollTo({ top: 0, behavior: 'auto' });
    maxImpact('soft');
  }

  function closeLegacyView() {
    setLegacyRoute(false);
    window.scrollTo({ top: 0, behavior: 'auto' });
    maxImpact('soft');
  }

  function changeView(nextView: PublicationView) {
    const nextStatus = normalizePublicationStatusFilter(statusFilter, nextView);
    setView(nextView);
    setStatusFilter(nextStatus);
    setPublicationHubRoute({ view: nextView, status: nextStatus });
    maxImpact('soft');
  }

  function setPublicationHubRoute(
    state: {
      view?: PublicationView;
      query?: string;
      entity?: PublicationEntityFilter;
      status?: PublicationStatusFilter;
    } = {},
  ) {
    const nextView = state.view ?? view;
    const nextQuery = normalizePublicationQuery(state.query ?? query);
    const nextEntity = state.entity ?? entityFilter;
    const nextStatus = normalizePublicationStatusFilter(state.status ?? statusFilter, nextView);
    const next = new URLSearchParams(searchParams);
    if (nextView === 'current') {
      next.delete('view');
    } else {
      next.set('view', nextView);
    }
    if (nextQuery.trim()) {
      next.set('query', nextQuery);
    } else {
      next.delete('query');
    }
    if (nextEntity === 'all') {
      next.delete('entity');
    } else {
      next.set('entity', nextEntity);
    }
    if (nextStatus === 'all') {
      next.delete('status');
    } else {
      next.set('status', nextStatus);
    }
    setSearchParams(next, { replace: true });
  }

  return {
    view,
    setView,
    query,
    setQuery,
    entityFilter,
    setEntityFilter,
    statusFilter,
    setStatusFilter,
    filtersOpen,
    setFiltersOpen,
    legacyView,
    setLegacyView,
    legacyQuery,
    setLegacyQuery,
    legacyKindFilter,
    setLegacyKindFilter,
    legacyEntityFilter,
    setLegacyEntityFilter,
    legacyFiltersOpen,
    setLegacyFiltersOpen,
    isLegacyView,
    currentQuery,
    schedulesQuery,
    historyQuery,
    legacyListQuery,
    currentItems,
    scheduleItems,
    historyItems,
    legacyItems,
    showLegacyEntry,
    legacyEntryCount,
    legacyActiveCount,
    legacyHistoryCount,
    legacyProbeHasError,
    legacyCurrentTotal,
    visibleItems,
    currentListQuery,
    setLegacyRoute,
    openLegacyView,
    closeLegacyView,
    changeView,
    setPublicationHubRoute,
  };
}
