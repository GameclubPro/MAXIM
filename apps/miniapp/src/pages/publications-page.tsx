import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_PUBLICATION_TARGETS,
  MAX_PUBLICATION_VIDEO_BASE64_LENGTH,
  type ListLegacyPublicationsQuery,
  type PublicationDetails,
  type PublicationOccurrenceSummary,
  type PublicationSummary,
} from '@maxim/contracts/publication';
import type { MiniappProfile, PublisherPostImportOmission } from '@maxim/contracts/publisher';
import { FilterList, NavArrowLeft, Plus, Refresh, Search, Trash, Xmark } from 'iconoir-react';
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  BroadcastPublishBar,
  type BroadcastPublishIssueAction,
} from '../components/broadcast-publish-bar';
import { BroadcastPublishReviewSheet } from '../components/broadcast-publish-review-sheet';
import { MaxMarkdownPreview } from '../components/max-markdown-preview';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { StatusState } from '../components/ui/status-state';
import { TimeField } from '../components/ui/time-field';
import { useToast } from '../components/ui/toast';
import { PublicationHubHeader } from '../features/publications/publication-hub-header';
import {
  formatDateInput,
  formatDraftTiming,
  formatLoadedCount,
  formatPublicationSchedule,
  formatPublicationTargets,
  formatTargetSummary,
  getLifecycleTone,
  getRecurrenceError,
} from '../features/publications/publication-page-formatters';
import {
  LEGACY_PUBLICATION_KIND_FILTERS as LEGACY_KIND_FILTERS,
  LEGACY_PUBLICATION_VIEW_OPTIONS as LEGACY_VIEW_OPTIONS,
  PUBLICATION_ENTITY_FILTERS as ENTITY_FILTERS,
  PUBLICATION_STATUS_FILTERS as STATUS_FILTERS_BY_VIEW,
  PUBLICATION_VIEW_OPTIONS as VIEW_OPTIONS,
  PUBLICATION_WEEKDAYS as WEEKDAYS,
  stripPublisherOnlyPublicationRouteParams,
} from '../features/publications/publication-page-options';
import { PublicationFeedCard } from '../features/publications/publication-feed-card';
import { PublicationCreateSheet } from '../features/publications/publication-create-sheet';
import { PublicationButtonsSheet } from '../features/publications/publication-buttons-sheet';
import { PublicationRecurrenceIntervalField } from '../features/publications/publication-recurrence-interval-field';
import {
  buildCreatePublicationRequest,
  buildPublicationSaveFeedback,
  buildPublicationSystemButtons,
  buildTestPublicationRequest,
  buildUpdatePublicationRequest,
  createEmptyPublicationDraft,
  createPublicationDuplicateDraft,
  createPublicationDraftFromDetails,
  getPublicationActionCapabilities,
  getPublicationActionableDelivery,
  getPublicationEditActionLabel,
  getPublicationExplicitSlotsLimitFeedback,
  getPublicationFeedStatusLabel,
  getPublicationListPollingInterval,
  getPublicationPrimaryActionLabel,
  getPublicationTargetKey,
  hasSamePublicationTargetMetadata,
  hasPublicationDraftChanges,
  hasFuturePublicationSlot,
  inferPublicationVideoMimeType,
  isIsolatedPublicationEditor,
  isPublicationOccurrenceContentStale,
  isPublicationRevisionConflictError,
  normalizePublicationEntityFilter,
  normalizePublicationQuery,
  normalizePublicationStatusFilter,
  normalizePublicationView,
  PUBLICATION_TEXT_MAX_LENGTH,
  publicationDraftNeedsVideoReselection,
  rebasePublicationDraft,
  shouldReviewPublicationScheduleConflict,
  shouldPersistPublicationDraft,
  type PublicationDraft,
  type PublicationEditorContext,
  type PublicationEditScope,
  type PublicationEntityFilter,
  type PublicationStatusFilter,
  type PublicationTimingMode,
  type PublicationView,
} from '../features/publications/publication-model';
import {
  LegacyPublicationsEntry,
  LegacyPublicationsList,
} from '../features/publications/legacy-publications-panel';
import {
  mergeLegacyPublicationPages,
  mergePublicationPages,
} from '../features/publications/publication-pagination';
import {
  PUBLICATION_TEST_RESULT_PENDING_FEEDBACK,
  isPublicationTestResultPendingError,
} from '../features/publications/publication-request-identity';
import { PublicationRetrySheet } from '../features/publications/publication-retry-sheet';
import { PublisherPostImportStatus } from '../features/publications/publisher-post-import-status';
import { PublicationTargetNotices } from '../features/publications/publication-target-notices';
import { PublicationTargetPicker } from '../features/publications/publication-target-picker';
import * as publicationTargetRecheck from '../features/publications/publication-target-recheck';
import { usePublicationEditorAutofocus } from '../features/publications/use-publication-editor-autofocus';
import { useInitialPublicationTargetRoute } from '../features/publications/use-initial-publication-target-route';
import { usePublicationComposer } from '../features/publications/use-publication-composer';
import { usePublicationRequestIds } from '../features/publications/use-publication-request-ids';
import { usePublicationTargetSources } from '../features/publications/use-publication-target-sources';
import {
  hasUnavailablePublisherDraftTargets,
  usePublisherDraftTargetHydration,
} from '../features/publications/use-publisher-draft-target-hydration';
import { usePublisherTargetErrorFeedback } from '../features/publications/use-publisher-target-error-feedback';
import { usePublisherPostImportAssetPreviews } from '../features/publications/use-publisher-post-import-asset-previews';
import { usePublisherPostImportController } from '../features/publications/use-publisher-post-import-controller';
import { isPublisherDraftRouteId } from '../features/publications/publisher-post-import-route';
import {
  createPublication,
  cancelPublication,
  getPublicationCalendarAvailability,
  getPublication,
  listLegacyPublications,
  listPublications,
  pausePublication,
  resumePublication,
  retryPublicationOccurrence,
  resolvePublicationAmbiguousDelivery,
  testPublication,
  updatePublication,
} from '../lib/api/publication-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
} from '../lib/broadcast-link-buttons';
import { readBlobAsBase64 } from '../lib/broadcast-image';
import { parseLocalDateTimeInputValue } from '../lib/broadcast-schedule';
import { addDays, getBroadcastPlannerWindow, startOfDay } from '../lib/broadcast-planner-time';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import { maxImpact, maxNotify } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import { describeUserFacingError } from '../lib/user-facing-error';
import '../styles/publications-page.css';
import '../features/publications/publication-draft-resume.css';
import '../features/publications/publication-workbench.css';

const LazyPublicationDetailsSheet = lazy(() =>
  import('../features/publications/publication-details-sheet').then((module) => ({
    default: module.PublicationDetailsSheet,
  })),
);
const LazyPublicationContentEditorSection = lazy(() =>
  import('../features/publications/publication-content-editor-section').then((module) => ({
    default: module.PublicationContentEditorSection,
  })),
);
const LazyBroadcastSchedulePlanner = lazy(() =>
  import('../components/broadcast-schedule-planner').then((module) => ({
    default: module.BroadcastSchedulePlanner,
  })),
);

type PublicationActionTarget = {
  publication: PublicationSummary;
  action: 'cancel' | 'pause' | 'resume';
};

type PublicationAmbiguousTarget = {
  publicationId: string;
  occurrenceId: string;
  deliveryId: string;
  resolution: 'mark_sent' | 'mark_failed';
};

type PublicationRetryTarget =
  | {
      publicationId: string;
      occurrenceId: string;
      contentMode: 'original';
    }
  | {
      publicationId: string;
      occurrenceId: string;
      contentMode: 'latest';
      expectedPublicationVersion: number;
      expectedContentRevision: number;
    };

type PublicationRetryChoiceTarget = {
  publicationId: string;
  occurrenceId: string;
  publicationVersion: number;
  originalContentRevision?: number;
  latestContentRevision: number;
};

type LegacyPublicationView = ListLegacyPublicationsQuery['view'];
type LegacyPublicationKindFilter = ListLegacyPublicationsQuery['kind'];

function getPublicationCalendarRange(now = new Date()): { from: string; to: string } {
  const { start, end } = getBroadcastPlannerWindow(now);
  return { from: start.toISOString(), to: end.toISOString() };
}

const queryKeys = {
  listRoot: ['publications', 'list'] as const,
  list: (
    view: PublicationView,
    query: string,
    entityFilter: PublicationEntityFilter,
    statusFilter: PublicationStatusFilter,
  ) => ['publications', 'list', view, query, entityFilter, statusFilter] as const,
  legacyProbe: (view: LegacyPublicationView) => ['publications', 'legacy', 'probe', view] as const,
  legacyList: (
    view: LegacyPublicationView,
    query: string,
    kind: LegacyPublicationKindFilter,
    entityFilter: PublicationEntityFilter,
  ) => ['publications', 'legacy', 'list', view, query, kind, entityFilter] as const,
  calendar: (targetsKey: string, excludePublicationId: string | null, from: string, to: string) =>
    ['publications', 'calendar', targetsKey, excludePublicationId, from, to] as const,
};

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

const MAX_PUBLICATION_VIDEO_FILE_BYTES = 24_000_000;

export function PublicationsPage({
  api,
  profile = 'moderation',
  userId,
}: {
  api: ApiTransport;
  profile?: MiniappProfile;
  userId: string;
}) {
  const isPublisherProfile = profile === 'publisher';
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const requestIds = usePublicationRequestIds();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorContext, setEditorContext] = useState<PublicationEditorContext | null>(null);
  const [mediaPreparing, setMediaPreparing] = useState(false);
  const [editorClosePending, setEditorClosePending] = useState(false);
  const isEditor = isPublisherProfile && editorContext !== null;
  const isEditorKeyboardOpen = useKeyboardOpen(96, isEditor);
  const legacyRouteRequested = searchParams.get('legacy') === '1';
  const isLegacyView = !isPublisherProfile && legacyRouteRequested && !isEditor;
  const persistenceEnabled = shouldPersistPublicationDraft(editorContext?.kind ?? null);
  const {
    draft,
    setDraft,
    hydrated,
    hasSavedDraft,
    imagesNeedReselection,
    missingImageCount,
    replaceDraft,
    clearDraft,
    discardMissingImages,
    resolveMissingImages,
    flushDraft,
  } = usePublicationComposer(
    isEditor,
    persistenceEnabled,
    isPublisherProfile,
    mediaPreparing,
    userId,
  );
  const savedCreateDraftRef = useRef<{
    draft: PublicationDraft;
    missingImageCount: number;
  } | null>(null);
  const isolatedDraftBaselineRef = useRef<PublicationDraft | null>(null);
  const initialComposeRouteAppliedRef = useRef(false);
  const editorReturnFocusRef = useRef<HTMLElement | null>(null);
  const editorReturnPublicationIdRef = useRef<string | null>(null);
  const editorTitleRef = useRef<HTMLHeadingElement | null>(null);
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
  const [buttonsOpen, setButtonsOpen] = useState(false);
  const [previewTargetKey, setPreviewTargetKey] = useState<string | null>(null);
  const [importOmissions, setImportOmissions] = useState<PublisherPostImportOmission[]>([]);
  const [fieldError, setFieldError] = useState('');
  const [validationStarted, setValidationStarted] = useState(false);
  const [videoPreparing, setVideoPreparing] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);
  const [pendingConflict, setPendingConflict] = useState(false);
  const [pendingEditorClose, setPendingEditorClose] = useState(false);
  const [pendingDraftClear, setPendingDraftClear] = useState(false);
  const [revisionConflictPublicationId, setRevisionConflictPublicationId] = useState<string | null>(
    null,
  );
  const [actionTarget, setActionTarget] = useState<PublicationActionTarget | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<PublicationSummary | null>(null);
  const [ambiguousTarget, setAmbiguousTarget] = useState<PublicationAmbiguousTarget | null>(null);
  const [retryChoiceTarget, setRetryChoiceTarget] = useState<PublicationRetryChoiceTarget | null>(
    null,
  );
  const contentSectionRef = useRef<HTMLElement | null>(null);
  const targetsSectionRef = useRef<HTMLElement | null>(null);
  const timingSectionRef = useRef<HTMLElement | null>(null);

  const targetSources = usePublicationTargetSources(api, isPublisherProfile);
  const scopedTargetRecheck = publicationTargetRecheck.usePublicationTargetRecheck(api);
  const importedAssetPreviews = usePublisherPostImportAssetPreviews(
    api,
    editorContext?.kind === 'import' ? editorContext.sessionId : null,
    draft.retainedAssets,
  );
  const {
    targets,
    loading: sourcesLoading,
    fetching: sourcesFetching,
    hasError: sourcesHaveError,
    unavailable: sourcesUnavailable,
    ready: sourcesReady,
  } = targetSources;
  const initialTargetRoute = useInitialPublicationTargetRoute({
    api,
    hydrated,
    publisherProfile: isPublisherProfile,
    searchParams,
    targets,
    sourcesReady,
    setDraft,
  });
  const publisherDraftHydration = usePublisherDraftTargetHydration({
    api,
    enabled: isPublisherProfile && hydrated && isEditor,
    targets: draft.targets,
    setDraft,
  });
  usePublisherTargetErrorFeedback({
    draftHydrationError: publisherDraftHydration.error,
    draftHydrationFailed: publisherDraftHydration.isError,
  });
  const [calendarRange, setCalendarRange] = useState(() => getPublicationCalendarRange());
  const calendarTargetsKey = useMemo(
    () =>
      draft.targets
        .map((target) => getPublicationTargetKey(target))
        .sort((left, right) => left.localeCompare(right))
        .join(','),
    [draft.targets],
  );
  const calendarExcludePublicationId =
    editorContext?.kind === 'edit' || editorContext?.kind === 'import'
      ? editorContext.publicationId
      : null;
  const calendarAvailabilityQuery = useQuery({
    queryKey: queryKeys.calendar(
      calendarTargetsKey,
      calendarExcludePublicationId,
      calendarRange.from,
      calendarRange.to,
    ),
    queryFn: () =>
      getPublicationCalendarAvailability(api, {
        audience: {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: draft.targets.map((target) => ({
            chatId: target.id,
            entityType: target.entityType,
          })),
        },
        from: calendarRange.from,
        to: calendarRange.to,
        ...(calendarExcludePublicationId
          ? { excludePublicationId: calendarExcludePublicationId }
          : {}),
      }),
    enabled: isEditor && draft.timingMode === 'schedule' && draft.targets.length > 0,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
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
  useEffect(() => {
    if (!isEditor) {
      return undefined;
    }

    let timeoutId: number | undefined;
    const refreshCalendarRange = () => {
      const nextRange = getPublicationCalendarRange();
      setCalendarRange((currentRange) =>
        currentRange.from === nextRange.from && currentRange.to === nextRange.to
          ? currentRange
          : nextRange,
      );
    };
    const scheduleNextRefresh = () => {
      refreshCalendarRange();
      const now = new Date();
      const nextDay = startOfDay(addDays(now, 1));
      timeoutId = window.setTimeout(
        scheduleNextRefresh,
        Math.max(1_000, nextDay.getTime() - now.getTime() + 1_000),
      );
    };
    const handleWindowFocus = () => refreshCalendarRange();

    scheduleNextRefresh();
    window.addEventListener('focus', handleWindowFocus);
    return () => {
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener('focus', handleWindowFocus);
    };
  }, [isEditor]);
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

  const saveMutation = useMutation({
    mutationFn: ({ replaceConflicts }: { replaceConflicts: boolean }) => {
      const requestId = requestIds.resolveSaveRequestId(
        draft,
        editorContext ?? { kind: 'create' },
        replaceConflicts,
      );
      if (editorContext?.kind === 'edit' || editorContext?.kind === 'import') {
        return updatePublication(
          api,
          editorContext.publicationId,
          buildUpdatePublicationRequest(
            draft,
            editorContext.expectedRevision,
            requestId,
            replaceConflicts,
          ),
        );
      }
      return createPublication(
        api,
        buildCreatePublicationRequest(draft, requestId, { replaceConflicts }),
      );
    },
    onSuccess: async (publication) => {
      requestIds.confirmSaveSuccess();
      if (editorContext?.kind === 'import') {
        await postImport.finishPublishedImport();
      }
      await invalidatePublicationQueries();
      const feedback = buildPublicationSaveFeedback(publication, {
        editScope:
          editorContext?.kind === 'edit' ? (draft.timingMode === 'now' ? 'retry' : 'future') : null,
        editorKind: editorContext?.kind ?? null,
        timingMode: draft.timingMode,
      });
      pushToast(feedback);
      maxNotify(feedback.notification);
      if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
        restoreCreateDraftAndClose();
      } else {
        await clearDraft();
        closeEditor(false);
      }
    },
    onError: (error, variables) => {
      if (shouldReviewPublicationScheduleConflict(error, draft, variables.replaceConflicts)) {
        setPendingConflict(true);
        return;
      }
      if (
        (editorContext?.kind === 'edit' || editorContext?.kind === 'import') &&
        isPublicationRevisionConflictError(error)
      ) {
        setRevisionConflictPublicationId(editorContext.publicationId);
        void invalidatePublicationQueries();
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить публикацию'),
      });
      maxNotify('error');
    },
  });
  const testMutation = useMutation({
    mutationFn: () =>
      testPublication(
        api,
        buildTestPublicationRequest(draft, requestIds.resolveTestRequestId(draft)),
      ),
    onSuccess: () => {
      requestIds.confirmTestSuccess();
      pushToast({ tone: 'success', title: 'Отправлено вам' });
      maxNotify('success');
    },
    onError: (error) => {
      if (isPublicationTestResultPendingError(error)) {
        pushToast(PUBLICATION_TEST_RESULT_PENDING_FEEDBACK);
        maxNotify('warning');
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось отправить тест'),
      });
      maxNotify('error');
    },
  });
  const openPublicationMutation = useMutation({
    mutationFn: ({
      publicationId,
      mode,
      sessionId,
      omissions,
    }: {
      publicationId: string;
      mode: 'edit' | 'duplicate' | 'import';
      sessionId?: string | null;
      omissions?: PublisherPostImportOmission[];
    }) =>
      getPublication(api, publicationId).then((details) => {
        if (mode === 'import' && details.lifecycle !== 'DRAFT') {
          throw new Error('Этот черновик уже опубликован');
        }
        return { details, mode, sessionId: sessionId ?? null, omissions: omissions ?? [] };
      }),
    onSuccess: ({ details, mode, sessionId, omissions }) => {
      savedCreateDraftRef.current = { draft, missingImageCount };
      const sourceDraft = createPublicationDraftFromDetails(details);
      const isolatedDraft =
        mode === 'duplicate' ? createPublicationDuplicateDraft(sourceDraft) : sourceDraft;
      isolatedDraftBaselineRef.current = isolatedDraft;
      replaceDraft(isolatedDraft);
      setEditorContext(
        mode === 'edit'
          ? { kind: 'edit', publicationId: details.id, expectedRevision: details.version }
          : mode === 'import'
            ? {
                kind: 'import',
                publicationId: details.id,
                expectedRevision: details.version,
                sessionId,
              }
            : { kind: 'duplicate' },
      );
      setImportOmissions(mode === 'import' ? omissions : []);
      setDetailsTarget(null);
      setPendingEditorClose(false);
      setFieldError('');
      setValidationStarted(false);
      setComposeRoute(true, {
        importDraftId: mode === 'import' ? details.id : null,
      });
    },
    onError: (error, variables) => {
      if (variables.mode === 'import') {
        postImport.dismissStaleImport();
      }
      editorReturnFocusRef.current = null;
      editorReturnPublicationIdRef.current = null;
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось открыть публикацию'),
      });
    },
  });
  const postImport = usePublisherPostImportController({
    api,
    enabled: isPublisherProfile,
    editorOpen: isEditor,
    hydrated,
    openingDraft: openPublicationMutation.isPending,
    searchParams,
    setSearchParams,
    onOpenDraft: openImportedDraft,
  });
  const refreshEditedPublicationMutation = useMutation({
    mutationFn: (publicationId: string) => getPublication(api, publicationId),
    onSuccess: (details) => {
      const latestDraft = createPublicationDraftFromDetails(details);
      const baseline = isolatedDraftBaselineRef.current;
      setDraft((current) =>
        baseline ? rebasePublicationDraft(baseline, current, latestDraft) : latestDraft,
      );
      isolatedDraftBaselineRef.current = latestDraft;
      setEditorContext((current) =>
        current?.kind === 'import'
          ? {
              ...current,
              publicationId: details.id,
              expectedRevision: details.version,
            }
          : {
              kind: 'edit',
              publicationId: details.id,
              expectedRevision: details.version,
            },
      );
      setRevisionConflictPublicationId(null);
      setFieldError('');
      setValidationStarted(false);
      pushToast({ tone: 'info', title: 'Правки перенесены в актуальную версию' });
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось обновить публикацию'),
      }),
  });
  const actionMutation = useMutation({
    mutationFn: ({ publication, action }: PublicationActionTarget) => {
      const payload = {
        expectedRevision: publication.version,
        requestId: requestIds.resolveActionRequestId(publication.id, action, publication.version),
      };
      if (action === 'cancel') {
        return cancelPublication(api, publication.id, payload);
      }
      return action === 'pause'
        ? pausePublication(api, publication.id, payload)
        : resumePublication(api, publication.id, payload);
    },
    onSuccess: async (_, variables) => {
      requestIds.confirmActionSuccess();
      setActionTarget(null);
      setDetailsTarget(null);
      await invalidatePublicationQueries();
      pushToast({
        tone: variables.action === 'cancel' ? 'info' : 'success',
        title:
          variables.action === 'cancel'
            ? 'Публикация отменена'
            : variables.action === 'pause'
              ? 'Расписание на паузе'
              : 'Расписание запущено',
      });
    },
    onError: async (error) => {
      if (isPublicationRevisionConflictError(error)) {
        setActionTarget(null);
        await Promise.all([
          invalidatePublicationQueries(),
          queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        ]);
        pushToast({ tone: 'info', title: 'Публикация обновлена' });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось выполнить действие'),
      });
    },
  });
  const retryMutation = useMutation({
    mutationFn: (target: PublicationRetryTarget) =>
      retryPublicationOccurrence(api, target.publicationId, target.occurrenceId, {
        requestId: requestIds.resolveRetryRequestId(target),
        contentMode: target.contentMode,
        ...(target.contentMode === 'latest'
          ? {
              expectedPublicationVersion: target.expectedPublicationVersion,
              expectedContentRevision: target.expectedContentRevision,
            }
          : {}),
      }),
    onSuccess: async () => {
      requestIds.confirmRetrySuccess();
      setRetryChoiceTarget(null);
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Повтор поставлен в очередь' });
    },
    onError: async (error) => {
      if (isPublicationRevisionConflictError(error)) {
        setRetryChoiceTarget(null);
        await Promise.all([
          invalidatePublicationQueries(),
          queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
          queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
        ]);
        pushToast({ tone: 'info', title: 'Публикация обновлена' });
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось повторить отправку'),
      });
    },
  });
  const resolveAmbiguousMutation = useMutation({
    mutationFn: (target: PublicationAmbiguousTarget) =>
      resolvePublicationAmbiguousDelivery(api, target.publicationId, target.occurrenceId, {
        requestId: requestIds.resolveAmbiguousRequestId(target),
        deliveryId: target.deliveryId,
        resolution: target.resolution,
      }),
    onSuccess: async () => {
      requestIds.confirmAmbiguousSuccess();
      setAmbiguousTarget(null);
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Статус доставки сохранён' });
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeUserFacingError(error, 'Не удалось сохранить статус'),
      }),
  });

  const visibleItems =
    view === 'history' ? historyItems : view === 'schedules' ? scheduleItems : currentItems;
  const currentListQuery =
    view === 'history' ? historyQuery : view === 'schedules' ? schedulesQuery : currentQuery;
  const visibleCustomButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const previewTarget =
    draft.targets.find((target) => getPublicationTargetKey(target) === previewTargetKey) ??
    draft.targets[0] ??
    null;
  const resolvedPreviewTargetKey = previewTarget ? getPublicationTargetKey(previewTarget) : null;
  const systemButtons = buildPublicationSystemButtons(previewTarget ? [previewTarget] : []);
  const visibleCustomButtonCount = visibleCustomButtons.length;
  const videoNeedsReselection = publicationDraftNeedsVideoReselection(draft);
  const hasSelectedVideo =
    draft.mediaType === 'video' && Boolean(draft.mediaBase64 || draft.mediaPayload);
  const hasMedia = draft.images.length > 0 || hasSelectedVideo || draft.retainedAssets.length > 0;
  const hasContent = Boolean(draft.text.trim() || hasMedia);
  const hasButtonErrors =
    draft.buttonEnabled &&
    hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(draft.buttons));
  const selectedPublisherTargetUnavailable =
    isPublisherProfile &&
    !publisherDraftHydration.isPending &&
    hasUnavailablePublisherDraftTargets({
      selectedTargets: draft.targets,
      currentTargets: targets,
      hydrationFailed: publisherDraftHydration.isError,
    });
  const publisherHasReadyTarget =
    !isPublisherProfile ||
    (targetSources.publisherSummary?.ready ??
      targets.filter((target) => target.readiness?.canPublish === true).length) > 0;
  const publisherCanCreate =
    isPublisherProfile && sourcesReady && !sourcesHaveError && publisherHasReadyTarget;
  const operationBusy =
    saveMutation.isPending ||
    testMutation.isPending ||
    openPublicationMutation.isPending ||
    actionMutation.isPending ||
    retryMutation.isPending ||
    refreshEditedPublicationMutation.isPending ||
    initialTargetRoute.pending ||
    publisherDraftHydration.isPending ||
    videoPreparing ||
    editorClosePending;
  const isBusy = operationBusy || mediaPreparing;
  const anyBusy = isBusy || resolveAmbiguousMutation.isPending;
  const recurrenceError = getRecurrenceError(draft);
  const explicitSlotsLimitFeedback = getPublicationExplicitSlotsLimitFeedback(draft);
  const validationIssues = useMemo<BroadcastPublishIssueAction[]>(() => {
    const issues: BroadcastPublishIssueAction[] = [];
    if (imagesNeedReselection) {
      issues.push({
        label: 'Фото',
        onClick: () =>
          focusEditorSection('content', 'Добавьте фото снова или выберите «Без фото».'),
      });
    } else if (videoNeedsReselection) {
      issues.push({
        label: 'Видео',
        onClick: () => focusEditorSection('content', 'Выберите видео снова.'),
      });
    } else if (!hasContent) {
      issues.push({
        label: 'Сообщение',
        onClick: () => focusEditorSection('content', 'Добавьте текст, фото или видео.'),
      });
    } else if (draft.text.length > PUBLICATION_TEXT_MAX_LENGTH) {
      issues.push({
        label: 'Текст',
        onClick: () =>
          focusEditorSection('content', `Максимум ${PUBLICATION_TEXT_MAX_LENGTH} символов.`),
      });
    }
    if (draft.targets.length === 0) {
      issues.push({
        label: 'Получатели',
        onClick: () => focusEditorSection('targets', 'Выберите хотя бы одного получателя.'),
      });
    } else if (draft.targets.length > MAX_PUBLICATION_TARGETS) {
      issues.push({
        label: 'Получатели',
        onClick: () =>
          focusEditorSection('targets', `Можно выбрать до ${MAX_PUBLICATION_TARGETS} получателей.`),
      });
    } else if (selectedPublisherTargetUnavailable) {
      issues.push({
        label: 'Подключение',
        onClick: () =>
          focusEditorSection(
            'targets',
            'Выбранный получатель пока не готов к публикации через Публик.',
          ),
      });
    }
    if (explicitSlotsLimitFeedback) {
      issues.push({
        label: 'Расписание',
        onClick: () => focusEditorSection('timing', explicitSlotsLimitFeedback.title),
      });
    } else if (
      (draft.timingMode === 'once' ||
        (draft.timingMode === 'schedule' && draft.scheduleKind === 'slots')) &&
      !hasFuturePublicationSlot(draft.scheduledSlots)
    ) {
      issues.push({
        label: 'Время',
        onClick: () => focusEditorSection('timing', 'Выберите будущее время.'),
      });
    }
    if (draft.timingMode === 'schedule' && draft.scheduleKind === 'recurrence' && recurrenceError) {
      issues.push({
        label: 'Повтор',
        onClick: () => focusEditorSection('timing', recurrenceError),
      });
    }
    if (hasButtonErrors) {
      issues.push({
        label: 'Кнопки',
        onClick: () => {
          focusEditorSection('content', 'Проверьте текст и ссылку кнопки.');
          setButtonsOpen(true);
        },
      });
    }
    return issues;
  }, [
    draft,
    explicitSlotsLimitFeedback,
    hasButtonErrors,
    hasContent,
    imagesNeedReselection,
    recurrenceError,
    selectedPublisherTargetUnavailable,
    videoNeedsReselection,
  ]);

  useEffect(() => {
    if (!isEditor) {
      setMediaPreparing(false);
    }
  }, [isEditor]);

  useEffect(() => {
    document.body.classList.toggle('publications-editor-open', isEditor);
    const bottomNav = document.querySelector<HTMLElement>('.app-shell > .bottom-nav');
    const previousBottomNavInert = bottomNav?.inert ?? false;
    const previousBottomNavAriaHidden = bottomNav?.getAttribute('aria-hidden') ?? null;
    if (isEditor && bottomNav) {
      bottomNav.inert = true;
      bottomNav.setAttribute('aria-hidden', 'true');
    }

    return () => {
      document.body.classList.remove('publications-editor-open');
      if (!bottomNav) {
        return;
      }
      bottomNav.inert = previousBottomNavInert;
      if (previousBottomNavAriaHidden === null) {
        bottomNav.removeAttribute('aria-hidden');
      } else {
        bottomNav.setAttribute('aria-hidden', previousBottomNavAriaHidden);
      }
    };
  }, [isEditor]);

  useEffect(() => {
    if (!isPublisherProfile || !hydrated || initialComposeRouteAppliedRef.current) {
      return;
    }
    initialComposeRouteAppliedRef.current = true;
    if (searchParams.get('compose') === '1' && !postImport.hasImportRoute) {
      setEditorContext({ kind: 'create' });
      setImportOmissions([]);
    }
  }, [hydrated, isPublisherProfile, postImport.hasImportRoute, searchParams]);

  useEffect(() => {
    const next = isPublisherProfile ? null : stripPublisherOnlyPublicationRouteParams(searchParams);
    if (!next) {
      return;
    }
    setSearchParams(next, { replace: true });
  }, [isPublisherProfile, searchParams, setSearchParams]);

  useEffect(() => {
    if (targets.length === 0) {
      return;
    }

    setDraft((current) => {
      let changed = false;
      const refreshedTargets = current.targets.map((target) => {
        const currentTarget = targets.find(
          (candidate) => getPublicationTargetKey(candidate) === getPublicationTargetKey(target),
        );
        if (!currentTarget || hasSamePublicationTargetMetadata(currentTarget, target)) {
          return target;
        }
        changed = true;
        return currentTarget;
      });

      return changed ? { ...current, targets: refreshedTargets } : current;
    });
  }, [draft.targets, setDraft, targets]);

  usePublicationEditorAutofocus(isEditor, editorTitleRef);

  useEffect(() => {
    if (!isEditor) {
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role="dialog"][aria-modal="true"]')) {
        return;
      }
      event.preventDefault();
      requestCloseEditor(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draft, editorContext?.kind, isBusy, isEditor]);

  useNativeBackHandler(
    () => {
      requestCloseEditor(true);
      return true;
    },
    { enabled: isEditor, priority: 610 },
  );

  useNativeBackHandler(
    () => {
      closeLegacyView();
      return true;
    },
    { enabled: isLegacyView, priority: 600 },
  );

  async function invalidatePublicationQueries() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.listRoot }),
      queryClient.invalidateQueries({ queryKey: ['publications', 'calendar'] }),
    ]);
  }

  function setComposeRoute(open: boolean, options: { importDraftId?: string | null } = {}) {
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    if (!open) {
      next.delete('import');
      next.delete('draft');
    } else if (isPublisherDraftRouteId(options.importDraftId)) {
      next.set('draft', options.importDraftId);
    }
    if (open) {
      next.set('compose', '1');
    } else {
      next.delete('compose');
    }
    setSearchParams(next, { replace: true });
  }

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

  function requestPublicationRetry(
    publication: PublicationDetails,
    occurrence: PublicationOccurrenceSummary,
  ) {
    if (isPublicationOccurrenceContentStale(occurrence, publication.content.revision)) {
      setRetryChoiceTarget({
        publicationId: publication.id,
        occurrenceId: occurrence.id,
        publicationVersion: publication.version,
        originalContentRevision: occurrence.contentRevision,
        latestContentRevision: publication.content.revision,
      });
      return;
    }
    retryMutation.mutate({
      publicationId: publication.id,
      occurrenceId: occurrence.id,
      contentMode: 'original',
    });
  }

  function focusEditorSection(section: 'content' | 'targets' | 'timing', message: string) {
    setFieldError(message);
    const target =
      section === 'content'
        ? contentSectionRef.current
        : section === 'targets'
          ? targetsSectionRef.current
          : timingSectionRef.current;
    window.requestAnimationFrame(() => {
      const focusTarget = target?.querySelector<HTMLElement>(
        '[aria-invalid="true"], textarea:not(:disabled), input:not(:disabled), button:not(:disabled)',
      );
      focusTarget?.focus({ preventScroll: true });
      target?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
    });
  }

  function rememberEditorReturnFocus(publicationId: string | null = null) {
    editorReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    editorReturnPublicationIdRef.current = publicationId;
  }

  function restoreEditorReturnFocus() {
    const previousFocus = editorReturnFocusRef.current;
    const publicationId = editorReturnPublicationIdRef.current;
    editorReturnFocusRef.current = null;
    editorReturnPublicationIdRef.current = null;
    window.requestAnimationFrame(() => {
      if (previousFocus?.isConnected) {
        previousFocus.focus();
        return;
      }
      if (!publicationId) {
        return;
      }
      const card = Array.from(
        document.querySelectorAll<HTMLElement>('.publication-feed-card[data-publication-id]'),
      ).find((candidate) => candidate.dataset.publicationId === publicationId);
      card
        ?.querySelector<HTMLElement>(
          '.publication-feed-card__menu-trigger, .publication-feed-card__surface',
        )
        ?.focus();
    });
  }

  function openPublicationEditor(publication: PublicationSummary, mode: 'edit' | 'duplicate') {
    if (!isPublisherProfile) {
      return;
    }
    rememberEditorReturnFocus(publication.id);
    openPublicationMutation.mutate({ publicationId: publication.id, mode });
  }

  function openImportedDraft(
    publicationId: string,
    sessionId: string | null = null,
    omissions: PublisherPostImportOmission[] = [],
  ) {
    if (!isPublisherProfile || !hydrated || openPublicationMutation.isPending) {
      return;
    }
    if (!editorReturnFocusRef.current) {
      rememberEditorReturnFocus(publicationId);
    }
    openPublicationMutation.mutate({ publicationId, mode: 'import', sessionId, omissions });
  }

  function requestCreateEditor() {
    if (!isPublisherProfile) {
      return;
    }
    rememberEditorReturnFocus();
    postImport.showCreateSheet();
  }

  function closeCreateSheet() {
    if (!postImport.closeCreateSheet()) {
      return;
    }
    editorReturnFocusRef.current = null;
    editorReturnPublicationIdRef.current = null;
  }

  function openCreateEditor() {
    if (!isPublisherProfile) {
      return;
    }
    if (!editorReturnFocusRef.current) {
      rememberEditorReturnFocus();
    }
    postImport.hideCreateSheet();
    setEditorContext({ kind: 'create' });
    setImportOmissions([]);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(true);
    maxImpact('soft');
  }

  function requestCloseEditor(preserveDraft: boolean) {
    if (isBusy) {
      return;
    }
    setEditorClosePending(true);
    void flushDraft()
      .then(() => {
        const baseline = isolatedDraftBaselineRef.current;
        if (
          isIsolatedPublicationEditor(editorContext?.kind ?? null) &&
          baseline &&
          hasPublicationDraftChanges(baseline, draft)
        ) {
          setPendingEditorClose(true);
          return;
        }
        closeEditor(preserveDraft);
      })
      .finally(() => setEditorClosePending(false));
  }

  function closeEditor(preserveDraft: boolean) {
    if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
      restoreCreateDraftAndClose();
      return;
    }
    setEditorContext(null);
    setImportOmissions([]);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setPendingEditorClose(false);
    setPendingDraftClear(false);
    setRevisionConflictPublicationId(null);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(false);
    if (!preserveDraft) {
      savedCreateDraftRef.current = null;
    }
    isolatedDraftBaselineRef.current = null;
    restoreEditorReturnFocus();
  }

  function restoreCreateDraftAndClose() {
    const savedCreateDraft = savedCreateDraftRef.current;
    replaceDraft(
      savedCreateDraft?.draft ?? createEmptyPublicationDraft(),
      savedCreateDraft?.missingImageCount ?? 0,
    );
    savedCreateDraftRef.current = null;
    isolatedDraftBaselineRef.current = null;
    setEditorContext(null);
    setImportOmissions([]);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setPendingEditorClose(false);
    setPendingDraftClear(false);
    setRevisionConflictPublicationId(null);
    setFieldError('');
    setValidationStarted(false);
    setComposeRoute(false);
    restoreEditorReturnFocus();
  }

  function validateDraft(options: { ignoreSchedule?: boolean } = {}): boolean {
    setValidationStarted(true);
    const nextButtonErrors = validateBroadcastLinkButtons(draft.buttons);
    if (mediaPreparing) {
      setFieldError('Дождитесь завершения подготовки фото.');
      return false;
    }
    if (imagesNeedReselection) {
      setFieldError('Добавьте фото снова или выберите «Без фото».');
      return false;
    }
    if (videoNeedsReselection) {
      setFieldError('Выберите видео снова.');
      return false;
    }
    if (!hasContent) {
      setFieldError('Добавьте текст, фото или видео.');
      return false;
    }
    if (draft.text.length > PUBLICATION_TEXT_MAX_LENGTH) {
      setFieldError(`Максимум ${PUBLICATION_TEXT_MAX_LENGTH} символов.`);
      return false;
    }
    if (draft.buttonEnabled && hasBroadcastLinkButtonErrors(nextButtonErrors)) {
      setButtonsOpen(true);
      return false;
    }
    if (draft.targets.length === 0) {
      setFieldError('Выберите хотя бы одного получателя.');
      return false;
    }
    if (draft.targets.length > MAX_PUBLICATION_TARGETS) {
      setFieldError(`Можно выбрать до ${MAX_PUBLICATION_TARGETS} получателей.`);
      return false;
    }
    if (selectedPublisherTargetUnavailable) {
      setFieldError('Выбранный получатель пока не готов к публикации через Публик.');
      return false;
    }
    if (!options.ignoreSchedule) {
      if (reportExplicitSlotsLimit()) {
        return false;
      }
      const needsFutureSlots =
        draft.timingMode === 'once' ||
        (draft.timingMode === 'schedule' && draft.scheduleKind === 'slots');
      if (needsFutureSlots && !hasFuturePublicationSlot(draft.scheduledSlots)) {
        setFieldError('Выберите будущее время.');
        return false;
      }
      if (
        draft.timingMode === 'schedule' &&
        draft.scheduleKind === 'recurrence' &&
        recurrenceError
      ) {
        setFieldError(recurrenceError);
        return false;
      }
    }
    setFieldError('');
    return true;
  }

  function reportExplicitSlotsLimit(): boolean {
    if (!explicitSlotsLimitFeedback) {
      return false;
    }

    setValidationStarted(true);
    setPendingReview(false);
    setPendingConflict(false);
    focusEditorSection('timing', explicitSlotsLimitFeedback.title);
    pushToast(explicitSlotsLimitFeedback);
    maxNotify(explicitSlotsLimitFeedback.notification);
    return true;
  }

  function submitPublication(replaceConflicts: boolean) {
    if (mediaPreparing) {
      return;
    }
    if (reportExplicitSlotsLimit()) {
      return;
    }
    saveMutation.mutate({ replaceConflicts });
  }

  function handlePrimaryAction() {
    if (mediaPreparing) {
      return;
    }
    if (validateDraft()) {
      setPendingReview(true);
      return;
    }
    validationIssues[0]?.onClick();
  }

  function handleTest() {
    if (testMutation.isPending || mediaPreparing) {
      return;
    }

    if (validateDraft({ ignoreSchedule: true })) {
      testMutation.mutate();
      return;
    }
    validationIssues
      .find((issue) => issue.label !== 'Время' && issue.label !== 'Повтор')
      ?.onClick();
  }

  function updateOnceSlot(part: 'date' | 'time', value: string) {
    setDraft((current) => {
      const onceDate = part === 'date' ? value : current.onceDate;
      const onceTime = part === 'time' ? value : current.onceTime;
      const scheduledAt =
        onceDate && onceTime ? parseLocalDateTimeInputValue(`${onceDate}T${onceTime}`) : null;
      return {
        ...current,
        onceDate,
        onceTime,
        scheduledSlots: scheduledAt ? [scheduledAt] : [],
      };
    });
    setFieldError('');
  }

  function updateRecurrenceTime(index: number, value: string) {
    setDraft((current) => ({
      ...current,
      recurrence: {
        ...current.recurrence,
        times: current.recurrence.times.map((time, timeIndex) =>
          timeIndex === index ? value : time,
        ),
      },
    }));
    setFieldError('');
  }

  function renderFilters() {
    const statusFilters = STATUS_FILTERS_BY_VIEW[view];
    const hasActiveFilters = entityFilter !== 'all' || statusFilter !== 'all';
    const showFilterControls = filtersOpen || hasActiveFilters;

    return (
      <div className={cn('publications-filterbar', showFilterControls && 'is-expanded')}>
        <div className="publications-filterbar__search-row">
          <label className="publication-search publications-filterbar__search">
            <Search aria-hidden />
            <input
              type="search"
              value={query}
              maxLength={120}
              onChange={(event) => {
                const nextQuery = event.currentTarget.value;
                setQuery(nextQuery);
                setPublicationHubRoute({ query: nextQuery });
              }}
              placeholder="Найти"
              aria-label="Поиск публикаций"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setPublicationHubRoute({ query: '' });
                }}
                aria-label="Очистить поиск"
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </label>
          <button
            type="button"
            className={cn('publications-filterbar__toggle', hasActiveFilters && 'is-active')}
            onClick={() => setFiltersOpen((current) => !current)}
            aria-expanded={showFilterControls}
            aria-label="Фильтры публикаций"
            title="Фильтры"
          >
            <FilterList aria-hidden />
          </button>
        </div>

        {showFilterControls ? (
          <div className="publications-filterbar__controls">
            <div
              className="publications-filterbar__entities"
              role="group"
              aria-label="Тип получателя"
            >
              {ENTITY_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={entityFilter === filter.value}
                  className={cn(entityFilter === filter.value && 'is-active')}
                  onClick={() => {
                    setEntityFilter(filter.value);
                    setPublicationHubRoute({ entity: filter.value });
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <select
              value={statusFilter}
              onChange={(event) => {
                const nextStatus = event.currentTarget.value as PublicationStatusFilter;
                setStatusFilter(nextStatus);
                setPublicationHubRoute({ status: nextStatus });
              }}
              aria-label="Статус публикаций"
            >
              {statusFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters ? (
              <button
                type="button"
                className="publications-filterbar__reset"
                onClick={() => {
                  setEntityFilter('all');
                  setStatusFilter('all');
                  setPublicationHubRoute({ entity: 'all', status: 'all' });
                }}
                aria-label="Сбросить фильтры"
                title="Сбросить фильтры"
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderLegacyFilters() {
    const hasActiveFilters = legacyKindFilter !== 'all' || legacyEntityFilter !== 'all';
    const showFilterControls = legacyFiltersOpen || hasActiveFilters;

    return (
      <div className={cn('legacy-publications-filterbar', showFilterControls && 'is-expanded')}>
        <div className="legacy-publications-filterbar__search-row">
          <label className="publication-search legacy-publications-filterbar__search">
            <Search aria-hidden />
            <input
              type="search"
              value={legacyQuery}
              maxLength={120}
              onChange={(event) => {
                const nextQuery = event.currentTarget.value;
                setLegacyQuery(nextQuery);
                setLegacyRoute(true, { query: nextQuery });
              }}
              placeholder="Найти"
              aria-label="Поиск ранее созданных постов"
            />
            {legacyQuery ? (
              <button
                type="button"
                onClick={() => {
                  setLegacyQuery('');
                  setLegacyRoute(true, { query: '' });
                }}
                aria-label="Очистить поиск"
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </label>
          <button
            type="button"
            className={cn('legacy-publications-filterbar__toggle', hasActiveFilters && 'is-active')}
            onClick={() => setLegacyFiltersOpen((current) => !current)}
            aria-expanded={showFilterControls}
            aria-label="Фильтры ранее созданных постов"
            title="Фильтры"
          >
            <FilterList aria-hidden />
          </button>
        </div>

        {showFilterControls ? (
          <div className="legacy-publications-filterbar__controls">
            <div
              className="legacy-publications-filterbar__kinds"
              role="group"
              aria-label="Тип ранее созданного поста"
            >
              {LEGACY_KIND_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  aria-pressed={legacyKindFilter === filter.value}
                  className={cn(legacyKindFilter === filter.value && 'is-active')}
                  onClick={() => {
                    setLegacyKindFilter(filter.value);
                    setLegacyRoute(true, { kind: filter.value });
                  }}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <select
              value={legacyEntityFilter}
              onChange={(event) => {
                const nextEntity = event.currentTarget.value as PublicationEntityFilter;
                setLegacyEntityFilter(nextEntity);
                setLegacyRoute(true, { entity: nextEntity });
              }}
              aria-label="Источник ранее созданных постов"
            >
              {ENTITY_FILTERS.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </select>
            {hasActiveFilters ? (
              <button
                type="button"
                className="legacy-publications-filterbar__reset"
                onClick={() => {
                  setLegacyKindFilter('all');
                  setLegacyEntityFilter('all');
                  setLegacyRoute(true, { kind: 'all', entity: 'all' });
                }}
                aria-label="Сбросить фильтры"
                title="Сбросить фильтры"
              >
                <Xmark aria-hidden />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  function renderPublicationCard(publication: PublicationSummary) {
    const delivery = getPublicationActionableDelivery(publication);
    const actionCapabilities = getPublicationActionCapabilities(publication);
    const pending =
      (actionMutation.isPending && actionMutation.variables?.publication.id === publication.id) ||
      (openPublicationMutation.isPending &&
        openPublicationMutation.variables?.publicationId === publication.id);
    return (
      <PublicationFeedCard
        key={publication.id}
        id={publication.id}
        title={publication.title || formatPublicationTargets(publication)}
        preview={publication.contentPreview}
        previewFormat={publication.contentPreviewFormat}
        fallback={
          publication.hasVideo
            ? 'Видео без текста'
            : publication.mediaCount > 0
              ? 'Фото без текста'
              : null
        }
        eyebrow={getPublicationFeedStatusLabel(publication)}
        tone={getLifecycleTone(publication)}
        busy={pending}
        meta={[formatPublicationTargets(publication), formatPublicationSchedule(publication)]}
        primaryAction={{ label: 'Открыть детали', onClick: () => setDetailsTarget(publication) }}
        canEdit={isPublisherProfile && actionCapabilities.canEdit}
        canPause={actionCapabilities.canPause}
        canResume={actionCapabilities.canResume}
        canRetry={actionCapabilities.canRetry}
        canDuplicate={isPublisherProfile}
        canCancel={actionCapabilities.canCancel}
        editLabel={getPublicationEditActionLabel(actionCapabilities.editScope)}
        cancelLabel={
          actionCapabilities.hasFutureSends ? 'Отменить будущие отправки' : 'Отменить публикацию'
        }
        onEdit={() => openPublicationEditor(publication, 'edit')}
        onPause={() => setActionTarget({ publication, action: 'pause' })}
        onResume={() => setActionTarget({ publication, action: 'resume' })}
        onRetry={() => setDetailsTarget(publication)}
        onDuplicate={() => openPublicationEditor(publication, 'duplicate')}
        onCancel={() => setActionTarget({ publication, action: 'cancel' })}
        footer={
          delivery.ambiguous > 0 ? (
            <span className="publication-delivery-note is-danger">Проверьте отправку</span>
          ) : delivery.failed > 0 || delivery.canceled > 0 ? (
            <span className="publication-delivery-note is-danger">
              Есть недоставленные сообщения
            </span>
          ) : delivery.sent > 0 ? (
            <span className="publication-delivery-note">
              Доставлено {delivery.sent} из {delivery.total}
            </span>
          ) : null
        }
      />
    );
  }

  function renderFeed() {
    return (
      <>
        {renderFilters()}
        {currentListQuery.isLoading ? (
          <StatusState tone="neutral" title="Загружаю публикации" />
        ) : currentListQuery.isError && !currentListQuery.data ? (
          <StatusState
            tone="danger"
            title="Не удалось загрузить"
            description={describeUserFacingError(currentListQuery.error, 'Повторите ещё раз.')}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void currentListQuery.refetch()}
              >
                Обновить
              </button>
            }
          />
        ) : visibleItems.length === 0 ? (
          <div className="publications-empty">
            <strong>
              {query.trim() || entityFilter !== 'all' || statusFilter !== 'all'
                ? 'Ничего не найдено'
                : view === 'history'
                  ? 'История пока пустая'
                  : view === 'schedules'
                    ? 'Расписаний пока нет'
                    : 'Текущих постов нет'}
            </strong>
            {isPublisherProfile && view !== 'history' && !query.trim() && publisherCanCreate ? (
              <button type="button" className="publications-primary" onClick={requestCreateEditor}>
                <Plus aria-hidden />
                <span>Новая публикация</span>
              </button>
            ) : null}
          </div>
        ) : (
          <div className="publications-feed">{visibleItems.map(renderPublicationCard)}</div>
        )}
        {currentListQuery.hasNextPage && currentListQuery.data ? (
          <button
            type="button"
            className="publications-load-more"
            onClick={() => void currentListQuery.fetchNextPage()}
            disabled={currentListQuery.isFetchingNextPage}
          >
            {currentListQuery.isFetchingNextPage
              ? 'Загрузка...'
              : currentListQuery.isFetchNextPageError
                ? 'Повторить'
                : 'Показать ещё'}
          </button>
        ) : null}
      </>
    );
  }

  const recheckPublisherTargets = () =>
    publicationTargetRecheck.runPublicationTargetRecheck(targetSources.recheck, pushToast);

  function renderHub() {
    return (
      <>
        <PublicationHubHeader
          publisherProfile={isPublisherProfile}
          canCreate={publisherCanCreate}
          targets={targets}
          publisherSummary={targetSources.publisherSummary}
          sourcesLoading={sourcesLoading}
          sourcesFetching={sourcesFetching}
          sourcesHaveError={sourcesHaveError}
          onCreate={requestCreateEditor}
          onRefresh={recheckPublisherTargets}
        />

        {isPublisherProfile ? <PublisherPostImportStatus {...postImport.statusProps} /> : null}

        <div className="publications-tabs" role="group" aria-label="Раздел постов">
          {VIEW_OPTIONS.map((option) =>
            (() => {
              const count =
                option.value === 'current'
                  ? currentQuery.data
                    ? formatLoadedCount(currentItems.length, Boolean(currentQuery.hasNextPage))
                    : null
                  : option.value === 'schedules'
                    ? schedulesQuery.data
                      ? formatLoadedCount(scheduleItems.length, Boolean(schedulesQuery.hasNextPage))
                      : null
                    : historyQuery.data
                      ? formatLoadedCount(historyItems.length, Boolean(historyQuery.hasNextPage))
                      : null;

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={view === option.value}
                  className={cn(view === option.value && 'is-active')}
                  onClick={() => changeView(option.value)}
                >
                  <span>{option.label}</span>
                  {count ? <small>{count}</small> : null}
                </button>
              );
            })(),
          )}
        </div>

        {isPublisherProfile && hasSavedDraft ? (
          <button type="button" className="publication-draft-resume" onClick={openCreateEditor}>
            <span>
              <strong>Черновик</strong>
              <small>
                <MaxMarkdownPreview
                  value={draft.text}
                  sourceFormat={draft.textFormat}
                  className="publication-draft-resume__preview"
                  normalizeWhitespace
                  fallback={formatTargetSummary(draft.targets)}
                />
              </small>
            </span>
            <span>Продолжить</span>
          </button>
        ) : null}

        {showLegacyEntry ? (
          <LegacyPublicationsEntry
            count={legacyEntryCount}
            countIncomplete={
              legacyProbeHasError || legacyActiveCount === null || legacyHistoryCount === null
            }
            onOpen={openLegacyView}
          />
        ) : null}

        {renderFeed()}
      </>
    );
  }

  function renderLegacyHub() {
    const hasFilters =
      legacyQuery.trim().length > 0 || legacyKindFilter !== 'all' || legacyEntityFilter !== 'all';

    return (
      <>
        <header className="publications-editor-header legacy-publications-header">
          <button
            type="button"
            onClick={closeLegacyView}
            aria-label="Вернуться к постам"
            title="Назад"
          >
            <NavArrowLeft aria-hidden />
          </button>
          <span>
            <h1>Старые публикации</h1>
            {legacyCurrentTotal !== null ? (
              <small>
                {formatRussianCountLabel(legacyCurrentTotal, 'запись', 'записи', 'записей')}
              </small>
            ) : null}
          </span>
        </header>

        <div className="legacy-publications-tabs" role="group" aria-label="Старые публикации">
          {LEGACY_VIEW_OPTIONS.map((option) => {
            const count = option.value === 'active' ? legacyActiveCount : legacyHistoryCount;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={legacyView === option.value}
                className={cn(legacyView === option.value && 'is-active')}
                onClick={() => {
                  setLegacyView(option.value);
                  setLegacyRoute(true, { view: option.value });
                  maxImpact('soft');
                }}
              >
                <span>{option.label}</span>
                {count !== null ? <small>{count}</small> : null}
              </button>
            );
          })}
        </div>

        {renderLegacyFilters()}

        {legacyListQuery.isLoading ? (
          <StatusState tone="neutral" title="Загружаю ранее созданные посты" />
        ) : legacyListQuery.isError && !legacyListQuery.data ? (
          <StatusState
            tone="danger"
            title="Не удалось загрузить"
            description={describeUserFacingError(legacyListQuery.error, 'Повторите ещё раз.')}
            action={
              <button
                type="button"
                className="button button--ghost"
                onClick={() => void legacyListQuery.refetch()}
              >
                Обновить
              </button>
            }
          />
        ) : legacyItems.length === 0 ? (
          <div className="publications-empty">
            <strong>
              {hasFilters
                ? 'Ничего не найдено'
                : legacyView === 'history'
                  ? 'История пока пустая'
                  : 'Активных записей нет'}
            </strong>
          </div>
        ) : (
          <LegacyPublicationsList items={legacyItems} />
        )}

        {legacyListQuery.hasNextPage && legacyListQuery.data ? (
          <button
            type="button"
            className="publications-load-more"
            onClick={() => void legacyListQuery.fetchNextPage()}
            disabled={legacyListQuery.isFetchingNextPage}
          >
            {legacyListQuery.isFetchingNextPage
              ? 'Загрузка...'
              : legacyListQuery.isFetchNextPageError
                ? 'Повторить'
                : 'Показать ещё'}
          </button>
        ) : null}
      </>
    );
  }

  function renderRecurrence() {
    const endMode = draft.recurrence.endsAt
      ? 'date'
      : draft.recurrence.maxOccurrences
        ? 'count'
        : 'never';
    return (
      <div className="publication-recurrence">
        <div className="publication-recurrence__frequency" role="group" aria-label="Частота">
          {(['daily', 'weekly'] as const).map((frequency) => (
            <button
              key={frequency}
              type="button"
              aria-pressed={draft.recurrence.frequency === frequency}
              className={cn(draft.recurrence.frequency === frequency && 'is-active')}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  recurrence: { ...current.recurrence, frequency },
                }))
              }
              disabled={isBusy}
            >
              {frequency === 'daily' ? 'Ежедневно' : 'По неделям'}
            </button>
          ))}
        </div>

        <PublicationRecurrenceIntervalField
          frequency={draft.recurrence.frequency}
          interval={draft.recurrence.interval}
          disabled={isBusy}
          onChange={(interval) =>
            setDraft((current) => ({
              ...current,
              recurrence: { ...current.recurrence, interval },
            }))
          }
        />

        {draft.recurrence.frequency === 'weekly' ? (
          <div className="publication-weekdays" aria-label="Дни недели">
            {WEEKDAYS.map((weekday) => {
              const selected = draft.recurrence.weekdays.includes(weekday.value);
              return (
                <button
                  key={weekday.value}
                  type="button"
                  className={cn(selected && 'is-active')}
                  aria-pressed={selected}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      recurrence: {
                        ...current.recurrence,
                        weekdays: selected
                          ? current.recurrence.weekdays.filter((value) => value !== weekday.value)
                          : [...current.recurrence.weekdays, weekday.value].sort(),
                      },
                    }))
                  }
                  disabled={isBusy}
                >
                  {weekday.label}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="publication-recurrence__times">
          {draft.recurrence.times.map((time, index) => (
            <div key={`${index}-${time}`}>
              <TimeField
                label={`Время ${index + 1}`}
                value={time}
                minuteStep={30}
                onChange={(value) => updateRecurrenceTime(index, value)}
                disabled={isBusy}
              />
              {draft.recurrence.times.length > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      recurrence: {
                        ...current.recurrence,
                        times: current.recurrence.times.filter(
                          (_, timeIndex) => timeIndex !== index,
                        ),
                      },
                    }))
                  }
                  aria-label={`Удалить время ${index + 1}`}
                  disabled={isBusy}
                >
                  <Xmark aria-hidden />
                </button>
              ) : null}
            </div>
          ))}
          {draft.recurrence.times.length < 12 ? (
            <button
              type="button"
              className="publication-recurrence__add-time"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  recurrence: {
                    ...current.recurrence,
                    times: [...current.recurrence.times, '18:00'],
                  },
                }))
              }
              disabled={isBusy}
            >
              <Plus aria-hidden />
              <span>Добавить время</span>
            </button>
          ) : null}
        </div>

        <label className="publication-recurrence__date">
          <span>Начать с</span>
          <input
            type="date"
            value={formatDateInput(draft.recurrence.startsAt)}
            onChange={(event) => {
              const startsAt = parseLocalDateTimeInputValue(`${event.currentTarget.value}T00:00`);
              setDraft((current) => ({
                ...current,
                recurrence: { ...current.recurrence, startsAt },
              }));
              setFieldError('');
            }}
            disabled={isBusy}
          />
        </label>

        <div className="publication-recurrence__end" role="group" aria-label="Завершение">
          {(
            [
              { value: 'count', label: 'По числу' },
              { value: 'date', label: 'По дате' },
              { value: 'never', label: 'Без лимита' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={endMode === option.value}
              className={cn(endMode === option.value && 'is-active')}
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  recurrence: {
                    ...current.recurrence,
                    endsAt:
                      option.value === 'date'
                        ? (current.recurrence.endsAt ??
                          new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString())
                        : null,
                    maxOccurrences:
                      option.value === 'count' ? (current.recurrence.maxOccurrences ?? 30) : null,
                  },
                }))
              }
              disabled={isBusy}
            >
              {option.label}
            </button>
          ))}
        </div>
        {endMode === 'count' ? (
          <label className="publication-recurrence__limit">
            <span>Запусков</span>
            <input
              type="number"
              min={1}
              max={365}
              value={draft.recurrence.maxOccurrences ?? 30}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  recurrence: {
                    ...current.recurrence,
                    maxOccurrences: Math.max(
                      1,
                      Math.min(365, Number(event.currentTarget.value) || 1),
                    ),
                  },
                }))
              }
              disabled={isBusy}
            />
          </label>
        ) : endMode === 'date' ? (
          <label className="publication-recurrence__date">
            <span>До даты</span>
            <input
              type="date"
              value={formatDateInput(draft.recurrence.endsAt)}
              onChange={(event) => {
                const parsed = parseLocalDateTimeInputValue(`${event.currentTarget.value}T23:59`);
                setDraft((current) => ({
                  ...current,
                  recurrence: { ...current.recurrence, endsAt: parsed },
                }));
              }}
              disabled={isBusy}
            />
          </label>
        ) : null}
      </div>
    );
  }

  function renderTiming() {
    const onceDate = draft.onceDate;
    const onceTime = draft.onceTime;
    return (
      <section
        ref={timingSectionRef}
        className="publication-editor-section publication-editor-section--timing"
      >
        <div className="publication-editor-section__head">
          <strong>Когда</strong>
          {draft.timingMode === 'now' ? null : <small>{formatDraftTiming(draft)}</small>}
        </div>
        <div className="publication-timing-tabs" role="group" aria-label="Время публикации">
          {(
            [
              { value: 'now', label: 'Сейчас' },
              { value: 'once', label: 'Один раз' },
              { value: 'schedule', label: 'Расписание' },
            ] as Array<{ value: PublicationTimingMode; label: string }>
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={draft.timingMode === option.value}
              className={cn(draft.timingMode === option.value && 'is-active')}
              onClick={() => {
                setDraft((current) => {
                  if (current.timingMode === option.value) {
                    return current;
                  }
                  if (option.value === 'once') {
                    const hasExplicitOnceTime = Boolean(current.onceDate && current.onceTime);
                    return {
                      ...current,
                      timingMode: 'once',
                      scheduledSlots: hasExplicitOnceTime ? current.scheduledSlots.slice(0, 1) : [],
                      onceDate: hasExplicitOnceTime ? current.onceDate : '',
                      onceTime: hasExplicitOnceTime ? current.onceTime : '',
                    };
                  }
                  return { ...current, timingMode: option.value };
                });
                setFieldError('');
              }}
              disabled={isBusy}
            >
              {option.label}
            </button>
          ))}
        </div>

        {draft.timingMode === 'once' ? (
          <div className="publication-once-fields">
            <label>
              <span>Дата</span>
              <input
                type="date"
                value={onceDate}
                onChange={(event) => updateOnceSlot('date', event.currentTarget.value)}
                disabled={isBusy}
              />
            </label>
            <TimeField
              label="Время"
              value={onceTime}
              allowEmpty
              minuteStep={30}
              onChange={(value) => updateOnceSlot('time', value)}
              disabled={isBusy}
            />
          </div>
        ) : draft.timingMode === 'schedule' ? (
          <>
            <div className="publication-schedule-kind" role="group" aria-label="Тип расписания">
              {(
                [
                  { value: 'slots', label: 'Даты' },
                  { value: 'recurrence', label: 'Повтор' },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={draft.scheduleKind === option.value}
                  className={cn(draft.scheduleKind === option.value && 'is-active')}
                  onClick={() =>
                    setDraft((current) => ({ ...current, scheduleKind: option.value }))
                  }
                  disabled={isBusy}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {draft.scheduleKind === 'recurrence' ? (
              renderRecurrence()
            ) : (
              <Suspense fallback={null}>
                <LazyBroadcastSchedulePlanner
                  value={draft.scheduledSlots}
                  occupiedSlots={
                    calendarAvailabilityQuery.data?.slots.map((slot) => slot.scheduledAt) ?? []
                  }
                  onChange={(scheduledSlots) => {
                    setDraft((current) => ({ ...current, scheduledSlots }));
                    setFieldError('');
                  }}
                  managedBroadcastsLoading={calendarAvailabilityQuery.isLoading}
                  calendarRefreshing={calendarAvailabilityQuery.isFetching}
                  currentTargetLabel={formatTargetSummary(draft.targets)}
                  targetContextLabel={formatTargetSummary(draft.targets)}
                  timingMode="scheduled"
                  availableTimingModes={['scheduled']}
                  viewMode="compose"
                  allowRecipe={false}
                  disabled={isBusy}
                />
              </Suspense>
            )}
          </>
        ) : null}

        {draft.timingMode === 'schedule' &&
        draft.scheduleKind === 'slots' &&
        calendarAvailabilityQuery.isError ? (
          <div className="publications-calendar-error" role="alert">
            <span>Не удалось загрузить занятые слоты.</span>
            <button type="button" onClick={() => void calendarAvailabilityQuery.refetch()}>
              <Refresh aria-hidden />
              <span>Повторить</span>
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  async function handlePublicationVideoFile(file: File | undefined): Promise<void> {
    if (!file) {
      return;
    }
    if (
      missingImageCount > 0 ||
      draft.images.length > 0 ||
      draft.retainedAssets.some((asset) => asset.type === 'image')
    ) {
      pushToast({
        tone: 'info',
        title:
          missingImageCount > 0
            ? 'Сначала завершите восстановление фото'
            : 'Сначала удалите добавленные фото',
      });
      return;
    }
    setVideoPreparing(true);
    try {
      const mediaMimeType = inferPublicationVideoMimeType(file.name, file.type);
      if (!mediaMimeType) {
        throw new Error('Выберите видеофайл.');
      }
      if (file.size > MAX_PUBLICATION_VIDEO_FILE_BYTES) {
        throw new Error('Видео слишком большое. Максимум 24 МБ.');
      }
      const mediaBase64 = await readBlobAsBase64(file);
      if (mediaBase64.length > MAX_PUBLICATION_VIDEO_BASE64_LENGTH) {
        throw new Error('Видео слишком большое. Максимум 24 МБ.');
      }
      setDraft((current) => ({
        ...current,
        images: [],
        retainedAssets: [],
        mediaType: 'video',
        mediaPayload: null,
        mediaBase64,
        mediaMimeType,
        mediaFileName: file.name.trim().slice(0, 128),
      }));
      discardMissingImages();
      setFieldError('');
    } catch (error) {
      pushToast({
        tone: 'info',
        title: describeUserFacingError(error, 'Не удалось подготовить видео'),
      });
    } finally {
      setVideoPreparing(false);
    }
  }

  function confirmDraftClear() {
    if (isBusy) {
      return;
    }
    setPendingDraftClear(false);
    setFieldError('');
    setValidationStarted(false);
    if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
      if (editorContext?.kind === 'import') {
        setImportOmissions([]);
      }
      replaceDraft(createEmptyPublicationDraft());
      return;
    }
    void clearDraft();
  }

  function renderEditor() {
    const editing = editorContext?.kind === 'edit';
    const importing = editorContext?.kind === 'import';
    const editScope: PublicationEditScope | null = editing
      ? draft.timingMode === 'now'
        ? 'retry'
        : 'future'
      : null;
    const editorTitle = importing
      ? 'Черновик'
      : editScope === 'retry'
        ? 'Версия для повтора'
        : editScope === 'future'
          ? 'Будущие отправки'
          : 'Новый пост';
    const retainedVideo = draft.retainedAssets.some((asset) => asset.type === 'video');
    const primaryLabel = getPublicationPrimaryActionLabel({
      hasValidationIssues: validationIssues.length > 0,
      editing,
      timingMode: draft.timingMode,
    });
    return (
      <>
        <header className="publications-editor-header">
          <button
            type="button"
            onClick={() => requestCloseEditor(true)}
            disabled={isBusy}
            aria-label="Назад"
            title="Назад"
          >
            <NavArrowLeft aria-hidden />
          </button>
          <span>
            <h1 ref={editorTitleRef} tabIndex={-1}>
              {editorTitle}
            </h1>
          </span>
          <button
            type="button"
            onClick={() => setPendingDraftClear(true)}
            aria-label="Очистить черновик"
            title="Очистить"
            disabled={isBusy || editing}
          >
            <Trash aria-hidden />
          </button>
        </header>

        <div className="publications-editor">
          <section
            ref={targetsSectionRef}
            className="publication-editor-section publication-editor-section--targets"
          >
            <PublicationTargetNotices
              publisherProfile={isPublisherProfile}
              sourcesHaveError={sourcesHaveError}
              sourcesUnavailable={sourcesUnavailable}
              sourcesFetching={sourcesFetching}
              chatsFailed={targetSources.chatsFailed}
              onSourcesRefresh={() => void targetSources.refetch()}
              draftHydrationFailed={publisherDraftHydration.isError}
              draftHydrationPending={publisherDraftHydration.isPending}
              onDraftHydrationRefresh={() => void publisherDraftHydration.refetch()}
              initialRoute={initialTargetRoute}
            />
            <PublicationTargetPicker
              choices={targets}
              value={draft.targets}
              compactSummary={isPublisherProfile}
              notice={
                selectedPublisherTargetUnavailable
                  ? 'Выбранный получатель недоступен. Удалите его.'
                  : null
              }
              remoteSource={
                isPublisherProfile
                  ? {
                      query: targetSources.publisherInputQuery,
                      entityFilter: targetSources.publisherEntityFilter,
                      settling: targetSources.publisherSearchSettling,
                      loading: sourcesLoading,
                      filteredTotal: targetSources.filteredTotal,
                      hasNextPage: targetSources.hasNextPage,
                      fetchingNextPage: targetSources.fetchingNextPage,
                      fetchNextPageError: targetSources.fetchNextPageError,
                      onQueryChange: targetSources.setPublisherInputQuery,
                      onEntityFilterChange: targetSources.setPublisherEntityFilter,
                      onLoadMore: () => void targetSources.fetchNextPage(),
                    }
                  : undefined
              }
              disabled={isBusy || (!isPublisherProfile && sourcesLoading && targets.length === 0)}
              error={fieldError.includes('получател') ? fieldError : null}
              onLimitReached={() =>
                pushToast({
                  tone: 'info',
                  title: `Можно выбрать до ${MAX_PUBLICATION_TARGETS} получателей`,
                })
              }
              onChange={(nextTargets) => {
                setDraft((current) => ({ ...current, targets: nextTargets }));
                setFieldError('');
              }}
            />
          </section>

          <Suspense
            fallback={
              <section
                ref={contentSectionRef}
                className="publication-editor-section publication-editor-section--content"
                aria-busy="true"
              >
                <div className="publication-editor-section__head">
                  <strong>Пост</strong>
                  <small>Загрузка...</small>
                </div>
              </section>
            }
          >
            <LazyPublicationContentEditorSection
              sectionRef={contentSectionRef}
              draft={draft}
              setDraft={setDraft}
              importing={editorContext?.kind === 'import'}
              importOmissions={importOmissions}
              importedAssetPreviews={importedAssetPreviews}
              customButtons={visibleCustomButtons}
              systemButtons={systemButtons}
              previewTargets={draft.targets}
              previewTargetKey={resolvedPreviewTargetKey}
              customButtonCount={visibleCustomButtonCount}
              hasButtonErrors={hasButtonErrors}
              showButtonsLabel={isPublisherProfile}
              isBusy={isBusy}
              operationBusy={operationBusy}
              imagesNeedReselection={imagesNeedReselection}
              missingImageCount={missingImageCount}
              retainedVideo={Boolean(retainedVideo)}
              videoPreparing={videoPreparing}
              videoNeedsReselection={videoNeedsReselection}
              fieldError={fieldError}
              onDiscardMissingImages={discardMissingImages}
              onResolveMissingImages={resolveMissingImages}
              onPreviewTargetChange={setPreviewTargetKey}
              onOpenButtons={() => setButtonsOpen(true)}
              onVideoFile={handlePublicationVideoFile}
              onImagePreparationChange={setMediaPreparing}
              onFieldError={setFieldError}
              onInfo={(message) => pushToast({ tone: 'info', title: message })}
            />
          </Suspense>

          {renderTiming()}

          {fieldError &&
          !fieldError.includes('получател') &&
          !fieldError.includes('текст') &&
          !fieldError.includes('фото') &&
          !fieldError.includes('видео') ? (
            <p className="publication-field-error publication-field-error--page" role="alert">
              {fieldError}
            </p>
          ) : null}

          <div className="publications-publish-bar">
            <BroadcastPublishBar
              title={
                editScope === 'retry'
                  ? 'Версия для повтора'
                  : editScope === 'future'
                    ? 'Будущие отправки'
                    : draft.timingMode === 'schedule'
                      ? 'Расписание'
                      : 'Публикация'
              }
              meta={formatTargetSummary(draft.targets)}
              issues={validationStarted ? validationIssues : []}
              busy={isBusy}
              showTest={!isPublisherProfile}
              testLabel="Отправить себе"
              compactTestLabel="Тест"
              testAriaLabel="Отправить публикацию себе"
              testDisabled={
                isBusy ||
                !hasContent ||
                videoNeedsReselection ||
                draft.targets.length === 0 ||
                hasButtonErrors
              }
              primaryLabel={primaryLabel}
              primaryDisabled={isBusy}
              onTest={handleTest}
              onPrimary={handlePrimaryAction}
            />
          </div>
        </div>

        <PublicationButtonsSheet
          open={buttonsOpen}
          buttons={draft.buttonEnabled ? draft.buttons : []}
          disabled={isBusy}
          onApply={(buttons) => {
            setDraft((current) => ({
              ...current,
              buttonEnabled: buttons.length > 0,
              buttons,
            }));
            setButtonsOpen(false);
          }}
          onClose={() => setButtonsOpen(false)}
        />

        <BroadcastPublishReviewSheet
          id="publication-review"
          open={pendingReview}
          text={draft.text}
          sourceFormat={draft.textFormat}
          hasMedia={hasMedia}
          facts={[
            `Кому · ${formatTargetSummary(draft.targets)}`,
            editScope === 'retry'
              ? 'Отправка · после ручного повтора'
              : `Когда · ${formatDraftTiming(draft)}`,
            visibleCustomButtonCount > 0 ? `Доп. кнопки · ${visibleCustomButtonCount}` : null,
            hasMedia
              ? draft.mediaType === 'video' ||
                draft.retainedAssets.some((asset) => asset.type === 'video')
                ? 'Видео'
                : 'Медиа'
              : null,
          ].filter((item): item is string => Boolean(item))}
          confirmLabel={primaryLabel}
          confirmBusyLabel="Сохраняем..."
          isBusy={isBusy}
          showExtraAction={!isPublisherProfile}
          extraActionBusy={testMutation.isPending}
          extraActionDisabled={
            isBusy ||
            !hasContent ||
            videoNeedsReselection ||
            draft.targets.length === 0 ||
            hasButtonErrors
          }
          onExtraAction={handleTest}
          onClose={() => !isBusy && setPendingReview(false)}
          onConfirm={() => {
            setPendingReview(false);
            submitPublication(false);
          }}
        />
      </>
    );
  }

  const cancelsFutureSends = Boolean(
    actionTarget?.action === 'cancel' &&
    getPublicationActionCapabilities(actionTarget.publication).hasFutureSends,
  );

  return (
    <div
      className={cn(
        'publications-page',
        isPublisherProfile && 'is-publisher',
        isEditor && 'is-editor',
        isEditorKeyboardOpen && 'is-keyboard-open',
      )}
    >
      {isEditor ? renderEditor() : isLegacyView ? renderLegacyHub() : renderHub()}

      <PublicationCreateSheet
        open={postImport.createSheetOpen}
        busy={postImport.createPending}
        onClose={closeCreateSheet}
        onWrite={openCreateEditor}
        onForward={postImport.startImport}
      />

      <ActionConfirmSheet
        id="publication-editor-close"
        open={pendingEditorClose}
        title="Закрыть без сохранения?"
        summary="Внесённые изменения будут потеряны."
        confirmLabel="Закрыть"
        cancelLabel="Остаться"
        tone="danger"
        isBusy={isBusy}
        onClose={() => setPendingEditorClose(false)}
        onConfirm={() => {
          setPendingEditorClose(false);
          restoreCreateDraftAndClose();
        }}
      />

      <ActionConfirmSheet
        id="publication-draft-clear"
        open={pendingDraftClear}
        title="Очистить черновик?"
        confirmLabel="Очистить"
        cancelLabel="Оставить"
        tone="danger"
        isBusy={isBusy}
        onClose={() => setPendingDraftClear(false)}
        onConfirm={confirmDraftClear}
      />

      <ActionConfirmSheet
        id="publication-revision-conflict"
        open={revisionConflictPublicationId !== null}
        title="Публикация изменилась"
        summary="Локальные правки будут перенесены в актуальную версию."
        confirmLabel="Обновить"
        cancelLabel="Остаться"
        tone="accent"
        isBusy={refreshEditedPublicationMutation.isPending}
        onClose={() =>
          !refreshEditedPublicationMutation.isPending && setRevisionConflictPublicationId(null)
        }
        onConfirm={() =>
          revisionConflictPublicationId &&
          refreshEditedPublicationMutation.mutate(revisionConflictPublicationId)
        }
      />

      <ActionConfirmSheet
        id="publication-conflict"
        open={pendingConflict}
        title="Есть пересечение"
        summary="Будут отменены только будущие отправки в совпадающее время для выбранных получателей. Уже опубликованные сообщения и другие даты останутся без изменений."
        previewTitle={formatDraftTiming(draft)}
        previewMeta={`Получатели: ${formatTargetSummary(draft.targets)}`}
        confirmLabel="Отменить и сохранить"
        cancelLabel="Другое время"
        tone="danger"
        isBusy={saveMutation.isPending}
        onClose={() => {
          setPendingConflict(false);
          setFieldError('Выберите другое время.');
        }}
        onConfirm={() => {
          setPendingConflict(false);
          submitPublication(true);
        }}
      />

      <ActionConfirmSheet
        id="publication-action"
        open={actionTarget !== null}
        title={
          actionTarget?.action === 'cancel'
            ? cancelsFutureSends
              ? 'Отменить будущие отправки?'
              : 'Отменить публикацию?'
            : actionTarget?.action === 'pause'
              ? 'Поставить на паузу?'
              : 'Запустить расписание?'
        }
        summary={
          cancelsFutureSends
            ? 'Будущие отправки отменятся, а ошибки нельзя будет повторить.'
            : undefined
        }
        previewTitle={
          actionTarget?.publication.title ? (
            actionTarget.publication.title
          ) : actionTarget?.publication.contentPreview ? (
            <MaxMarkdownPreview
              value={actionTarget.publication.contentPreview}
              sourceFormat={actionTarget.publication.contentPreviewFormat}
              normalizeWhitespace
            />
          ) : undefined
        }
        confirmLabel={
          actionTarget?.action === 'cancel'
            ? 'Отменить'
            : actionTarget?.action === 'pause'
              ? 'Пауза'
              : 'Запустить'
        }
        confirmBusyLabel="Сохраняем..."
        tone={actionTarget?.action === 'cancel' ? 'danger' : 'accent'}
        isBusy={actionMutation.isPending}
        onClose={() => !actionMutation.isPending && setActionTarget(null)}
        onConfirm={() => actionTarget && actionMutation.mutate(actionTarget)}
      />

      {detailsTarget ? (
        <Suspense fallback={null}>
          <LazyPublicationDetailsSheet
            api={api}
            publication={detailsTarget}
            allowEdit={isPublisherProfile}
            busy={anyBusy}
            covered={retryChoiceTarget !== null || ambiguousTarget !== null}
            publisherAccessRecheckBusy={scopedTargetRecheck.isBusy}
            publisherAccessRechecking={scopedTargetRecheck.isRechecking(detailsTarget.id)}
            onClose={() => setDetailsTarget(null)}
            onCancel={(publication) => {
              setDetailsTarget(null);
              setActionTarget({ publication, action: 'cancel' });
            }}
            onEdit={(publicationId) => {
              const publication =
                [...currentItems, ...scheduleItems, ...historyItems].find(
                  (item) => item.id === publicationId,
                ) ?? (detailsTarget.id === publicationId ? detailsTarget : null);
              if (publication) {
                openPublicationEditor(publication, 'edit');
              }
            }}
            onRecheckPublisherAccess={isPublisherProfile ? scopedTargetRecheck.recheck : undefined}
            onRetry={requestPublicationRetry}
            onResolveAmbiguous={(publicationId, occurrenceId, deliveryId, resolution) =>
              setAmbiguousTarget({ publicationId, occurrenceId, deliveryId, resolution })
            }
          />
        </Suspense>
      ) : null}

      <PublicationRetrySheet
        open={retryChoiceTarget !== null}
        originalRevision={retryChoiceTarget?.originalContentRevision}
        latestRevision={retryChoiceTarget?.latestContentRevision ?? 1}
        busy={retryMutation.isPending}
        onClose={() => !retryMutation.isPending && setRetryChoiceTarget(null)}
        onSelect={(contentMode) => {
          if (!retryChoiceTarget) {
            return;
          }
          if (contentMode === 'latest') {
            retryMutation.mutate({
              publicationId: retryChoiceTarget.publicationId,
              occurrenceId: retryChoiceTarget.occurrenceId,
              contentMode,
              expectedPublicationVersion: retryChoiceTarget.publicationVersion,
              expectedContentRevision: retryChoiceTarget.latestContentRevision,
            });
            return;
          }
          retryMutation.mutate({
            publicationId: retryChoiceTarget.publicationId,
            occurrenceId: retryChoiceTarget.occurrenceId,
            contentMode,
          });
        }}
      />

      <ActionConfirmSheet
        id="publication-resolve-ambiguous"
        open={ambiguousTarget !== null}
        title={
          ambiguousTarget?.resolution === 'mark_sent'
            ? 'Сообщение опубликовано?'
            : 'Сообщение не отправлено?'
        }
        summary="Это ручная проверка неоднозначной отправки."
        confirmLabel="Подтвердить"
        confirmBusyLabel="Сохраняем..."
        tone={ambiguousTarget?.resolution === 'mark_failed' ? 'danger' : 'accent'}
        isBusy={resolveAmbiguousMutation.isPending}
        onClose={() => !resolveAmbiguousMutation.isPending && setAmbiguousTarget(null)}
        onConfirm={() => ambiguousTarget && resolveAmbiguousMutation.mutate(ambiguousTarget)}
      />
    </div>
  );
}

export default PublicationsPage;
