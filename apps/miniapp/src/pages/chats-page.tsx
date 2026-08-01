import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  ChatSummary,
  ManagedEntitiesRefreshState,
  ManagedEntityFavoriteType,
} from '@maxim/contracts';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import {
  FilterGlyph,
  HOME_ENTITY_FAVORITE_ICONS,
  PlusCircleGlyph,
  RefreshGlyph,
  SearchGlyph,
  SettingsGlyph,
  StatisticsGlyph,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import type { ApiTransport } from '../lib/api/transport';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import {
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_TYPES,
  HOME_ENTITY_FAVORITE_LABELS,
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
  buildHomeView,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import { useNativeBackHandler } from '../lib/native-back';
import { channelStatsQueryKey, logsDashboardQueryKey } from '../lib/query-key-builders';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import { readLocalMirrorItem, writeLocalMirrorItem } from '../lib/native-storage';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './page-preloads';
import {
  createHomeRefreshCooldownDeadline,
  getHomeRefreshCooldownRemainingSec,
} from './home-refresh-cooldown';
import './chats-page.css';
import './chats-page-native.css';

type ManagedTab = 'chat' | 'channel';
type HomeSyncTone = 'ready' | 'syncing' | 'error';
type ManagedHomeEntity = ChatSummary;
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
const CHAT_LIST_VIRTUAL_ROW_HEIGHT = 96;
const CHAT_LIST_VIRTUAL_WINDOW_SIZE = 20;
const FAVORITE_FILTER_ALL = 'all';
type FavoriteLabelDraft = Record<ManagedEntityFavoriteType, string>;

function createFavoriteLabelDraft(labels: HomeEntityFavoriteLabelOverrides): FavoriteLabelDraft {
  return resolveHomeEntityFavoriteLabels(labels);
}

function limitFavoriteLabelInput(value: string): string {
  return Array.from(value).slice(0, HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH).join('');
}

const LazyChatOnboardingSection = lazy(async () => {
  const module = await import('../components/chat-onboarding-section');
  return { default: module.ChatOnboardingSection };
});

let homeEntitySheetsPromise: Promise<typeof import('./home-entity-sheets')> | null = null;
function preloadHomeEntitySheets() {
  homeEntitySheetsPromise ??= import('./home-entity-sheets').catch((error: unknown) => {
    homeEntitySheetsPromise = null;
    throw error;
  });
  return homeEntitySheetsPromise;
}
const LazyHomeEntitySheets = lazy(preloadHomeEntitySheets);

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

  if (progress) {
    return `Проверено ${progress}.`;
  }

  return options.hasLoadedFromServer ? `Ищем новые ${entityPlural}.` : `Ищем ваши ${entityPlural}.`;
}

function buildHomeSyncStatus(options: {
  isLoading: boolean;
  isRefreshing: boolean;
  hasError: boolean;
  isBackoffActive: boolean;
  hasLoadedFromServer: boolean;
}): { label: string; tone: HomeSyncTone } {
  if (options.isLoading || options.isRefreshing) {
    return { label: 'Обновляем список', tone: 'syncing' };
  }

  if (options.hasError) {
    return { label: 'Не удалось обновить список', tone: 'error' };
  }

  if (options.isBackoffActive) {
    return { label: 'Обновление продолжится автоматически', tone: 'syncing' };
  }

  if (!options.hasLoadedFromServer) {
    return { label: 'Обновляем список', tone: 'syncing' };
  }

  return { label: 'Список обновлён', tone: 'ready' };
}

async function saveManagedEntityFavoriteTypes(
  api: ApiTransport,
  entityType: ManagedTab,
  entityId: string,
  favoriteTypes: ManagedEntityFavoriteType[],
) {
  const { updateManagedEntityFavorites } =
    await import('../lib/api/managed-entity-favorites-client');
  return updateManagedEntityFavorites(api, entityType, entityId, favoriteTypes);
}

function buildEntitySettingsRoute(entityType: ManagedTab, entityId: string): string {
  return entityType === 'channel' ? `/channel/${entityId}/settings` : `/chat/${entityId}/settings`;
}

function buildEntityStatisticsRoute(entityType: ManagedTab, entityId: string): string {
  return entityType === 'channel'
    ? `/channel/${entityId}/stats?section=overview`
    : `/chat/${entityId}/events?section=activity`;
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

export function ChatsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [currentUserId, setCurrentUserId] = useState<string | null>(() => getInitDataUserId());
  const homeRootRef = useRef<HTMLDivElement | null>(null);
  const virtualListViewportRef = useRef<HTMLElement | null>(null);
  const homeOverlayTriggerRef = useRef<HTMLElement | null>(null);
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
  const [favoriteFilterPickerOpen, setFavoriteFilterPickerOpen] = useState(false);
  const [favoriteLabelsEditorOpen, setFavoriteLabelsEditorOpen] = useState(false);
  const [connectSheetOpen, setConnectSheetOpen] = useState(false);
  const [favoriteLabelDraft, setFavoriteLabelDraft] = useState<FavoriteLabelDraft>(() =>
    createFavoriteLabelDraft(readHomeEntityFavoriteLabels(favoriteStorageScope)),
  );
  const [savingFavoriteEntityKey, setSavingFavoriteEntityKey] = useState<string | null>(null);
  const homeOverlayOpen =
    connectSheetOpen ||
    Boolean(favoritePicker) ||
    favoriteFilterPickerOpen ||
    favoriteLabelsEditorOpen;
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
      if (connectSheetOpen) {
        closeHomeEntitySheet();
      } else if (favoriteLabelsEditorOpen) {
        setFavoriteLabelsEditorOpen(false);
      } else if (favoritePicker) {
        setFavoritePicker(null);
      } else {
        setFavoriteFilterPickerOpen(false);
      }
      return true;
    },
    { enabled: homeOverlayOpen, priority: 650 },
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
  const [manualRefreshClockMs, setManualRefreshClockMs] = useState(() => Date.now());
  const chatsManualRefreshCooldown = useMemo(() => {
    const observedAtMs = Date.now();
    return {
      observedAtMs,
      deadlineAtMs: createHomeRefreshCooldownDeadline(
        chatsState.refreshState?.manualRefreshRetryAfterMs,
        observedAtMs,
      ),
    };
  }, [chatsState.refreshState]);
  const channelsManualRefreshCooldown = useMemo(() => {
    const observedAtMs = Date.now();
    return {
      observedAtMs,
      deadlineAtMs: createHomeRefreshCooldownDeadline(
        channelsState.refreshState?.manualRefreshRetryAfterMs,
        observedAtMs,
      ),
    };
  }, [channelsState.refreshState]);
  const manualRefreshCooldown =
    activeTab === 'chat' ? chatsManualRefreshCooldown : channelsManualRefreshCooldown;
  const manualRefreshRetryAfterSec = getHomeRefreshCooldownRemainingSec(
    manualRefreshCooldown.deadlineAtMs,
    Math.max(manualRefreshClockMs, manualRefreshCooldown.observedAtMs),
  );
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
    isLoading,
    isRefreshing: isFetching || isManualRefreshInProgressByState,
    hasError: Boolean(queryError),
    isBackoffActive: activeEntitiesState.isBackoffActive,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
  });
  const homeSyncAccessibleLabel = `Статус списка: ${homeSyncStatus.label}`;
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
  const hasSearchQuery = query.trim().length > 0;
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

  useEffect(() => {
    const deadlineAtMs = manualRefreshCooldown.deadlineAtMs;
    if (deadlineAtMs === null) {
      return undefined;
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      if (manualRefreshClockMs < deadlineAtMs) {
        setManualRefreshClockMs(Date.now());
      }
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => setManualRefreshClockMs(Date.now()),
      Math.min(1_000, remainingMs),
    );
    return () => window.clearTimeout(timeoutId);
  }, [manualRefreshClockMs, manualRefreshCooldown.deadlineAtMs]);

  useEffect(() => {
    const updateClockWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        setManualRefreshClockMs(Date.now());
      }
    };

    document.addEventListener('visibilitychange', updateClockWhenVisible);
    return () => document.removeEventListener('visibilitychange', updateClockWhenVisible);
  }, []);

  function queueRefresh(tab: ManagedTab, behavior: ManagedEntitiesReloadRequest['behavior']) {
    noteRefreshRequested();
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
      if (isManualRefreshCoolingDown) {
        pushToast({
          tone: 'info',
          title: 'Список уже обновлён',
          description: manualRefreshRetryAfterSec
            ? `Повторить можно через ${manualRefreshRetryAfterSec} с.`
            : undefined,
        });
      } else if (isRefreshTemporarilyBlocked) {
        pushToast({
          tone: 'info',
          title: 'Обновление уже запланировано',
          description: manualRefreshRetryAfterSec
            ? `Повторим автоматически через ${manualRefreshRetryAfterSec} с.`
            : 'Повторим автоматически.',
        });
      }
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
    if (!homeOverlayOpen) {
      return undefined;
    }

    const { body, documentElement } = document;
    const homeRoot = homeRootRef.current;
    const bottomNav = homeRoot
      ?.closest('.app-shell')
      ?.querySelector<HTMLElement>(':scope > .bottom-nav');
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const previousHomeInert = homeRoot?.inert ?? false;
    const previousBottomNavInert = bottomNav?.inert ?? false;

    body.classList.add('favorite-picker-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    if (homeRoot) {
      homeRoot.inert = true;
    }
    if (bottomNav) {
      bottomNav.inert = true;
    }

    return () => {
      body.classList.remove('favorite-picker-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      if (homeRoot) {
        homeRoot.inert = previousHomeInert;
      }
      if (bottomNav) {
        bottomNav.inert = previousBottomNavInert;
      }
      const restoreTarget = homeOverlayTriggerRef.current;
      homeOverlayTriggerRef.current = null;
      if (restoreTarget?.isConnected) {
        window.requestAnimationFrame(() => restoreTarget.focus());
      }
    };
  }, [homeOverlayOpen]);

  useEffect(() => {
    if (!homeOverlayOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (connectSheetOpen) {
        closeHomeEntitySheet();
        return;
      }
      if (favoriteLabelsEditorOpen) {
        setFavoriteLabelDraft(createFavoriteLabelDraft(homeEntityFavoriteLabels));
        setFavoriteLabelsEditorOpen(false);
        return;
      }
      if (favoritePicker) {
        setFavoritePicker(null);
        return;
      }
      setFavoriteFilterPickerOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    connectSheetOpen,
    favoriteLabelsEditorOpen,
    favoritePicker,
    homeEntityFavoriteLabels,
    homeOverlayOpen,
  ]);

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
    if (readLocalMirrorItem(migrationKey) === '1') {
      return;
    }

    const legacy = readLegacyHomeEntityFavorites(favoriteStorageScope);
    const legacyFavorites = createHomeEntityFavoritesFromLegacy(legacy);
    const legacyItems = [
      ...legacyFavorites.chat.important.map((id) => ({ entityType: 'chat' as const, id })),
      ...legacyFavorites.channel.important.map((id) => ({ entityType: 'channel' as const, id })),
    ];
    if (legacyItems.length === 0) {
      writeLocalMirrorItem(migrationKey, '1');
      return;
    }

    const nextFavorites = mergeHomeEntityFavorites(homeEntityFavorites, legacyFavorites);
    setHomeEntityFavorites(nextFavorites);
    saveHomeEntityFavorites(favoriteStorageScope, nextFavorites);
    writeLocalMirrorItem(migrationKey, '1');

    void Promise.allSettled(
      legacyItems.map((item) =>
        saveManagedEntityFavoriteTypes(
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

    void import('../lib/api/me-client')
      .then(({ getMe }) => getMe(api, { signal: controller.signal }))
      .then((me) => {
        if (!controller.signal.aborted) {
          setCurrentUserId(me.userId);
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, [api]);

  useEffect(() => {
    if (showEmptyState) {
      void preloadHomeEntitySheets();
    }
  }, [showEmptyState]);

  function prefetchChatSettings(chatId: string) {
    void chatId;
    preloadSettingsPage();
  }

  function prefetchChatEvents(chatId: string) {
    preloadEventsPage();
    void queryClient
      .prefetchQuery({
        queryKey: logsDashboardQueryKey(chatId, DEFAULT_DASHBOARD_RANGE, true, false),
        queryFn: async ({ signal }) => {
          const { getChatActivityDashboard } = await import('../lib/api/events-client');
          return getChatActivityDashboard(api, chatId, DEFAULT_DASHBOARD_RANGE, { signal });
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

  function openFavoriteLabelsEditor(trigger?: HTMLElement) {
    if (trigger) {
      homeOverlayTriggerRef.current = trigger;
    }
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setFavoriteLabelDraft(createFavoriteLabelDraft(homeEntityFavoriteLabels));
    setFavoriteLabelsEditorOpen(true);
  }

  function openFavoriteFilterPicker(trigger: HTMLElement) {
    homeOverlayTriggerRef.current = trigger;
    setFavoriteLabelsEditorOpen(false);
    setFavoritePicker(null);
    setFavoriteFilterPickerOpen(true);
  }

  function closeHomeEntitySheet() {
    if (favoriteLabelsEditorOpen) {
      setFavoriteLabelDraft(createFavoriteLabelDraft(homeEntityFavoriteLabels));
    }
    setFavoriteLabelsEditorOpen(false);
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setConnectSheetOpen(false);
  }

  async function openConnectSheet(trigger: HTMLElement) {
    homeOverlayTriggerRef.current = trigger;
    try {
      await preloadHomeEntitySheets();
    } catch {
      pushToast({
        title: 'Не удалось открыть подключение',
        description: 'Попробуйте ещё раз.',
        tone: 'danger',
      });
      return;
    }
    if (!trigger.isConnected) {
      return;
    }
    setFavoriteLabelsEditorOpen(false);
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setConnectSheetOpen(true);
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
      const saved = await saveManagedEntityFavoriteTypes(
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
    } catch (error: unknown) {
      setHomeEntityFavorites(previousFavorites);
      saveHomeEntityFavorites(favoriteStorageScope, previousFavorites);
      pushToast({
        title: 'Не удалось сохранить категорию',
        description: describeApiError(error, 'Попробуйте ещё раз.'),
        tone: 'danger',
      });
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
        queryKey: channelStatsQueryKey(chatId, DEFAULT_CHANNEL_STATS_RANGE),
        queryFn: async ({ signal }) => {
          const { getChannelStats } = await import('../lib/api/channel-stats-client');
          return getChannelStats(
            api,
            chatId,
            DEFAULT_CHANNEL_STATS_RANGE,
            { signal },
            {
              includeActivityPreview: false,
              mode: 'overview',
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

      void preloadHomeEntitySheets();
      for (const entityId of candidates) {
        prefetchEntitySettings(activeTab, entityId);
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
  const refreshButtonLabel =
    isFetching || isManualRefreshInProgressByState
      ? 'Обновляем список'
      : homeSyncStatus.tone === 'error'
        ? 'Повторить обновление списка'
        : 'Обновить список';
  const activeFavoriteFilterLabel =
    favoriteFilter === FAVORITE_FILTER_ALL ? null : favoriteLabels[favoriteFilter];
  const favoriteFilterButtonLabel = activeFavoriteFilterLabel
    ? `Фильтр: ${activeFavoriteFilterLabel}`
    : 'Фильтр категорий';
  const FavoriteFilterIcon =
    favoriteFilter === FAVORITE_FILTER_ALL
      ? FilterGlyph
      : HOME_ENTITY_FAVORITE_ICONS[favoriteFilter];
  const homeResultStatus = queryError
    ? ''
    : isLoading
      ? `Загружаем ${tabLabel.toLowerCase()}.`
      : `${tabLabel}: ${filteredEntities.length} из ${activeEntities?.length ?? 0}.`;

  function renderEntityCard(entity: ManagedHomeEntity, index: number) {
    const favorite = isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id);
    const favoriteTypes = getHomeEntityFavoriteTypes(homeEntityFavorites, activeTab, entity.id);
    const staggerIndex = limitedStagger === null ? index : index < limitedStagger ? index : null;
    const className = cn(
      'chat-card',
      favorite && 'is-favorite',
      favoriteTypes[0] && `is-${favoriteTypes[0]}`,
      staggerIndex !== null && 'stagger-in',
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
    const statisticsRoute = buildEntityStatisticsRoute(activeTab, entity.id);
    const routeState = buildEntityRouteState(activeTab, entity);
    const primaryFavoriteType = favoriteTypes[0] ?? null;
    const CategoryIcon = primaryFavoriteType
      ? HOME_ENTITY_FAVORITE_ICONS[primaryFavoriteType]
      : PlusCircleGlyph;
    const categoryLabel = primaryFavoriteType ? favoriteLabels[primaryFavoriteType] : 'Категория';
    const additionalFavoriteCount = Math.max(0, favoriteTypes.length - 1);

    return (
      <GlassCard
        as="article"
        key={entity.id}
        className={className}
        style={style}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={filteredEntities.length}
      >
        <div className="chat-card__main">
          <EntityAvatar
            title={entity.title}
            entityType={activeTab}
            avatarUrl={entity.avatarUrl ?? null}
            className="chat-card__avatar"
          />
          <div className="chat-card__title-wrap">
            <Link
              to={settingsRoute}
              className="chat-card__title-link"
              state={routeState}
              onClick={() => {
                rememberEntity(activeTab, entity);
                prefetchEntitySettings(activeTab, entity.id);
              }}
              onPointerEnter={(event) => {
                if (shouldPrefetchFromPointerEvent(event)) {
                  prefetchEntitySettings(activeTab, entity.id);
                }
              }}
              onPointerDown={(event) => {
                if (shouldPrefetchFromPressEvent(event)) {
                  prefetchEntitySettings(activeTab, entity.id);
                }
              }}
              aria-label={`Открыть настройки: ${entity.title}`}
            >
              <h3>{entity.title}</h3>
            </Link>
            <button
              type="button"
              className={cn(
                'chat-card__category',
                primaryFavoriteType && `is-${primaryFavoriteType}`,
                favoriteTypes.length > 0 && 'is-active',
              )}
              aria-label={`${favoriteTypes.length > 0 ? 'Изменить' : 'Добавить'} категории: ${entity.title}`}
              aria-haspopup="dialog"
              aria-controls="home-sheet-favorite"
              aria-expanded={
                favoritePicker?.entityType === activeTab && favoritePicker.entity.id === entity.id
              }
              title={favoriteTypes.length > 0 ? 'Изменить категории' : 'Добавить категорию'}
              onPointerEnter={() => void preloadHomeEntitySheets()}
              onPointerDown={() => void preloadHomeEntitySheets()}
              onClick={(event) => {
                homeOverlayTriggerRef.current = event.currentTarget;
                setFavoritePicker({ entityType: activeTab, entity });
              }}
            >
              <CategoryIcon aria-hidden focusable="false" />
              <span>{categoryLabel}</span>
              {additionalFavoriteCount > 0 ? <strong>+{additionalFavoriteCount}</strong> : null}
            </button>
          </div>
        </div>

        <div
          className="chat-card__quick-actions"
          role="group"
          aria-label={`Действия: ${entity.title}`}
        >
          <Link
            to={statisticsRoute}
            className="chat-card__action chat-card__action--statistics"
            state={routeState}
            aria-label={`Открыть статистику: ${entity.title}`}
            title="Статистика"
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
          >
            <StatisticsGlyph aria-hidden focusable="false" />
          </Link>
          <Link
            to={settingsRoute}
            className="chat-card__action chat-card__action--settings"
            state={routeState}
            aria-label={`Открыть настройки: ${entity.title}`}
            title="Настройки"
            onClick={() => {
              rememberEntity(activeTab, entity);
              prefetchEntitySettings(activeTab, entity.id);
            }}
            onPointerEnter={(event) => {
              if (shouldPrefetchFromPointerEvent(event)) {
                prefetchEntitySettings(activeTab, entity.id);
              }
            }}
            onPointerDown={(event) => {
              if (shouldPrefetchFromPressEvent(event)) {
                prefetchEntitySettings(activeTab, entity.id);
              }
            }}
          >
            <SettingsGlyph aria-hidden focusable="false" />
          </Link>
        </div>
      </GlassCard>
    );
  }

  const selectedSheetFavoriteTypes = favoritePicker
    ? getHomeEntityFavoriteTypes(
        homeEntityFavorites,
        favoritePicker.entityType,
        favoritePicker.entity.id,
      )
    : [];
  const sheetFavoriteSaving = favoritePicker
    ? savingFavoriteEntityKey ===
      buildFavoriteEntityKey(favoritePicker.entityType, favoritePicker.entity.id)
    : false;
  const canSaveFavoriteLabels =
    JSON.stringify(sanitizeHomeEntityFavoriteLabels(favoriteLabelDraft)) !==
    JSON.stringify(homeEntityFavoriteLabels);

  return (
    <div
      ref={homeRootRef}
      className={cn('page-stack page-enter chats-home', `chats-home--${activeTab}`)}
    >
      {homeOverlayOpen ? (
        <Suspense fallback={null}>
          <LazyHomeEntitySheets
            api={api}
            connectOpen={connectSheetOpen}
            favoriteTarget={favoritePicker}
            filterPickerOpen={favoriteFilterPickerOpen}
            filterValue={favoriteFilter}
            labelsEditorOpen={favoriteLabelsEditorOpen}
            favoriteLabels={favoriteLabels}
            favoriteCounts={favoriteCounts}
            favoriteLabelOverrides={homeEntityFavoriteLabels}
            favoriteLabelDraft={favoriteLabelDraft}
            selectedFavoriteTypes={selectedSheetFavoriteTypes}
            favoriteSaving={sheetFavoriteSaving}
            canSaveLabels={canSaveFavoriteLabels}
            onClose={closeHomeEntitySheet}
            onFilterChange={(nextFilter) => {
              setFavoriteFilter(nextFilter);
              setFavoriteFilterPickerOpen(false);
            }}
            onOpenLabelsEditor={() => openFavoriteLabelsEditor()}
            onToggleFavorite={(favoriteType) => {
              if (favoritePicker) {
                void handleToggleHomeEntityFavoriteType(
                  favoritePicker.entityType,
                  favoritePicker.entity.id,
                  favoriteType,
                );
              }
            }}
            onFavoriteLabelChange={updateFavoriteLabelDraft}
            onFavoriteLabelReset={resetFavoriteLabelDraft}
            onFavoriteLabelsSave={saveFavoriteLabelDraft}
          />
        </Suspense>
      ) : null}

      <GlassCard
        className={cn('chats-command', isForegroundSyncing && 'is-syncing')}
        padding="sm"
        elevated
      >
        <h1 className="chats-command__sr">{tabLabel}</h1>
        <output className="chats-command__sr" aria-live="polite" aria-atomic="true">
          {homeResultStatus}
        </output>

        {refreshProgressPercent !== null ? (
          <div
            className="chats-command__progress"
            aria-label={`Обновляем список: ${refreshProgressPercent}%`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={refreshProgressPercent}
            style={
              {
                '--chats-sync-progress': `${refreshProgressPercent}%`,
              } as CSSProperties
            }
          >
            <span className="chats-command__sr">Обновлено {refreshProgressPercent}%</span>
          </div>
        ) : null}

        <div className="chats-command__tools">
          <span className="chats-command__sr" role="status" aria-live="polite" aria-atomic="true">
            {homeSyncAccessibleLabel}
          </span>
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
          <button
            type="button"
            className="chats-command__connect"
            aria-label="Подключить чат или канал"
            aria-haspopup="dialog"
            aria-controls="home-sheet-connect"
            aria-expanded={connectSheetOpen}
            onPointerEnter={() => void preloadHomeEntitySheets()}
            onPointerDown={() => void preloadHomeEntitySheets()}
            onFocus={() => void preloadHomeEntitySheets()}
            onClick={(event) => void openConnectSheet(event.currentTarget)}
          >
            <PlusCircleGlyph aria-hidden focusable="false" />
            <span>Подключить</span>
          </button>
          <button
            type="button"
            className={cn(
              'favorite-filter__trigger',
              favoriteFilter !== FAVORITE_FILTER_ALL && 'is-active',
              favoriteFilter !== FAVORITE_FILTER_ALL && `is-${favoriteFilter}`,
            )}
            aria-label={favoriteFilterButtonLabel}
            aria-haspopup="dialog"
            aria-controls="home-sheet-filter"
            aria-expanded={favoriteFilterPickerOpen}
            title={favoriteFilterButtonLabel}
            onPointerEnter={() => void preloadHomeEntitySheets()}
            onPointerDown={() => void preloadHomeEntitySheets()}
            onClick={(event) => openFavoriteFilterPicker(event.currentTarget)}
          >
            <FavoriteFilterIcon aria-hidden focusable="false" />
          </button>
          <button
            type="button"
            className={cn(
              'chats-command__icon-button',
              'chats-command__refresh',
              `is-${homeSyncStatus.tone}`,
            )}
            onClick={() => handleRefresh(activeTab, 'manual')}
            disabled={isFetching || isManualRefreshInProgressByState}
            aria-label={refreshButtonLabel}
            title={refreshButtonLabel}
          >
            {homeSyncStatus.tone === 'syncing' ? (
              <span className="chats-command__sync-ring" aria-hidden />
            ) : homeSyncStatus.tone === 'error' ? (
              <XmarkGlyph aria-hidden />
            ) : (
              <RefreshGlyph aria-hidden />
            )}
          </button>
        </div>
      </GlassCard>

      {showTransientEmptyState ? (
        <GlassCard className="chats-transient-state">
          <StatusState
            tone="warning"
            title="Пока не удалось обновить список"
            description={
              manualRefreshRetryAfterSec
                ? `Повторим автоматически через ${manualRefreshRetryAfterSec} с.`
                : 'Повторим автоматически.'
            }
          />
        </GlassCard>
      ) : null}

      {isLoading ? (
        <section className="chat-grid" aria-label="Загрузка" role="status" aria-busy="true">
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card">
              <SkeletonCard lines={3} />
            </GlassCard>
          ))}
        </section>
      ) : null}

      {queryError ? (
        <GlassCard role="alert" aria-live="assertive">
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
            title={`Ищем ${tabLabel.toLowerCase()}`}
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
              <div role="status" aria-label="Загрузка подключения" aria-busy="true">
                <SkeletonCard lines={2} />
              </div>
            </GlassCard>
          }
        >
          <LazyChatOnboardingSection
            entityType={activeTab}
            isFetching={isFetching}
            isRefreshBlocked={isManualRefreshBlocked}
            onConnect={(trigger) => void openConnectSheet(trigger)}
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
          role="list"
          aria-label={`${tabLabel}: ${filteredEntities.length}`}
          aria-busy={isForegroundSyncing || undefined}
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
    </div>
  );
}
