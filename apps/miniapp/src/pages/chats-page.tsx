import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type PointerEvent as ReactPointerEvent,
  type SVGProps,
} from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  ChatSummary,
  ManagedEntitiesRefreshState,
  ManagedEntityFavoriteType,
} from '@maxim/contracts';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import {
  HOME_ENTITY_FAVORITE_ICONS,
  RefreshGlyph,
  SearchGlyph,
  SettingsGlyph,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { describeApiError } from '../lib/api-error';
import { getMe, updateManagedEntityFavorites } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_TYPES,
  HOME_ENTITY_FAVORITE_LABELS,
  HOME_ENTITY_FAVORITE_TITLES,
  type HomeEntityFavoriteLabelOverrides,
  buildHomeEntityFavoritesMigrationKey,
  createHomeEntityFavoritesFromEntities,
  createHomeEntityFavoritesFromLegacy,
  getHomeEntityFavoritesFallbackScope,
  getHomeEntityFavoriteTypes,
  hydrateHomeEntityFavoriteLabels,
  hydrateHomeEntityFavorites,
  isHomeEntityFavorite,
  mergeHomeEntityFavoriteLabels,
  mergeHomeEntityFavorites,
  orderHomeEntitiesByFavorites,
  readHomeEntityFavoriteLabels,
  readLegacyHomeEntityFavorites,
  readHomeEntityFavorites,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  saveHomeEntityFavoriteLabels,
  saveHomeEntityFavorites,
  setHomeEntityFavoriteTypes,
  toggleHomeEntityFavoriteType,
} from '../lib/home-entity-favorites';
import { getInitDataUserId } from '../lib/init-data';
import {
  buildManagedEntitiesRoute,
  buildHomeView,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import { useNativeBackHandler } from '../lib/native-back';
import { queryKeys } from '../lib/query-keys';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './page-preloads';
import './chats-page.css';

type ManagedTab = 'chat' | 'channel';
type HomeSyncTone = 'ready' | 'syncing' | 'cache' | 'warning';
type ManagedHomeEntity = ChatSummary;
type EntitySignal = {
  key: string;
  value?: string;
  Icon: ElementType<SVGProps<SVGSVGElement>>;
};
type ManagedEntitiesReloadRequest = {
  nonce: number;
  behavior: 'default' | 'manual' | 'recovery';
};
type WindowWithIdleCallback = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const CHAT_CARD_STAGGER_STEP_MS = 45;
const CHAT_CARD_STAGGER_LIMIT = 10;
const CHAT_CARD_STAGGER_THRESHOLD = 24;
const DEFAULT_DASHBOARD_RANGE = '24h';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
const HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 2_000;
const CHAT_LIST_VIRTUALIZATION_THRESHOLD = 80;
const CHAT_LIST_VIRTUAL_OVERSCAN = 6;
const CHAT_LIST_VIRTUAL_ROW_HEIGHT = 104;
const CHAT_LIST_VIRTUAL_WINDOW_SIZE = 20;
const FAVORITE_FILTER_ALL = 'all';
type FavoriteLabelDraft = Record<ManagedEntityFavoriteType, string>;

function createFavoriteLabelDraft(labels: HomeEntityFavoriteLabelOverrides): FavoriteLabelDraft {
  return resolveHomeEntityFavoriteLabels(labels);
}

function limitFavoriteLabelInput(value: string): string {
  return Array.from(value).slice(0, HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH).join('');
}

const LazySystemEntryCard = lazy(async () => {
  const module = await import('../components/system-entry-card');
  return { default: module.SystemEntryCard };
});

const LazyChatOnboardingSection = lazy(async () => {
  const module = await import('../components/chat-onboarding-section');
  return { default: module.ChatOnboardingSection };
});

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function shouldPrefetchFromPointerEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType === 'mouse';
}

function shouldPrefetchFromPressEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType !== 'mouse';
}

function formatRefreshProgress(refreshState: ManagedEntitiesRefreshState | null): string | null {
  if (
    typeof refreshState?.processedCandidates === 'number' &&
    typeof refreshState.totalCandidates === 'number' &&
    refreshState.totalCandidates >= refreshState.processedCandidates
  ) {
    return `${refreshState.processedCandidates} из ${refreshState.totalCandidates}`;
  }
  if (typeof refreshState?.progressPercent === 'number') {
    return `${refreshState.progressPercent}%`;
  }

  return null;
}

function buildPendingSyncDescription(options: {
  tab: ManagedTab;
  refreshState: ManagedEntitiesRefreshState | null;
  hasLoadedFromServer: boolean;
}): string {
  const entityPlural = options.tab === 'chat' ? 'чаты' : 'каналы';
  const progress = formatRefreshProgress(options.refreshState);

  if (!options.hasLoadedFromServer) {
    return `Проверяем ${entityPlural} на сервере и подтягиваем контекст запуска.`;
  }
  if (progress) {
    return `Сверяем права администратора в MAX. Прогресс: ${progress}.`;
  }

  return 'Обновляем локальный список и сверяем права администратора в MAX.';
}

function buildHomeSyncStatus(options: {
  isRefreshing: boolean;
  isBackoffActive: boolean;
  hasLoadedFromServer: boolean;
  snapshotStale: boolean | null | undefined;
  isSyncComplete: boolean;
}): { label: string; tone: HomeSyncTone } {
  if (options.isBackoffActive) {
    return { label: 'Пауза', tone: 'warning' };
  }
  if (!options.hasLoadedFromServer) {
    return { label: 'Кеш', tone: 'cache' };
  }
  if (options.isSyncComplete) {
    return { label: 'Готово', tone: 'ready' };
  }
  if (options.isRefreshing || options.snapshotStale === true) {
    return { label: 'Синк', tone: 'syncing' };
  }

  return { label: 'Готово', tone: 'ready' };
}

function formatCompactLinkLabel(link: string | null | undefined): string | null {
  const rawLink = link?.trim();
  if (!rawLink) {
    return null;
  }

  try {
    const parsed = new URL(rawLink);
    const hostname = parsed.hostname.replace(/^www\./u, '');
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const lastPathPart = pathParts[pathParts.length - 1];

    if (hostname === 'max.ru' && lastPathPart) {
      return `@${decodeURIComponent(lastPathPart)}`;
    }

    return hostname || rawLink;
  } catch {
    return rawLink.length > 28 ? `${rawLink.slice(0, 25)}...` : rawLink;
  }
}

function buildEntitySignals(entity: ManagedHomeEntity, entityType: ManagedTab): EntitySignal[] {
  if (entityType !== 'channel' || !entity.channelOverview) {
    return [];
  }

  const signals: EntitySignal[] = [];
  const secondarySignals: EntitySignal[] = [];
  if (entity.channelOverview.enabledScenariosCount > 0) {
    signals.push({
      key: 'scenarios',
      value: String(entity.channelOverview.enabledScenariosCount),
      Icon: SparksGlyph,
    });
  }
  if (
    entity.channelOverview.commentsEnabled ||
    entity.channelOverview.postSuggestionsEnabled ||
    entity.channelOverview.commentsModerationEnabled
  ) {
    secondarySignals.push({
      key: 'live',
      Icon: CommentsGlyph,
    });
  }

  return [...signals, ...secondarySignals].slice(0, 2);
}

function buildEntitySettingsRoute(entityType: ManagedTab, entityId: string): string {
  return entityType === 'channel' ? `/channel/${entityId}/settings` : `/chat/${entityId}/settings`;
}

function buildEntityActivityRoute(entityType: ManagedTab, entityId: string): string {
  return entityType === 'channel' ? `/channel/${entityId}/stats` : `/chat/${entityId}/events`;
}

function buildEntityRouteState(entityType: ManagedTab, entity: ManagedHomeEntity) {
  if (entityType === 'channel') {
    return {
      chatTitle: entity.title,
      chatLink: entity.link ?? '',
      avatarUrl: entity.avatarUrl ?? null,
    };
  }

  return {
    chatTitle: entity.title,
    avatarUrl: entity.avatarUrl ?? null,
  };
}

function ActivityGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M5 17V9.8" />
      <path d="M10 17V7" />
      <path d="M15 17v-4.6" />
      <path d="M20 17V5" />
      <path d="M4.5 19h15.8" />
    </svg>
  );
}

function SparksGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 3.8l1.2 4.1 4 1.2-4 1.2-1.2 4.1-1.2-4.1-4-1.2 4-1.2L12 3.8Z" />
      <path d="M18.2 13.8l.7 2.2 2.2.7-2.2.7-.7 2.2-.7-2.2-2.2-.7 2.2-.7.7-2.2Z" />
      <path d="M5.8 14.5l.5 1.7 1.7.5-1.7.5-.5 1.7-.5-1.7-1.7-.5 1.7-.5.5-1.7Z" />
    </svg>
  );
}

function CommentsGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M7 6h10a3 3 0 013 3v4.3a3 3 0 01-3 3h-4.6L8.6 19v-2.7H7a3 3 0 01-3-3V9a3 3 0 013-3Z" />
      <path d="M8.5 10.2h7M8.5 13h4.8" />
    </svg>
  );
}

function PlusGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function CheckGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path
        d="M5 12.4l4.2 4.1L19 7"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [canAccessSystem, setCanAccessSystem] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => getInitDataUserId());
  const virtualListViewportRef = useRef<HTMLElement | null>(null);
  const [virtualListScrollTop, setVirtualListScrollTop] = useState(0);
  const favoriteStorageScope = useMemo(() => {
    const normalizedUserId = currentUserId?.trim();
    return normalizedUserId ? `u:${normalizedUserId}` : getHomeEntityFavoritesFallbackScope();
  }, [currentUserId]);
  const favoriteStorageScopeRef = useRef(favoriteStorageScope);
  const [homeEntityFavorites, setHomeEntityFavorites] = useState(() =>
    readHomeEntityFavorites(favoriteStorageScope),
  );
  const favoriteLabelStorageScopeRef = useRef(favoriteStorageScope);
  const [homeEntityFavoriteLabels, setHomeEntityFavoriteLabels] =
    useState<HomeEntityFavoriteLabelOverrides>(() =>
      readHomeEntityFavoriteLabels(favoriteStorageScope),
    );
  const favoriteLabels = useMemo(
    () => resolveHomeEntityFavoriteLabels(homeEntityFavoriteLabels),
    [homeEntityFavoriteLabels],
  );
  const [favoriteFilter, setFavoriteFilter] = useState<
    ManagedEntityFavoriteType | typeof FAVORITE_FILTER_ALL
  >(FAVORITE_FILTER_ALL);
  const [favoritePicker, setFavoritePicker] = useState<{
    entityType: ManagedTab;
    entity: ManagedHomeEntity;
  } | null>(null);
  const [favoriteLabelsEditorOpen, setFavoriteLabelsEditorOpen] = useState(false);
  const [favoriteLabelDraft, setFavoriteLabelDraft] = useState<FavoriteLabelDraft>(() =>
    createFavoriteLabelDraft(readHomeEntityFavoriteLabels(favoriteStorageScope)),
  );
  const [savingFavoriteEntityKey, setSavingFavoriteEntityKey] = useState<string | null>(null);
  const favoriteOverlayOpen = Boolean(favoritePicker) || favoriteLabelsEditorOpen;
  const favoritePickerOverlayStyle = useVisualViewportOverlayStyle(favoriteOverlayOpen);
  const favoriteMigrationAttemptedRef = useRef(false);
  const [refreshRequestByTab, setRefreshRequestByTab] = useState<
    Record<ManagedTab, ManagedEntitiesReloadRequest>
  >({
    chat: { nonce: 0, behavior: 'default' },
    channel: { nonce: 0, behavior: 'default' },
  });
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;

  useNativeBackHandler(
    () => {
      if (favoriteLabelsEditorOpen) {
        setFavoriteLabelsEditorOpen(false);
      } else {
        setFavoritePicker(null);
      }
      return true;
    },
    { enabled: favoriteOverlayOpen, priority: 650 },
  );

  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat',
    reloadNonce: refreshRequestByTab.chat.nonce,
    reloadBehavior: refreshRequestByTab.chat.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    keepVisibleOnSameSnapshotVersion: true,
    treatUserVisibleCompleteAsSettled: false,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshRequestByTab.channel.nonce,
    reloadBehavior: refreshRequestByTab.channel.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    keepVisibleOnSameSnapshotVersion: true,
    treatUserVisibleCompleteAsSettled: false,
  });

  const activeEntities = useMemo(() => {
    return activeEntitiesKey === 'chats' ? chatsState.data : channelsState.data;
  }, [activeEntitiesKey, channelsState.data, chatsState.data]);

  const activeEntitiesState = activeTab === 'chat' ? chatsState : channelsState;
  const isLoading = activeEntitiesState.isLoading;
  const isFetching = activeEntitiesState.isRefreshing;
  const queryError = activeEntitiesState.error;
  const refreshState = activeEntitiesState.refreshState;
  const manualRefreshBlockedReason = refreshState?.manualRefreshBlockedReason ?? null;
  const manualRefreshRetryAfterSec =
    typeof refreshState?.manualRefreshRetryAfterMs === 'number' &&
    refreshState.manualRefreshRetryAfterMs > 0
      ? Math.max(1, Math.ceil(refreshState.manualRefreshRetryAfterMs / 1_000))
      : null;
  const isUserVisibleSyncSettled =
    activeEntitiesState.isSyncComplete ||
    activeEntitiesState.isUserVisibleComplete ||
    activeEntitiesState.isBackoffActive;
  const isSyncSettled = isUserVisibleSyncSettled;
  const isSyncPending = !isLoading && !queryError && !isSyncSettled;
  const isRefreshTemporarilyBlocked =
    manualRefreshBlockedReason === 'backoff' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshCoolingDown =
    manualRefreshBlockedReason === 'recent_sync' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshInProgressByState =
    manualRefreshBlockedReason === 'in_progress' &&
    !activeEntitiesState.isRefreshing &&
    !activeEntitiesState.isUserVisibleComplete;
  const isManualRefreshBlocked =
    isRefreshTemporarilyBlocked || isManualRefreshCoolingDown || isManualRefreshInProgressByState;
  const isForegroundSyncing = activeEntitiesState.isRefreshing && !isUserVisibleSyncSettled;
  const homeSyncStatus = buildHomeSyncStatus({
    isRefreshing: isForegroundSyncing,
    isBackoffActive: activeEntitiesState.isBackoffActive,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
    snapshotStale: activeEntitiesState.snapshot?.stale ?? null,
    isSyncComplete: isUserVisibleSyncSettled,
  });
  const refreshProgressPercent =
    !activeEntitiesState.isUserVisibleComplete &&
    !activeEntitiesState.isBackoffActive &&
    typeof refreshState?.progressPercent === 'number'
      ? Math.max(0, Math.min(100, refreshState.progressPercent))
      : null;

  const hasNoActiveEntities =
    !isLoading && !queryError && Array.isArray(activeEntities) && activeEntities.length === 0;
  const showTransientEmptyState = hasNoActiveEntities && activeEntitiesState.isBackoffActive;
  const isNoEntitiesForTab = hasNoActiveEntities && isSyncSettled && !showTransientEmptyState;

  const filteredEntities = useMemo(() => {
    const [matchingEntities] = buildHomeView({
      entities: activeEntities,
      query,
    });
    const filteredByFavorite =
      favoriteFilter === FAVORITE_FILTER_ALL
        ? matchingEntities
        : matchingEntities.filter((entity) =>
            isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id, favoriteFilter),
          );

    return orderHomeEntitiesByFavorites(
      filteredByFavorite,
      homeEntityFavorites[activeTab],
      favoriteFilter === FAVORITE_FILTER_ALL ? HOME_ENTITY_FAVORITE_TYPES : [favoriteFilter],
    );
  }, [activeEntities, activeTab, favoriteFilter, homeEntityFavorites, query]);
  const favoriteCounts = useMemo(() => {
    if (!Array.isArray(activeEntities) || activeEntities.length === 0) {
      return HOME_ENTITY_FAVORITE_TYPES.reduce(
        (acc, favoriteType) => ({
          ...acc,
          [favoriteType]: 0,
        }),
        {} as Record<ManagedEntityFavoriteType, number>,
      );
    }

    return HOME_ENTITY_FAVORITE_TYPES.reduce(
      (acc, favoriteType) => {
        acc[favoriteType] = activeEntities.filter((entity) =>
          isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id, favoriteType),
        ).length;
        return acc;
      },
      {} as Record<ManagedEntityFavoriteType, number>,
    );
  }, [activeEntities, activeTab, homeEntityFavorites]);
  const visibleFavoriteFilterTypes = useMemo(
    () =>
      HOME_ENTITY_FAVORITE_TYPES.filter(
        (favoriteType) => favoriteCounts[favoriteType] > 0 || favoriteFilter === favoriteType,
      ),
    [favoriteCounts, favoriteFilter],
  );
  const hasSearchQuery = query.trim().length > 0;
  const tabCounts = useMemo(
    () => ({
      chat: Array.isArray(chatsState.data) ? chatsState.data.length : null,
      channel: Array.isArray(channelsState.data) ? channelsState.data.length : null,
    }),
    [channelsState.data, chatsState.data],
  );
  const showEmptyState = isNoEntitiesForTab;
  const limitedStagger =
    filteredEntities.length > CHAT_CARD_STAGGER_THRESHOLD ? CHAT_CARD_STAGGER_LIMIT : null;
  const shouldVirtualizeEntities = filteredEntities.length > CHAT_LIST_VIRTUALIZATION_THRESHOLD;
  const virtualStartIndex = shouldVirtualizeEntities
    ? Math.max(
        0,
        Math.floor(virtualListScrollTop / CHAT_LIST_VIRTUAL_ROW_HEIGHT) -
          CHAT_LIST_VIRTUAL_OVERSCAN,
      )
    : 0;
  const virtualEndIndex = shouldVirtualizeEntities
    ? Math.min(filteredEntities.length, virtualStartIndex + CHAT_LIST_VIRTUAL_WINDOW_SIZE)
    : filteredEntities.length;
  const renderedEntities = shouldVirtualizeEntities
    ? filteredEntities.slice(virtualStartIndex, virtualEndIndex)
    : filteredEntities;
  const settledRefreshMarker = useMemo(
    () =>
      buildManagedEntitiesSettledMarker({
        scopeKey: activeTab,
        hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
        isSyncComplete:
          activeEntitiesState.isSyncComplete || activeEntitiesState.isUserVisibleComplete,
        isBackoffActive: activeEntitiesState.isBackoffActive,
        snapshotVersion: activeEntitiesState.snapshot?.version,
        snapshotBuiltAt: activeEntitiesState.snapshot?.builtAt,
        lastSyncedAt: activeEntitiesState.refreshState?.lastSyncedAt,
      }),
    [
      activeEntitiesState.hasLoadedFromServer,
      activeEntitiesState.isBackoffActive,
      activeEntitiesState.isSyncComplete,
      activeEntitiesState.isUserVisibleComplete,
      activeEntitiesState.refreshState?.lastSyncedAt,
      activeEntitiesState.snapshot?.builtAt,
      activeEntitiesState.snapshot?.version,
      activeTab,
    ],
  );
  const { noteRefreshRequested } = useManagedEntitiesVisibilityRefresh({
    enabled: true,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
    isLoading: activeEntitiesState.isLoading,
    isRefreshing: activeEntitiesState.isRefreshing,
    isSyncComplete: activeEntitiesState.isSyncComplete || activeEntitiesState.isUserVisibleComplete,
    snapshotStale: activeEntitiesState.snapshot?.stale ?? null,
    settledMarker: settledRefreshMarker,
    minIntervalMs: HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
    minHiddenDurationMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
    onVisibilityReturnRefresh: () => {
      handleRefresh(activeTab, 'recovery');
    },
  });

  function queueRefresh(tab: ManagedTab, behavior: ManagedEntitiesReloadRequest['behavior']) {
    noteRefreshRequested();
    if (behavior === 'manual') {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.managedEntityOnboardingDiagnostics(tab),
      });
    }
    setRefreshRequestByTab((current) => ({
      ...current,
      [tab]: {
        nonce: current[tab].nonce + 1,
        behavior,
      },
    }));
  }

  function handleRefresh(
    tab: ManagedTab = activeTab,
    behavior: ManagedEntitiesReloadRequest['behavior'] = 'default',
  ) {
    if (isFetching) {
      return;
    }
    if (behavior !== 'recovery' && isManualRefreshBlocked) {
      return;
    }

    queueRefresh(tab, behavior);
  }

  useEffect(() => {
    const allEntities = [...(chatsState.data ?? []), ...(channelsState.data ?? [])];
    if (allEntities.length === 0) {
      return;
    }

    saveChatTitles(allEntities);
  }, [channelsState.data, chatsState.data]);

  useEffect(() => {
    let cancelled = false;

    void hydrateHomeEntityFavorites(favoriteStorageScope).then((nativeFavorites) => {
      if (cancelled) {
        return;
      }

      setHomeEntityFavorites((current) => {
        const next = mergeHomeEntityFavorites(current, nativeFavorites);
        if (JSON.stringify(next) === JSON.stringify(current)) {
          return current;
        }

        saveHomeEntityFavorites(favoriteStorageScope, next);
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [favoriteStorageScope]);

  useEffect(() => {
    let cancelled = false;

    void hydrateHomeEntityFavoriteLabels(favoriteStorageScope).then((nativeLabels) => {
      if (cancelled) {
        return;
      }

      setHomeEntityFavoriteLabels((current) => {
        const next = mergeHomeEntityFavoriteLabels(current, nativeLabels);
        if (JSON.stringify(next) === JSON.stringify(current)) {
          return current;
        }

        saveHomeEntityFavoriteLabels(favoriteStorageScope, next);
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [favoriteStorageScope]);

  useEffect(() => {
    const serverFavorites = createHomeEntityFavoritesFromEntities({
      chats: chatsState.data ?? undefined,
      channels: channelsState.data ?? undefined,
    });
    const hasServerFavorites = HOME_ENTITY_FAVORITE_TYPES.some(
      (favoriteType) =>
        serverFavorites.chat[favoriteType].length > 0 ||
        serverFavorites.channel[favoriteType].length > 0,
    );
    if (!hasServerFavorites) {
      return;
    }

    setHomeEntityFavorites((current) => {
      const next = mergeHomeEntityFavorites(current, serverFavorites);
      if (JSON.stringify(next) === JSON.stringify(current)) {
        return current;
      }

      saveHomeEntityFavorites(favoriteStorageScope, next);
      return next;
    });
  }, [channelsState.data, chatsState.data, favoriteStorageScope]);

  useEffect(() => {
    saveLastEntityType(activeTab);
  }, [activeTab]);

  useEffect(() => {
    setVirtualListScrollTop(0);
    if (virtualListViewportRef.current) {
      virtualListViewportRef.current.scrollTop = 0;
    }
  }, [activeTab, favoriteFilter, query, shouldVirtualizeEntities]);

  useEffect(() => {
    document.body.classList.add('chats-home-page-open');

    return () => {
      document.body.classList.remove('chats-home-page-open');
    };
  }, []);

  useEffect(() => {
    if (!favoriteOverlayOpen) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;

    body.classList.add('favorite-picker-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    return () => {
      body.classList.remove('favorite-picker-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [favoriteOverlayOpen]);

  useEffect(() => {
    const previousScope = favoriteStorageScopeRef.current;
    if (previousScope === favoriteStorageScope) {
      return;
    }

    const storedFavorites = readHomeEntityFavorites(favoriteStorageScope);
    const nextFavorites =
      previousScope === getHomeEntityFavoritesFallbackScope() &&
      favoriteStorageScope !== getHomeEntityFavoritesFallbackScope()
        ? mergeHomeEntityFavorites(storedFavorites, readHomeEntityFavorites(previousScope))
        : storedFavorites;
    const serverFavorites = createHomeEntityFavoritesFromEntities({
      chats: chatsState.data ?? undefined,
      channels: channelsState.data ?? undefined,
    });
    const hasServerFavorites = HOME_ENTITY_FAVORITE_TYPES.some(
      (favoriteType) =>
        serverFavorites.chat[favoriteType].length > 0 ||
        serverFavorites.channel[favoriteType].length > 0,
    );
    const scopedFavorites = hasServerFavorites
      ? mergeHomeEntityFavorites(nextFavorites, serverFavorites)
      : nextFavorites;

    if (JSON.stringify(scopedFavorites) !== JSON.stringify(storedFavorites)) {
      saveHomeEntityFavorites(favoriteStorageScope, scopedFavorites);
    }

    favoriteStorageScopeRef.current = favoriteStorageScope;
    favoriteMigrationAttemptedRef.current = false;
    setHomeEntityFavorites(scopedFavorites);
  }, [channelsState.data, chatsState.data, favoriteStorageScope]);

  useEffect(() => {
    const previousScope = favoriteLabelStorageScopeRef.current;
    if (previousScope === favoriteStorageScope) {
      return;
    }

    const storedLabels = readHomeEntityFavoriteLabels(favoriteStorageScope);
    const scopedLabels =
      previousScope === getHomeEntityFavoritesFallbackScope() &&
      favoriteStorageScope !== getHomeEntityFavoritesFallbackScope()
        ? mergeHomeEntityFavoriteLabels(storedLabels, readHomeEntityFavoriteLabels(previousScope))
        : storedLabels;

    if (JSON.stringify(scopedLabels) !== JSON.stringify(storedLabels)) {
      saveHomeEntityFavoriteLabels(favoriteStorageScope, scopedLabels);
    }

    favoriteLabelStorageScopeRef.current = favoriteStorageScope;
    setHomeEntityFavoriteLabels(scopedLabels);
    setFavoriteLabelDraft(createFavoriteLabelDraft(scopedLabels));
  }, [favoriteStorageScope]);

  useEffect(() => {
    if (
      favoriteMigrationAttemptedRef.current ||
      favoriteStorageScope === getHomeEntityFavoritesFallbackScope() ||
      typeof window === 'undefined'
    ) {
      return;
    }

    favoriteMigrationAttemptedRef.current = true;
    const migrationKey = buildHomeEntityFavoritesMigrationKey(favoriteStorageScope);
    if (window.localStorage.getItem(migrationKey) === '1') {
      return;
    }

    const legacy = readLegacyHomeEntityFavorites(favoriteStorageScope);
    const legacyFavorites = createHomeEntityFavoritesFromLegacy(legacy);
    const legacyItems = [
      ...legacyFavorites.chat.important.map((id) => ({ entityType: 'chat' as const, id })),
      ...legacyFavorites.channel.important.map((id) => ({ entityType: 'channel' as const, id })),
    ];
    if (legacyItems.length === 0) {
      window.localStorage.setItem(migrationKey, '1');
      return;
    }

    const nextFavorites = mergeHomeEntityFavorites(homeEntityFavorites, legacyFavorites);
    setHomeEntityFavorites(nextFavorites);
    saveHomeEntityFavorites(favoriteStorageScope, nextFavorites);
    window.localStorage.setItem(migrationKey, '1');

    void Promise.allSettled(
      legacyItems.map((item) =>
        updateManagedEntityFavorites(
          api,
          item.entityType,
          item.id,
          getHomeEntityFavoriteTypes(nextFavorites, item.entityType, item.id),
        ),
      ),
    );
  }, [api, favoriteStorageScope, homeEntityFavorites]);

  useEffect(() => {
    const controller = new AbortController();

    void getMe(api, { signal: controller.signal })
      .then((me) => {
        if (!controller.signal.aborted) {
          setCurrentUserId(me.userId);
          setCanAccessSystem(me.canAccessSystem === true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCanAccessSystem(false);
        }
      });

    return () => controller.abort();
  }, [api]);

  function prefetchChatSettings(chatId: string) {
    void chatId;
    preloadSettingsPage();
  }

  function prefetchChatEvents(chatId: string) {
    preloadEventsPage();
    void queryClient
      .prefetchQuery({
        queryKey: queryKeys.logsDashboard(chatId, DEFAULT_DASHBOARD_RANGE, false, true),
        queryFn: async ({ signal }) => {
          const { getChatModerationDashboard } = await import('../lib/api/events-client');
          return getChatModerationDashboard(api, chatId, DEFAULT_DASHBOARD_RANGE, { signal });
        },
      })
      .catch(() => undefined);
  }

  function prefetchChannelSettings(chatId: string) {
    void chatId;
    preloadChannelSettingsPage();
  }

  function rememberEntity(entityType: ManagedTab, entity: ManagedHomeEntity) {
    saveLastEntityId(entityType, entity.id);
    saveChatTitle(entity.id, entity.title);
  }

  function prefetchEntitySettings(entityType: ManagedTab, entityId: string) {
    if (entityType === 'channel') {
      prefetchChannelSettings(entityId);
      return;
    }

    prefetchChatSettings(entityId);
  }

  function prefetchEntityActivity(entityType: ManagedTab, entityId: string) {
    if (entityType === 'channel') {
      prefetchChannelStats(entityId);
      return;
    }

    prefetchChatEvents(entityId);
  }

  function buildFavoriteEntityKey(entityType: ManagedTab, entityId: string) {
    return `${entityType}:${entityId}`;
  }

  function openFavoriteLabelsEditor() {
    setFavoritePicker(null);
    setFavoriteLabelDraft(createFavoriteLabelDraft(homeEntityFavoriteLabels));
    setFavoriteLabelsEditorOpen(true);
  }

  function closeFavoriteLabelsEditor() {
    setFavoriteLabelDraft(createFavoriteLabelDraft(homeEntityFavoriteLabels));
    setFavoriteLabelsEditorOpen(false);
  }

  function updateFavoriteLabelDraft(favoriteType: ManagedEntityFavoriteType, value: string) {
    const nextValue = limitFavoriteLabelInput(value);
    setFavoriteLabelDraft((current) => ({
      ...current,
      [favoriteType]: nextValue,
    }));
  }

  function resetFavoriteLabelDraft(favoriteType: ManagedEntityFavoriteType) {
    setFavoriteLabelDraft((current) => ({
      ...current,
      [favoriteType]: HOME_ENTITY_FAVORITE_LABELS[favoriteType],
    }));
  }

  function saveFavoriteLabelDraft() {
    const nextLabels = sanitizeHomeEntityFavoriteLabels(favoriteLabelDraft);
    setHomeEntityFavoriteLabels(nextLabels);
    saveHomeEntityFavoriteLabels(favoriteStorageScope, nextLabels);
    setFavoriteLabelDraft(createFavoriteLabelDraft(nextLabels));
    setFavoriteLabelsEditorOpen(false);
  }

  async function handleToggleHomeEntityFavoriteType(
    entityType: ManagedTab,
    entityId: string,
    favoriteType: ManagedEntityFavoriteType,
  ) {
    const previousFavorites = homeEntityFavorites;
    const result = toggleHomeEntityFavoriteType(
      previousFavorites,
      entityType,
      entityId,
      favoriteType,
    );
    setHomeEntityFavorites(result.favorites);
    saveHomeEntityFavorites(favoriteStorageScope, result.favorites);
    setSavingFavoriteEntityKey(buildFavoriteEntityKey(entityType, entityId));

    try {
      const saved = await updateManagedEntityFavorites(
        api,
        entityType,
        entityId,
        result.favoriteTypes,
      );
      setHomeEntityFavorites((current) => {
        const next = setHomeEntityFavoriteTypes(current, entityType, entityId, saved.favoriteTypes);
        saveHomeEntityFavorites(favoriteStorageScope, next);
        return next;
      });
    } catch {
      setHomeEntityFavorites(previousFavorites);
      saveHomeEntityFavorites(favoriteStorageScope, previousFavorites);
    } finally {
      setSavingFavoriteEntityKey((current) =>
        current === buildFavoriteEntityKey(entityType, entityId) ? null : current,
      );
    }
  }

  function prefetchChannelStats(chatId: string) {
    preloadChannelStatsPage();
    void queryClient
      .prefetchQuery({
        queryKey: queryKeys.channelStats(chatId, DEFAULT_CHANNEL_STATS_RANGE),
        queryFn: async ({ signal }) => {
          const { getChannelStats } = await import('../lib/api/channel-stats-client');
          return getChannelStats(
            api,
            chatId,
            DEFAULT_CHANNEL_STATS_RANGE,
            { signal },
            {
              includeActivityPreview: false,
            },
          );
        },
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    if (filteredEntities.length === 0) {
      return undefined;
    }

    const candidates = filteredEntities.slice(0, 3).map((entity) => entity.id);
    let cancelled = false;
    const run = () => {
      if (cancelled) {
        return;
      }

      for (const entityId of candidates) {
        prefetchEntityActivity(activeTab, entityId);
      }
    };
    const idleWindow = window as unknown as WindowWithIdleCallback;
    const idleHandle = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(run, { timeout: 1_200 })
      : window.setTimeout(run, 450);

    return () => {
      cancelled = true;
      if (idleWindow.cancelIdleCallback && idleWindow.requestIdleCallback) {
        idleWindow.cancelIdleCallback(idleHandle);
      } else {
        window.clearTimeout(idleHandle);
      }
    };
  }, [activeTab, filteredEntities]);

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск чата' : 'Поиск канала';
  const searchPlaceholder = 'Поиск';
  const showSystemCard = canAccessSystem;
  const refreshButtonLabel = isFetching ? 'Обновление уже идет' : 'Обновить';

  function renderEntityCard(entity: ManagedHomeEntity, index: number) {
    const favorite = isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id);
    const favoriteTypes = getHomeEntityFavoriteTypes(homeEntityFavorites, activeTab, entity.id);
    const PrimaryFavoriteIcon =
      favoriteTypes.length > 0 ? HOME_ENTITY_FAVORITE_ICONS[favoriteTypes[0]] : PlusGlyph;
    const favoriteEntitySaving =
      savingFavoriteEntityKey === buildFavoriteEntityKey(activeTab, entity.id);
    const staggerIndex = limitedStagger === null ? index : index < limitedStagger ? index : null;
    const className = cn(
      'chat-card',
      favorite && 'is-favorite',
      favoriteTypes[0] && `is-${favoriteTypes[0]}`,
      staggerIndex !== null && 'stagger-in',
      homeSyncStatus.tone === 'cache' && 'is-from-cache',
      homeSyncStatus.tone === 'warning' && 'is-paused',
    );
    let style: CSSProperties | undefined;
    if (shouldVirtualizeEntities) {
      style = { top: index * CHAT_LIST_VIRTUAL_ROW_HEIGHT };
      if (staggerIndex !== null) {
        style.animationDelay = `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms`;
      }
    } else if (staggerIndex !== null) {
      style = { animationDelay: `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms` };
    }

    const settingsRoute = buildEntitySettingsRoute(activeTab, entity.id);
    const activityRoute = buildEntityActivityRoute(activeTab, entity.id);
    const routeState = buildEntityRouteState(activeTab, entity);
    const activityLabel = 'Статистика';
    const favoriteLabel =
      favoriteTypes.length > 0
        ? `Избранное: ${favoriteTypes
            .map((favoriteType) => favoriteLabels[favoriteType])
            .join(', ')}`
        : 'Добавить в избранное';
    const compactLinkLabel = activeTab === 'channel' ? formatCompactLinkLabel(entity.link) : null;
    const entitySignals = buildEntitySignals(entity, activeTab);

    return (
      <GlassCard as="article" key={entity.id} className={className} style={style}>
        <Link
          to={settingsRoute}
          className="chat-card__primary-link"
          state={routeState}
          onClick={() => rememberEntity(activeTab, entity)}
          onPointerEnter={(event) => {
            if (shouldPrefetchFromPointerEvent(event)) {
              prefetchEntitySettings(activeTab, entity.id);
            }
          }}
          aria-label={`Открыть настройки: ${entity.title}`}
        />

        <div className="chat-card__header">
          <div className="chat-card__identity">
            <EntityAvatar
              title={entity.title}
              entityType={activeTab}
              avatarUrl={entity.avatarUrl ?? null}
              className="chat-card__avatar"
            />
            <div className="chat-card__title-wrap">
              <h3>{entity.title}</h3>
              {compactLinkLabel || entitySignals.length > 0 ? (
                <div className="chat-card__meta">
                  {compactLinkLabel ? (
                    <span className="chat-card__link-label">{compactLinkLabel}</span>
                  ) : null}
                  {entitySignals.map(({ key, value, Icon }) => (
                    <span key={key} className="chat-card__signal">
                      <Icon aria-hidden />
                      {value ? <strong>{value}</strong> : null}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="chat-card__quick-actions">
          <button
            type="button"
            className={cn(
              'chat-card__favorite',
              favorite && 'is-active',
              favoriteTypes[0] && `is-${favoriteTypes[0]}`,
            )}
            onClick={() => setFavoritePicker({ entityType: activeTab, entity })}
            aria-pressed={favorite}
            aria-label={favoriteLabel}
            title={favoriteLabel}
            disabled={favoriteEntitySaving}
          >
            <PrimaryFavoriteIcon aria-hidden />
            {favoriteTypes.length > 1 ? (
              <span className="chat-card__favorite-count">{favoriteTypes.length}</span>
            ) : null}
          </button>

          <Link
            to={activityRoute}
            className="chat-card__action"
            state={routeState}
            onClick={() => {
              rememberEntity(activeTab, entity);
              prefetchEntityActivity(activeTab, entity.id);
            }}
            onPointerEnter={(event) => {
              if (shouldPrefetchFromPointerEvent(event)) {
                prefetchEntityActivity(activeTab, entity.id);
              }
            }}
            onPointerDown={(event) => {
              if (shouldPrefetchFromPressEvent(event)) {
                prefetchEntityActivity(activeTab, entity.id);
              }
            }}
            aria-label={activityLabel}
            title={activityLabel}
          >
            <ActivityGlyph />
          </Link>
        </div>
      </GlassCard>
    );
  }

  function renderFavoritePicker() {
    if (!favoritePicker) {
      return null;
    }

    const selectedTypes = getHomeEntityFavoriteTypes(
      homeEntityFavorites,
      favoritePicker.entityType,
      favoritePicker.entity.id,
    );
    const saving =
      savingFavoriteEntityKey ===
      buildFavoriteEntityKey(favoritePicker.entityType, favoritePicker.entity.id);

    const picker = (
      <div
        className="favorite-picker"
        style={favoritePickerOverlayStyle}
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          className="favorite-picker__backdrop"
          aria-label="Закрыть избранное"
          onClick={() => setFavoritePicker(null)}
        />
        <div className="favorite-picker__panel">
          <div className="favorite-picker__header">
            <div>
              <strong>{favoritePicker.entity.title}</strong>
            </div>
            <button
              type="button"
              className="favorite-picker__close"
              aria-label="Закрыть"
              title="Закрыть"
              onClick={() => setFavoritePicker(null)}
            >
              <XmarkGlyph aria-hidden />
            </button>
          </div>

          <div className="favorite-picker__grid">
            {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              const active = selectedTypes.includes(favoriteType);
              return (
                <button
                  key={favoriteType}
                  type="button"
                  className={cn(
                    'favorite-picker__option',
                    `is-${favoriteType}`,
                    active && 'is-active',
                  )}
                  aria-pressed={active}
                  disabled={saving}
                  onClick={() =>
                    void handleToggleHomeEntityFavoriteType(
                      favoritePicker.entityType,
                      favoritePicker.entity.id,
                      favoriteType,
                    )
                  }
                >
                  <span className="favorite-picker__icon">
                    <FavoriteIcon aria-hidden />
                  </span>
                  <strong>{favoriteLabels[favoriteType]}</strong>
                  {active ? <CheckGlyph aria-hidden className="favorite-picker__check" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );

    if (typeof document === 'undefined') {
      return picker;
    }

    return createPortal(
      picker,
      document.querySelector('.design-preview__device-screen') ?? document.body,
    );
  }

  function renderFavoriteLabelsEditor() {
    if (!favoriteLabelsEditorOpen) {
      return null;
    }

    const draftOverrides = sanitizeHomeEntityFavoriteLabels(favoriteLabelDraft);
    const canSave = JSON.stringify(draftOverrides) !== JSON.stringify(homeEntityFavoriteLabels);

    const editor = (
      <div
        className="favorite-picker favorite-label-editor"
        style={favoritePickerOverlayStyle}
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          className="favorite-picker__backdrop"
          aria-label="Закрыть категории"
          onClick={closeFavoriteLabelsEditor}
        />
        <div className="favorite-picker__panel favorite-label-editor__panel">
          <div className="favorite-picker__header">
            <div>
              <strong>Категории избранного</strong>
            </div>
            <button
              type="button"
              className="favorite-picker__close"
              aria-label="Закрыть"
              title="Закрыть"
              onClick={closeFavoriteLabelsEditor}
            >
              <XmarkGlyph aria-hidden />
            </button>
          </div>

          <div className="favorite-label-editor__list">
            {HOME_ENTITY_FAVORITE_TYPES.map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              const isCustom = Boolean(homeEntityFavoriteLabels[favoriteType]);

              return (
                <label key={favoriteType} className="favorite-label-editor__row">
                  <span className={cn('favorite-label-editor__icon', `is-${favoriteType}`)}>
                    <FavoriteIcon aria-hidden />
                  </span>
                  <input
                    type="text"
                    inputMode="text"
                    value={favoriteLabelDraft[favoriteType]}
                    maxLength={HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH}
                    aria-label={`Название категории: ${HOME_ENTITY_FAVORITE_LABELS[favoriteType]}`}
                    onChange={(event) =>
                      updateFavoriteLabelDraft(favoriteType, event.currentTarget.value)
                    }
                  />
                  <button
                    type="button"
                    className="favorite-label-editor__reset"
                    aria-label="Вернуть стандартное название"
                    title="Вернуть стандартное название"
                    disabled={
                      !isCustom &&
                      favoriteLabelDraft[favoriteType] === HOME_ENTITY_FAVORITE_LABELS[favoriteType]
                    }
                    onClick={() => resetFavoriteLabelDraft(favoriteType)}
                  >
                    <XmarkGlyph aria-hidden />
                  </button>
                </label>
              );
            })}
          </div>

          <div className="favorite-label-editor__actions">
            <button
              type="button"
              className="button button--ghost"
              onClick={closeFavoriteLabelsEditor}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--accent"
              onClick={saveFavoriteLabelDraft}
              disabled={!canSave}
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>
    );

    if (typeof document === 'undefined') {
      return editor;
    }

    return createPortal(
      editor,
      document.querySelector('.design-preview__device-screen') ?? document.body,
    );
  }

  return (
    <div className={cn('page-stack page-enter chats-home', `chats-home--${activeTab}`)}>
      {renderFavoritePicker()}
      {renderFavoriteLabelsEditor()}

      <GlassCard
        className={cn('chats-command', isForegroundSyncing && 'is-syncing')}
        hidden={isLoading}
        padding="sm"
        elevated
      >
        <h1 className="chats-command__sr">{tabLabel}</h1>
        <div className="chats-command__topline">
          <nav className="chats-command__tabs" aria-label="Раздел">
            {(['chat', 'channel'] as const).map((tab) => {
              const count = tabCounts[tab];
              return (
                <Link
                  key={tab}
                  to={buildManagedEntitiesRoute(tab)}
                  className={cn('chats-command__tab', activeTab === tab && 'is-active')}
                  aria-current={activeTab === tab ? 'page' : undefined}
                >
                  <span className="chats-command__tab-label">
                    {tab === 'chat' ? 'Чаты' : 'Каналы'}
                  </span>
                  {count !== null ? (
                    <strong className="chats-command__tab-count">{count}</strong>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <div className="chats-command__meta">
            <span
              className={cn('chats-command__sync-chip', `is-${homeSyncStatus.tone}`)}
              aria-label={`Статус списка: ${homeSyncStatus.label}`}
              title={homeSyncStatus.label}
            >
              <span className="chats-command__sync-dot" aria-hidden />
            </span>
            <button
              type="button"
              className="chats-command__icon-button"
              onClick={() => handleRefresh(activeTab, 'manual')}
              disabled={isFetching || isManualRefreshBlocked}
              aria-label={refreshButtonLabel}
              title={refreshButtonLabel}
            >
              <RefreshGlyph
                aria-hidden
                className={isForegroundSyncing ? 'is-spinning' : undefined}
              />
            </button>
          </div>
        </div>

        {refreshProgressPercent !== null ? (
          <div
            className="chats-command__progress"
            aria-label={`Синхронизация ${refreshProgressPercent}%`}
            style={
              {
                '--chats-sync-progress': `${refreshProgressPercent}%`,
              } as CSSProperties
            }
          />
        ) : null}

        <div className="chats-command__search-row">
          <label className="field field--search chats-command__field" htmlFor="chat-search">
            <span>{searchLabel}</span>
            <div className="chats-command__field-shell">
              <SearchGlyph aria-hidden className="chats-command__search-icon" />
              <input
                id="chat-search"
                type="search"
                inputMode="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
              />
              {hasSearchQuery ? (
                <button
                  type="button"
                  className="chats-command__clear"
                  onClick={() => setQuery('')}
                  aria-label="Очистить поиск"
                  title="Очистить поиск"
                >
                  <XmarkGlyph aria-hidden />
                </button>
              ) : null}
            </div>
          </label>
        </div>

        <div className="favorite-filter-bar">
          <div className="favorite-filter" role="group" aria-label="Фильтр избранного">
            <button
              type="button"
              className={cn(
                'favorite-filter__chip',
                favoriteFilter === FAVORITE_FILTER_ALL && 'is-active',
              )}
              aria-pressed={favoriteFilter === FAVORITE_FILTER_ALL}
              onClick={() => setFavoriteFilter(FAVORITE_FILTER_ALL)}
            >
              Все
            </button>
            {visibleFavoriteFilterTypes.map((favoriteType) => {
              const FavoriteIcon = HOME_ENTITY_FAVORITE_ICONS[favoriteType];
              return (
                <button
                  key={favoriteType}
                  type="button"
                  className={cn(
                    'favorite-filter__chip',
                    `is-${favoriteType}`,
                    favoriteFilter === favoriteType && 'is-active',
                  )}
                  aria-pressed={favoriteFilter === favoriteType}
                  title={HOME_ENTITY_FAVORITE_TITLES[favoriteType]}
                  onClick={() => setFavoriteFilter(favoriteType)}
                >
                  <FavoriteIcon aria-hidden />
                  <span>{favoriteLabels[favoriteType]}</span>
                  <strong>{favoriteCounts[favoriteType]}</strong>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="favorite-filter__settings"
            aria-label="Настроить категории"
            title="Настроить категории"
            onClick={openFavoriteLabelsEditor}
          >
            <SettingsGlyph aria-hidden />
          </button>
        </div>
      </GlassCard>

      {showTransientEmptyState ? (
        <GlassCard className="chats-transient-state">
          <StatusState
            tone="warning"
            title="MAX на паузе"
            description={
              manualRefreshRetryAfterSec
                ? `Повтор через ${manualRefreshRetryAfterSec} сек.`
                : 'Список восстановится автоматически.'
            }
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => handleRefresh(activeTab, 'recovery')}
                disabled={isFetching || isRefreshTemporarilyBlocked}
              >
                Проверить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {isLoading ? (
        <section className="chat-grid" aria-label="Загрузка">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {queryError ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить список"
            description={describeApiError(queryError, 'Не удалось загрузить список.')}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => handleRefresh(activeTab, 'manual')}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {isSyncPending && Array.isArray(activeEntities) && activeEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`Синхронизируем ${tabLabel.toLowerCase()}`}
            description={buildPendingSyncDescription({
              tab: activeTab,
              refreshState,
              hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
            })}
          />
        </GlassCard>
      ) : null}

      {showEmptyState ? (
        <Suspense
          fallback={
            <GlassCard>
              <StatusState
                tone="neutral"
                title={activeTab === 'channel' ? 'Каналы не найдены' : 'Нет доступных чатов'}
                description="Загружаем подсказки по подключению."
              />
            </GlassCard>
          }
        >
          <LazyChatOnboardingSection
            api={api}
            entityType={activeTab}
            isFetching={isFetching}
            isRefreshBlocked={isRefreshTemporarilyBlocked}
            onRefresh={() => handleRefresh(activeTab, 'manual')}
          />
        </Suspense>
      ) : null}

      {!isLoading &&
      !queryError &&
      !showEmptyState &&
      Array.isArray(activeEntities) &&
      activeEntities.length > 0 &&
      filteredEntities.length === 0 ? (
        <GlassCard>
          <StatusState
            tone="neutral"
            title={`${tabLabel} не найдены`}
            description={
              favoriteFilter === FAVORITE_FILTER_ALL
                ? 'Попробуйте изменить поисковый запрос.'
                : 'В этом типе избранного пока нет подходящих элементов.'
            }
          />
        </GlassCard>
      ) : null}

      {!isLoading && !queryError && !showEmptyState && filteredEntities.length > 0 ? (
        <section
          className={cn('chat-grid', shouldVirtualizeEntities && 'chat-grid--virtual')}
          aria-label="Список"
          ref={shouldVirtualizeEntities ? virtualListViewportRef : undefined}
          onScroll={
            shouldVirtualizeEntities
              ? (event) => setVirtualListScrollTop(event.currentTarget.scrollTop)
              : undefined
          }
          tabIndex={shouldVirtualizeEntities ? 0 : undefined}
        >
          {shouldVirtualizeEntities ? (
            <div
              className="chat-grid__virtual-spacer"
              style={{ height: filteredEntities.length * CHAT_LIST_VIRTUAL_ROW_HEIGHT }}
            >
              {renderedEntities.map((entity, index) =>
                renderEntityCard(entity, virtualStartIndex + index),
              )}
            </div>
          ) : (
            filteredEntities.map((entity, index) => renderEntityCard(entity, index))
          )}
        </section>
      ) : null}

      {showSystemCard ? (
        <Suspense fallback={null}>
          <LazySystemEntryCard api={api} />
        </Suspense>
      ) : null}
    </div>
  );
}
