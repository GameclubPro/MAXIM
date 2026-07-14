import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_PUBLICATION_TARGETS,
  MAX_PUBLICATION_VIDEO_BASE64_LENGTH,
  type ListLegacyPublicationsQuery,
  type PublicationLifecycle,
  type PublicationSummary,
} from '@maxim/contracts/publication';
import {
  FilterList,
  NavArrowLeft,
  Plus,
  Refresh,
  Search,
  Trash,
  VideoCamera,
  Xmark,
} from 'iconoir-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BroadcastButtonsSheet } from '../components/broadcast-buttons-sheet';
import { BroadcastContentComposer } from '../components/broadcast-content-composer';
import {
  BroadcastPublishBar,
  type BroadcastPublishIssueAction,
} from '../components/broadcast-publish-bar';
import { BroadcastPublishReviewSheet } from '../components/broadcast-publish-review-sheet';
import { BroadcastSchedulePlanner } from '../components/broadcast-schedule-planner';
import { ActionConfirmSheet } from '../components/ui/action-confirm-sheet';
import { StatusState } from '../components/ui/status-state';
import { TimeField } from '../components/ui/time-field';
import { useToast } from '../components/ui/toast';
import { PublicationDetailsSheet } from '../features/publications/publication-details-sheet';
import {
  PublicationFeedCard,
  type PublicationFeedTone,
} from '../features/publications/publication-feed-card';
import {
  buildCreatePublicationRequest,
  buildPublicationSaveFeedback,
  buildTestPublicationRequest,
  buildUpdatePublicationRequest,
  canResumePublication,
  createEmptyPublicationDraft,
  createPublicationDuplicateDraft,
  createPublicationDraftFromDetails,
  getPublicationTargetKey,
  getPublicationTargetTitle,
  hasFuturePublicationSlot,
  inferPublicationVideoMimeType,
  isIsolatedPublicationEditor,
  isPublicationDraftEmpty,
  PUBLICATION_TEXT_MAX_LENGTH,
  shouldReviewPublicationScheduleConflict,
  shouldPersistPublicationDraft,
  toPublicationTarget,
  type PublicationDraft,
  type PublicationEntityFilter,
  type PublicationStatusFilter,
  type PublicationTarget,
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
import { PublicationTargetPicker } from '../features/publications/publication-target-picker';
import { usePublicationComposer } from '../features/publications/use-publication-composer';
import { describeApiError } from '../lib/api-error';
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
import { getChats, getChannels } from '../lib/api/root-client';
import type { ApiTransport } from '../lib/api/transport';
import {
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
  formatLocalDateTimeInputValue,
  parseLocalDateTimeInputValue,
  sortAndUniqueBroadcastSlots,
} from '../lib/broadcast-schedule';
import { addDays, getBroadcastPlannerWindow, startOfDay } from '../lib/broadcast-planner-time';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import { maxImpact, maxNotify } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import '../styles/publications-page.css';
import '../features/publications/publication-workbench.css';

type PublicationEditorContext =
  | { kind: 'create' }
  | { kind: 'edit'; publicationId: string; expectedRevision: number }
  | { kind: 'duplicate' };

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

type LegacyPublicationView = ListLegacyPublicationsQuery['view'];
type LegacyPublicationKindFilter = ListLegacyPublicationsQuery['kind'];

function getPublicationCalendarRange(now = new Date()): { from: string; to: string } {
  const { start, end } = getBroadcastPlannerWindow(now);
  return { from: start.toISOString(), to: end.toISOString() };
}

const queryKeys = {
  sources: ['publications', 'sources'] as const,
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

const VIEW_OPTIONS: Array<{ value: PublicationView; label: string }> = [
  { value: 'plan', label: 'Активные' },
  { value: 'schedules', label: 'Расписание' },
  { value: 'history', label: 'История' },
];

const ENTITY_FILTERS: Array<{ value: PublicationEntityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'chat', label: 'Чаты' },
  { value: 'channel', label: 'Каналы' },
];

const LEGACY_VIEW_OPTIONS: Array<{ value: LegacyPublicationView; label: string }> = [
  { value: 'active', label: 'Активные' },
  { value: 'history', label: 'История' },
];

const LEGACY_KIND_FILTERS: Array<{ value: LegacyPublicationKindFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'autopost', label: 'Автопосты' },
  { value: 'broadcast', label: 'Отправки' },
];

const STATUS_FILTERS_BY_VIEW: Record<
  PublicationView,
  Array<{ value: PublicationStatusFilter; label: string }>
> = {
  plan: [
    { value: 'all', label: 'Все статусы' },
    { value: 'active', label: 'Активные' },
    { value: 'paused', label: 'На паузе' },
    { value: 'failed', label: 'С ошибкой' },
  ],
  schedules: [
    { value: 'all', label: 'Все статусы' },
    { value: 'active', label: 'Активные' },
    { value: 'paused', label: 'На паузе' },
    { value: 'failed', label: 'С ошибкой' },
  ],
  history: [
    { value: 'all', label: 'Вся история' },
    { value: 'completed', label: 'Завершённые и отменённые' },
  ],
};

const WEEKDAYS = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 7, label: 'Вс' },
] as const;

function normalizeView(value: string | null): PublicationView {
  return value === 'schedules' || value === 'history' ? value : 'plan';
}

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

function normalizeEntityType(value: string | null): 'chat' | 'channel' | null {
  return value === 'chat' || value === 'channel' ? value : null;
}

function formatDateTime(value: string | null, timezone = 'Europe/Moscow'): string {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
}

function formatDateInput(value: string | null): string {
  return value ? formatLocalDateTimeInputValue(value).slice(0, 10) : '';
}

function formatTargetSummary(targets: readonly PublicationTarget[]): string {
  if (targets.length === 0) {
    return 'Выберите получателей';
  }
  if (targets.length === 1) {
    return targets[0] ? getPublicationTargetTitle(targets[0]) : '1 получатель';
  }
  const channels = targets.filter((target) => target.entityType === 'channel').length;
  const chats = targets.length - channels;
  return [
    chats ? formatRussianCountLabel(chats, 'чат', 'чата', 'чатов') : '',
    channels ? formatRussianCountLabel(channels, 'канал', 'канала', 'каналов') : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function formatLoadedCount(count: number, hasMore: boolean): string {
  return `${count}${hasMore ? '+' : ''}`;
}

function formatPublicationTargets(publication: PublicationSummary): string {
  if (publication.targetCount === 0) {
    return 'Нет получателей';
  }
  if (publication.targetCount === 1) {
    return publication.targetPreviews[0]?.title ?? '1 получатель';
  }
  return formatRussianCountLabel(
    publication.targetCount,
    'получатель',
    'получателя',
    'получателей',
  );
}

function formatRecurrence(draft: PublicationDraft): string {
  if (
    !draft.recurrence.startsAt ||
    draft.recurrence.times.length === 0 ||
    (draft.recurrence.frequency === 'weekly' && draft.recurrence.weekdays.length === 0)
  ) {
    return 'Настройте повтор';
  }
  const interval = draft.recurrence.interval;
  const frequency =
    draft.recurrence.frequency === 'daily'
      ? interval === 1
        ? 'Каждый день'
        : `Каждые ${interval} дн.`
      : interval === 1
        ? 'Каждую неделю'
        : `Каждые ${interval} нед.`;
  return `${frequency} · ${draft.recurrence.times.join(', ')}`;
}

function formatDraftTiming(draft: PublicationDraft): string {
  if (draft.timingMode === 'now') {
    return 'Сейчас';
  }
  if (draft.timingMode === 'once') {
    return (
      formatDateTime(draft.scheduledSlots[0] ?? null, draft.scheduleTimezone) || 'Время не выбрано'
    );
  }
  if (draft.scheduleKind === 'recurrence') {
    return formatRecurrence(draft);
  }
  const slots = sortAndUniqueBroadcastSlots(draft.scheduledSlots);
  if (slots.length === 0) {
    return 'Время не выбрано';
  }
  return slots.length === 1
    ? formatDateTime(slots[0] ?? null, draft.scheduleTimezone)
    : formatRussianCountLabel(slots.length, 'отправка', 'отправки', 'отправок');
}

function formatPublicationSchedule(publication: PublicationSummary): string {
  const schedule = publication.schedule;
  if (!schedule) {
    return 'Черновик';
  }
  if (schedule.mode === 'now') {
    return 'Сейчас';
  }
  if (schedule.mode === 'once') {
    return `Следующая · ${formatDateTime(schedule.at, schedule.timezone)}`;
  }
  if (schedule.mode === 'slots') {
    if (schedule.nextOccurrenceAt) {
      return `Следующая · ${formatDateTime(schedule.nextOccurrenceAt, schedule.timezone)}`;
    }
    return formatRussianCountLabel(schedule.slots.length, 'отправка', 'отправки', 'отправок');
  }
  const interval = schedule.interval;
  const frequency =
    schedule.frequency === 'daily'
      ? interval === 1
        ? 'Каждый день'
        : `Каждые ${interval} дн.`
      : interval === 1
        ? 'Каждую неделю'
        : `Каждые ${interval} нед.`;
  const next = schedule.nextOccurrenceAt
    ? `Следующая · ${formatDateTime(schedule.nextOccurrenceAt, schedule.timezone)}`
    : '';
  return next || `${frequency} · ${schedule.times.join(', ')}`;
}

function getLifecycleLabel(lifecycle: PublicationLifecycle): string {
  const labels: Record<PublicationLifecycle, string> = {
    DRAFT: 'Черновик',
    ACTIVE: 'Активно',
    PAUSED: 'Пауза',
    COMPLETED: 'Готово',
    CANCELED: 'Отменено',
    ERROR: 'Ошибка',
  };
  return labels[lifecycle];
}

function getLifecycleTone(publication: PublicationSummary): PublicationFeedTone {
  if (publication.lifecycle === 'ERROR' || publication.delivery.ambiguous > 0) {
    return 'danger';
  }
  if (publication.lifecycle === 'PAUSED' || publication.delivery.failed > 0) {
    return 'warning';
  }
  if (publication.lifecycle === 'COMPLETED' || publication.lifecycle === 'CANCELED') {
    return 'muted';
  }
  return 'active';
}

function isSchedulePublication(publication: PublicationSummary): boolean {
  return publication.schedule?.mode === 'slots' || publication.schedule?.mode === 'recurrence';
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/gu, '');
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

const MAX_PUBLICATION_VIDEO_FILE_BYTES = 24_000_000;

function readVideoFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать видео.'));
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separatorIndex = value.indexOf(',');
      const base64 = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : '';
      if (!base64) {
        reject(new Error('Видео пустое или повреждено.'));
        return;
      }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

export function PublicationsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [editorContext, setEditorContext] = useState<PublicationEditorContext | null>(null);
  const isEditor = editorContext !== null;
  const legacyRouteRequested = searchParams.get('legacy') === '1';
  const isLegacyView = legacyRouteRequested && !isEditor;
  const persistenceEnabled = shouldPersistPublicationDraft(editorContext?.kind ?? null);
  const { draft, setDraft, hydrated, hasSavedDraft, clearDraft } = usePublicationComposer(
    isEditor,
    persistenceEnabled,
  );
  const savedCreateDraftRef = useRef<PublicationDraft | null>(null);
  const initialRouteAppliedRef = useRef(false);
  const [view, setView] = useState<PublicationView>(() => normalizeView(searchParams.get('view')));
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [entityFilter, setEntityFilter] = useState<PublicationEntityFilter>('all');
  const [statusFilter, setStatusFilter] = useState<PublicationStatusFilter>('all');
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
  const [buttonErrors, setButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>([]);
  const [fieldError, setFieldError] = useState('');
  const [videoPreparing, setVideoPreparing] = useState(false);
  const [pendingReview, setPendingReview] = useState(false);
  const [pendingConflict, setPendingConflict] = useState(false);
  const [actionTarget, setActionTarget] = useState<PublicationActionTarget | null>(null);
  const [detailsTarget, setDetailsTarget] = useState<PublicationSummary | null>(null);
  const [ambiguousTarget, setAmbiguousTarget] = useState<PublicationAmbiguousTarget | null>(null);
  const contentSectionRef = useRef<HTMLElement | null>(null);
  const targetsSectionRef = useRef<HTMLElement | null>(null);
  const timingSectionRef = useRef<HTMLElement | null>(null);

  const sourcesQuery = useQuery({
    queryKey: queryKeys.sources,
    queryFn: async () => {
      const [chats, channels] = await Promise.all([
        getChats(api, { fresh: false }),
        getChannels(api, { fresh: false }),
      ]);
      return [...chats, ...channels].map(toPublicationTarget);
    },
  });
  const targets = sourcesQuery.data ?? [];
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
    editorContext?.kind === 'edit' ? editorContext.publicationId : null;
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
    enabled: !isEditor,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const legacyHistoryProbeQuery = useQuery({
    queryKey: queryKeys.legacyProbe('history'),
    queryFn: () => listLegacyPublications(api, { view: 'history', limit: 1 }),
    enabled: !isEditor,
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
    enabled: isLegacyView,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const planQuery = useInfiniteQuery({
    queryKey: queryKeys.list('plan', debouncedQuery, entityFilter, statusFilter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listPublications(api, {
        view: 'plan',
        query: debouncedQuery,
        entityType: listEntityType,
        status: listStatus,
        limit: PUBLICATION_LIST_PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !isEditor && !isLegacyView && view === 'plan',
    refetchInterval: (query) => {
      const items = query.state.data?.pages.flatMap((page) => page.items) ?? [];
      return items.some(
        (item) =>
          item.delivery.pending > 0 ||
          (item.lifecycle === 'ACTIVE' &&
            item.schedule?.mode === 'now' &&
            item.delivery.total === 0),
      )
        ? 5_000
        : false;
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
    refetchInterval: 10_000,
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
    refetchInterval: 10_000,
  });
  const planItems = useMemo(
    () => mergePublicationPages(planQuery.data?.pages),
    [planQuery.data?.pages],
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
  const showLegacyEntry = legacyKnownCount > 0 || (legacyProbeComplete && legacyProbeHasError);
  const legacyEntryCount =
    legacyKnownCount > 0
      ? legacyKnownCount
      : legacyActiveCount !== null && legacyHistoryCount !== null
        ? 0
        : null;
  const legacyCurrentTotal = legacyListQuery.data?.pages[0]?.totalCount ?? null;

  const saveMutation = useMutation({
    mutationFn: ({ replaceConflicts }: { replaceConflicts: boolean }) => {
      if (editorContext?.kind === 'edit') {
        return updatePublication(
          api,
          editorContext.publicationId,
          buildUpdatePublicationRequest(
            draft,
            editorContext.expectedRevision,
            createRequestId(),
            replaceConflicts,
          ),
        );
      }
      return createPublication(
        api,
        buildCreatePublicationRequest(draft, createRequestId(), { replaceConflicts }),
      );
    },
    onSuccess: async (publication) => {
      await invalidatePublicationQueries();
      const feedback = buildPublicationSaveFeedback(publication, {
        editorKind: editorContext?.kind ?? null,
        timingMode: draft.timingMode,
      });
      pushToast(feedback);
      maxNotify(feedback.notification);
      if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
        restoreCreateDraftAndClose();
      } else {
        void clearDraft();
        closeEditor(false);
      }
    },
    onError: (error, variables) => {
      if (shouldReviewPublicationScheduleConflict(error, draft, variables.replaceConflicts)) {
        setPendingConflict(true);
        return;
      }
      pushToast({
        tone: 'danger',
        title: describeApiError(error, 'Не удалось сохранить публикацию'),
      });
      maxNotify('error');
    },
  });
  const testMutation = useMutation({
    mutationFn: () => testPublication(api, buildTestPublicationRequest(draft, createRequestId())),
    onSuccess: () => {
      pushToast({ tone: 'success', title: 'Отправлено вам' });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({ tone: 'danger', title: describeApiError(error, 'Не удалось отправить тест') });
      maxNotify('error');
    },
  });
  const openPublicationMutation = useMutation({
    mutationFn: ({
      publication,
      mode,
    }: {
      publication: PublicationSummary;
      mode: 'edit' | 'duplicate';
    }) => getPublication(api, publication.id).then((details) => ({ details, mode })),
    onSuccess: ({ details, mode }) => {
      savedCreateDraftRef.current = draft;
      const sourceDraft = createPublicationDraftFromDetails(details);
      setDraft(mode === 'duplicate' ? createPublicationDuplicateDraft(sourceDraft) : sourceDraft);
      setEditorContext(
        mode === 'edit'
          ? { kind: 'edit', publicationId: details.id, expectedRevision: details.version }
          : { kind: 'duplicate' },
      );
      setButtonErrors(
        validateBroadcastLinkButtons(
          details.content.buttons.map(({ text, url }) => ({ text, url })),
        ),
      );
      setDetailsTarget(null);
      setFieldError('');
      setComposeRoute(true);
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeApiError(error, 'Не удалось открыть публикацию'),
      }),
  });
  const actionMutation = useMutation({
    mutationFn: ({ publication, action }: PublicationActionTarget) => {
      const payload = { expectedRevision: publication.version, requestId: createRequestId() };
      if (action === 'cancel') {
        return cancelPublication(api, publication.id, payload);
      }
      return action === 'pause'
        ? pausePublication(api, publication.id, payload)
        : resumePublication(api, publication.id, payload);
    },
    onSuccess: async (_, variables) => {
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
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeApiError(error, 'Не удалось выполнить действие'),
      }),
  });
  const retryMutation = useMutation({
    mutationFn: ({
      publicationId,
      occurrenceId,
    }: {
      publicationId: string;
      occurrenceId: string;
    }) =>
      retryPublicationOccurrence(api, publicationId, occurrenceId, {
        requestId: createRequestId(),
      }),
    onSuccess: async () => {
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Повтор поставлен в очередь' });
    },
    onError: (error) =>
      pushToast({
        tone: 'danger',
        title: describeApiError(error, 'Не удалось повторить отправку'),
      }),
  });
  const resolveAmbiguousMutation = useMutation({
    mutationFn: (target: PublicationAmbiguousTarget) =>
      resolvePublicationAmbiguousDelivery(api, target.publicationId, target.occurrenceId, {
        requestId: createRequestId(),
        deliveryId: target.deliveryId,
        resolution: target.resolution,
      }),
    onSuccess: async () => {
      setAmbiguousTarget(null);
      await Promise.all([
        invalidatePublicationQueries(),
        queryClient.invalidateQueries({ queryKey: ['publications', 'details'] }),
        queryClient.invalidateQueries({ queryKey: ['publications', 'deliveries'] }),
      ]);
      pushToast({ tone: 'success', title: 'Статус доставки сохранён' });
    },
    onError: (error) =>
      pushToast({ tone: 'danger', title: describeApiError(error, 'Не удалось сохранить статус') }),
  });

  const visibleItems =
    view === 'history' ? historyItems : view === 'schedules' ? scheduleItems : planItems;
  const currentListQuery =
    view === 'history' ? historyQuery : view === 'schedules' ? schedulesQuery : planQuery;
  const visibleButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const hasMedia =
    draft.images.length > 0 || draft.mediaType === 'video' || draft.retainedAssets.length > 0;
  const hasContent = Boolean(draft.text.trim() || hasMedia);
  const hasButtonErrors =
    draft.buttonEnabled &&
    hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(draft.buttons));
  const isBusy =
    saveMutation.isPending ||
    testMutation.isPending ||
    openPublicationMutation.isPending ||
    actionMutation.isPending ||
    retryMutation.isPending ||
    videoPreparing;
  const anyBusy = isBusy || resolveAmbiguousMutation.isPending;
  const recurrenceError = getRecurrenceError(draft);
  const validationIssues = useMemo<BroadcastPublishIssueAction[]>(() => {
    const issues: BroadcastPublishIssueAction[] = [];
    if (!hasContent) {
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
    }
    if (
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
  }, [draft, hasButtonErrors, hasContent, recurrenceError]);

  useEffect(() => {
    document.body.classList.toggle('publications-editor-open', isEditor);
    return () => document.body.classList.remove('publications-editor-open');
  }, [isEditor]);

  useEffect(() => {
    if (!hydrated || !sourcesQuery.isSuccess || initialRouteAppliedRef.current) {
      return;
    }
    initialRouteAppliedRef.current = true;
    const entityType =
      normalizeEntityType(searchParams.get('entityType')) ??
      normalizeEntityType(searchParams.get('sourceType'));
    const entityId = searchParams.get('entityId') ?? searchParams.get('sourceId') ?? '';
    const routeTarget = targets.find(
      (target) => target.id === entityId && (!entityType || target.entityType === entityType),
    );
    if (routeTarget) {
      setDraft((current) =>
        current.targets.some(
          (target) => getPublicationTargetKey(target) === getPublicationTargetKey(routeTarget),
        )
          ? current
          : {
              ...current,
              targets: isPublicationDraftEmpty(current)
                ? [routeTarget]
                : [...current.targets, routeTarget],
            },
      );
    }
    if (searchParams.get('compose') === '1') {
      setEditorContext({ kind: 'create' });
    }
  }, [draft, hydrated, searchParams, setDraft, sourcesQuery.isSuccess, targets]);

  useEffect(() => {
    if (!sourcesQuery.isSuccess || targets.length === 0) {
      return;
    }

    setDraft((current) => {
      let changed = false;
      const refreshedTargets = current.targets.map((target) => {
        const currentTarget = targets.find(
          (candidate) => getPublicationTargetKey(candidate) === getPublicationTargetKey(target),
        );
        if (
          !currentTarget ||
          (currentTarget.title === target.title && currentTarget.avatarUrl === target.avatarUrl)
        ) {
          return target;
        }
        changed = true;
        return currentTarget;
      });

      return changed ? { ...current, targets: refreshedTargets } : current;
    });
  }, [draft.targets, setDraft, sourcesQuery.isSuccess, targets]);

  useNativeBackHandler(
    () => {
      closeEditor(true);
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

  function setComposeRoute(open: boolean) {
    const next = new URLSearchParams(searchParams);
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
    setView(nextView);
    if (!STATUS_FILTERS_BY_VIEW[nextView].some((filter) => filter.value === statusFilter)) {
      setStatusFilter('all');
    }
    const next = new URLSearchParams(searchParams);
    if (nextView === 'plan') {
      next.delete('view');
    } else {
      next.set('view', nextView);
    }
    setSearchParams(next, { replace: true });
    maxImpact('soft');
  }

  function focusEditorSection(section: 'content' | 'targets' | 'timing', message: string) {
    setFieldError(message);
    const target =
      section === 'content'
        ? contentSectionRef.current
        : section === 'targets'
          ? targetsSectionRef.current
          : timingSectionRef.current;
    window.requestAnimationFrame(() =>
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  }

  function openCreateEditor() {
    setEditorContext({ kind: 'create' });
    setButtonErrors(validateBroadcastLinkButtons(draft.buttons));
    setFieldError('');
    setComposeRoute(true);
    maxImpact('soft');
  }

  function closeEditor(preserveDraft: boolean) {
    if (isIsolatedPublicationEditor(editorContext?.kind ?? null)) {
      restoreCreateDraftAndClose();
      return;
    }
    setEditorContext(null);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setFieldError('');
    setComposeRoute(false);
    if (!preserveDraft) {
      savedCreateDraftRef.current = null;
    }
  }

  function restoreCreateDraftAndClose() {
    if (savedCreateDraftRef.current) {
      setDraft(savedCreateDraftRef.current);
    }
    savedCreateDraftRef.current = null;
    setEditorContext(null);
    setButtonsOpen(false);
    setPendingReview(false);
    setPendingConflict(false);
    setFieldError('');
    setComposeRoute(false);
  }

  function validateDraft(options: { ignoreSchedule?: boolean } = {}): boolean {
    const nextButtonErrors = validateBroadcastLinkButtons(draft.buttons);
    setButtonErrors(nextButtonErrors);
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
    if (!options.ignoreSchedule) {
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

  function handlePrimaryAction() {
    if (validateDraft()) {
      setPendingReview(true);
      return;
    }
    validationIssues[0]?.onClick();
  }

  function handleTest() {
    if (testMutation.isPending) {
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
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Найти"
              aria-label="Поиск публикаций"
            />
            {query ? (
              <button type="button" onClick={() => setQuery('')} aria-label="Очистить поиск">
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
                  onClick={() => setEntityFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <select
              value={statusFilter}
              onChange={(event) =>
                setStatusFilter(event.currentTarget.value as PublicationStatusFilter)
              }
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
    const pending =
      (actionMutation.isPending && actionMutation.variables?.publication.id === publication.id) ||
      (openPublicationMutation.isPending &&
        openPublicationMutation.variables?.publication.id === publication.id);
    const canEdit = publication.lifecycle !== 'COMPLETED' && publication.lifecycle !== 'CANCELED';
    return (
      <PublicationFeedCard
        key={publication.id}
        id={publication.id}
        title={publication.title || formatPublicationTargets(publication)}
        preview={publication.contentPreview}
        fallback={
          publication.hasVideo
            ? 'Видео без текста'
            : publication.mediaCount > 0
              ? 'Фото без текста'
              : null
        }
        eyebrow={getLifecycleLabel(publication.lifecycle)}
        tone={getLifecycleTone(publication)}
        busy={pending}
        meta={[formatPublicationTargets(publication), formatPublicationSchedule(publication)]}
        primaryAction={{ label: 'Открыть детали', onClick: () => setDetailsTarget(publication) }}
        canEdit={canEdit}
        canPause={publication.lifecycle === 'ACTIVE' && isSchedulePublication(publication)}
        canResume={canResumePublication(publication.lifecycle)}
        canRetry={publication.delivery.failed > 0 || publication.delivery.ambiguous > 0}
        canDuplicate
        canCancel={publication.lifecycle !== 'COMPLETED' && publication.lifecycle !== 'CANCELED'}
        onEdit={() => openPublicationMutation.mutate({ publication, mode: 'edit' })}
        onPause={() => setActionTarget({ publication, action: 'pause' })}
        onResume={() => setActionTarget({ publication, action: 'resume' })}
        onRetry={() => setDetailsTarget(publication)}
        onDuplicate={() => openPublicationMutation.mutate({ publication, mode: 'duplicate' })}
        onCancel={() => setActionTarget({ publication, action: 'cancel' })}
        footer={
          publication.delivery.ambiguous > 0 ? (
            <span className="publication-delivery-note is-danger">Проверьте отправку</span>
          ) : publication.delivery.failed > 0 || publication.delivery.canceled > 0 ? (
            <span className="publication-delivery-note is-danger">
              Есть недоставленные сообщения
            </span>
          ) : publication.delivery.sent > 0 ? (
            <span className="publication-delivery-note">
              Доставлено {publication.delivery.sent} из {publication.delivery.total}
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
            description={describeApiError(currentListQuery.error, 'Повторите ещё раз.')}
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
              {query || entityFilter !== 'all' || statusFilter !== 'all'
                ? 'Ничего не найдено'
                : view === 'history'
                  ? 'История пока пустая'
                  : view === 'schedules'
                    ? 'Расписаний пока нет'
                    : 'Активных постов нет'}
            </strong>
            {view !== 'history' && !query ? (
              <button type="button" className="publications-primary" onClick={openCreateEditor}>
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

  function renderHub() {
    return (
      <>
        <header className="publications-header">
          <div>
            <h1>Посты</h1>
          </div>
          <button
            type="button"
            className="publications-primary"
            onClick={openCreateEditor}
            aria-label="Создать публикацию"
            title="Создать публикацию"
          >
            <Plus aria-hidden />
            <span>Создать</span>
          </button>
        </header>

        <div className="publications-tabs" role="group" aria-label="Раздел постов">
          {VIEW_OPTIONS.map((option) =>
            (() => {
              const count =
                option.value === 'plan'
                  ? planQuery.data
                    ? formatLoadedCount(planItems.length, Boolean(planQuery.hasNextPage))
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

        {hasSavedDraft ? (
          <button type="button" className="publication-draft-resume" onClick={openCreateEditor}>
            <span>
              <strong>Черновик</strong>
              <small>{draft.text.trim() || formatTargetSummary(draft.targets)}</small>
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
            <h1>Ранее созданные</h1>
            {legacyCurrentTotal !== null ? (
              <small>
                {formatRussianCountLabel(legacyCurrentTotal, 'запись', 'записи', 'записей')}
              </small>
            ) : null}
          </span>
        </header>

        <div className="legacy-publications-tabs" role="group" aria-label="Ранее созданные посты">
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
            description={describeApiError(legacyListQuery.error, 'Повторите ещё раз.')}
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

        <label className="publication-recurrence__interval">
          <span>Интервал</span>
          <input
            type="number"
            min={1}
            max={31}
            value={draft.recurrence.interval}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                recurrence: {
                  ...current.recurrence,
                  interval: Math.max(1, Math.min(31, Number(event.currentTarget.value) || 1)),
                },
              }))
            }
            disabled={isBusy}
          />
          <small>{draft.recurrence.frequency === 'daily' ? 'дней' : 'недель'}</small>
        </label>

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
          <small>{formatDraftTiming(draft)}</small>
        </div>
        <div className="publication-timing-tabs" role="group" aria-label="Время публикации">
          {(
            [
              { value: 'now', label: 'Сейчас' },
              { value: 'once', label: 'Один раз' },
              { value: 'schedule', label: 'По расписанию' },
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
              <BroadcastSchedulePlanner
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
    setVideoPreparing(true);
    try {
      const mediaMimeType = inferPublicationVideoMimeType(file.name, file.type);
      if (!mediaMimeType) {
        throw new Error('Выберите видеофайл.');
      }
      if (file.size > MAX_PUBLICATION_VIDEO_FILE_BYTES) {
        throw new Error('Видео слишком большое. Максимум 24 МБ.');
      }
      const mediaBase64 = await readVideoFileBase64(file);
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
      setFieldError('');
    } catch (error) {
      pushToast({
        tone: 'info',
        title: error instanceof Error ? error.message : 'Не удалось подготовить видео.',
      });
    } finally {
      setVideoPreparing(false);
    }
  }

  function renderEditor() {
    const editing = editorContext?.kind === 'edit';
    const duplicating = editorContext?.kind === 'duplicate';
    const retainedVideo = draft.retainedAssets.some((asset) => asset.type === 'video');
    const retainedImages = draft.retainedAssets.filter((asset) => asset.type === 'image').length;
    const primaryLabel = editing
      ? 'Сохранить'
      : draft.timingMode === 'now'
        ? 'Опубликовать'
        : draft.timingMode === 'once'
          ? 'Запланировать'
          : 'Сохранить расписание';
    return (
      <>
        <header className="publications-editor-header">
          <button type="button" onClick={() => closeEditor(true)} aria-label="Назад" title="Назад">
            <NavArrowLeft aria-hidden />
          </button>
          <span>
            <h1>{editing ? 'Редактирование' : 'Новый пост'}</h1>
          </span>
          <button
            type="button"
            onClick={() => {
              if (duplicating) {
                setDraft(createEmptyPublicationDraft());
                setButtonErrors([]);
                setFieldError('');
                return;
              }
              void clearDraft();
            }}
            aria-label="Очистить черновик"
            title="Очистить"
            disabled={isBusy || editing}
          >
            <Trash aria-hidden />
          </button>
        </header>

        <div className="publications-editor">
          <section ref={targetsSectionRef} className="publication-editor-section">
            <div className="publication-editor-section__head">
              <strong>Получатели</strong>
            </div>
            <PublicationTargetPicker
              choices={targets}
              value={draft.targets}
              disabled={isBusy || sourcesQuery.isLoading}
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

          <section
            ref={contentSectionRef}
            className="publication-editor-section publication-editor-section--content"
          >
            <div className="publication-editor-section__head">
              <strong>Пост</strong>
              <small>
                {draft.text.length}/{PUBLICATION_TEXT_MAX_LENGTH}
              </small>
            </div>
            {draft.timingMode === 'schedule' ? (
              <input
                className="publication-title-input"
                value={draft.title}
                maxLength={120}
                placeholder="Название расписания"
                onChange={(event) =>
                  setDraft((current) => ({ ...current, title: event.currentTarget.value }))
                }
                disabled={isBusy}
              />
            ) : null}
            {draft.retainedAssets.length > 0 ? (
              <div className="publication-retained-media">
                <span>
                  {retainedVideo ? 'Сохранено видео' : `Сохранено фото: ${retainedImages}`}
                </span>
                <button
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, retainedAssets: [] }))}
                  disabled={isBusy}
                  aria-label="Убрать сохранённое медиа"
                >
                  <Xmark aria-hidden />
                </button>
              </div>
            ) : null}
            <label
              className={cn(
                'publication-video-picker',
                (isBusy || videoPreparing) && 'is-disabled',
                draft.mediaType === 'video' && 'is-active',
              )}
              aria-disabled={isBusy || videoPreparing}
            >
              <VideoCamera aria-hidden />
              <span>{videoPreparing ? 'Готовим видео' : 'Добавить видео'}</span>
              <input
                type="file"
                accept="video/*"
                aria-label="Выбрать видео для публикации"
                disabled={isBusy || videoPreparing}
                onChange={(event) => {
                  const input = event.currentTarget;
                  void handlePublicationVideoFile(input.files?.[0]).finally(() => {
                    input.value = '';
                  });
                }}
              />
            </label>
            <BroadcastContentComposer
              className="publication-content-composer"
              text={draft.text}
              maxLength={PUBLICATION_TEXT_MAX_LENGTH}
              images={draft.images}
              buttons={visibleButtons}
              buttonsStatusLabel="Кнопки"
              buttonsActive={visibleButtons.length > 0}
              buttonsError={hasButtonErrors}
              videoLabel={
                draft.mediaType === 'video'
                  ? draft.mediaFileName || 'Видео'
                  : retainedVideo
                    ? 'Видео'
                    : null
              }
              disabled={isBusy}
              textError={
                fieldError.includes('текст') || fieldError.includes('фото') ? fieldError : ''
              }
              textPlaceholder="Текст публикации"
              messageAriaLabel="Текст публикации"
              onTextChange={(text) => {
                setDraft((current) => ({ ...current, text }));
                setFieldError('');
              }}
              onImagesChange={(images) =>
                setDraft((current) => ({
                  ...current,
                  images,
                  retainedAssets: [],
                  mediaType: current.mediaType === 'video' ? null : current.mediaType,
                  mediaPayload: current.mediaType === 'video' ? null : current.mediaPayload,
                  mediaBase64: current.mediaType === 'video' ? '' : current.mediaBase64,
                  mediaMimeType: current.mediaType === 'video' ? '' : current.mediaMimeType,
                  mediaFileName: current.mediaType === 'video' ? '' : current.mediaFileName,
                }))
              }
              onOpenButtons={() => setButtonsOpen(true)}
              onClearVideo={() =>
                setDraft((current) => ({
                  ...current,
                  retainedAssets: current.retainedAssets.filter((asset) => asset.type !== 'video'),
                  mediaType: null,
                  mediaPayload: null,
                  mediaBase64: '',
                  mediaMimeType: '',
                  mediaFileName: '',
                }))
              }
              onError={(message) => pushToast({ tone: 'info', title: message })}
            />
          </section>

          {renderTiming()}

          {fieldError &&
          !fieldError.includes('получател') &&
          !fieldError.includes('текст') &&
          !fieldError.includes('фото') ? (
            <p className="publication-field-error publication-field-error--page" role="alert">
              {fieldError}
            </p>
          ) : null}
        </div>

        <BroadcastButtonsSheet
          open={buttonsOpen}
          api={api}
          enabled={draft.buttonEnabled}
          buttons={draft.buttons}
          errors={buttonErrors}
          disabled={isBusy}
          onEnabledChange={(buttonEnabled) =>
            setDraft((current) => ({
              ...current,
              buttonEnabled,
              buttons:
                buttonEnabled && current.buttons.length === 0
                  ? [{ text: 'Открыть', url: '' }]
                  : current.buttons,
            }))
          }
          onChange={(buttons) => {
            setDraft((current) => ({ ...current, buttons }));
            setButtonErrors(validateBroadcastLinkButtons(buttons));
          }}
          onClose={() => setButtonsOpen(false)}
        />

        <div className="publications-publish-bar">
          <BroadcastPublishBar
            title={
              editing ? 'Изменения' : draft.timingMode === 'schedule' ? 'Расписание' : 'Публикация'
            }
            meta={formatTargetSummary(draft.targets)}
            issues={validationIssues}
            busy={isBusy}
            testLabel="Отправить себе"
            compactTestLabel="Тест"
            testAriaLabel="Отправить публикацию себе"
            testDisabled={isBusy || !hasContent || draft.targets.length === 0 || hasButtonErrors}
            primaryLabel={primaryLabel}
            primaryDisabled={isBusy}
            onTest={handleTest}
            onPrimary={handlePrimaryAction}
          />
        </div>

        <BroadcastPublishReviewSheet
          id="publication-review"
          open={pendingReview}
          text={draft.text}
          hasMedia={hasMedia}
          facts={[
            `Кому · ${formatTargetSummary(draft.targets)}`,
            `Когда · ${formatDraftTiming(draft)}`,
            visibleButtons.length > 0 ? `Кнопки · ${visibleButtons.length}` : 'Кнопки · нет',
            hasMedia
              ? draft.retainedAssets.some((asset) => asset.type === 'video')
                ? 'Видео'
                : 'Медиа'
              : null,
          ].filter((item): item is string => Boolean(item))}
          confirmLabel={primaryLabel}
          confirmBusyLabel="Сохраняем..."
          isBusy={saveMutation.isPending}
          extraActionBusy={testMutation.isPending}
          extraActionDisabled={!hasContent || draft.targets.length === 0 || hasButtonErrors}
          onExtraAction={handleTest}
          onClose={() => !saveMutation.isPending && setPendingReview(false)}
          onConfirm={() => {
            setPendingReview(false);
            saveMutation.mutate({ replaceConflicts: false });
          }}
        />
      </>
    );
  }

  const cancelsFutureSends = Boolean(
    actionTarget?.action === 'cancel' &&
    actionTarget.publication.schedule &&
    actionTarget.publication.schedule.mode !== 'now',
  );

  return (
    <div className={cn('publications-page', isEditor && 'is-editor')}>
      {isEditor ? (
        renderEditor()
      ) : isLegacyView ? (
        renderLegacyHub()
      ) : sourcesQuery.isError ? (
        <StatusState
          tone="danger"
          title="Не удалось загрузить чаты и каналы"
          description={describeApiError(sourcesQuery.error, 'Обновите экран.')}
          action={
            <button
              type="button"
              className="button button--ghost"
              onClick={() => void sourcesQuery.refetch()}
            >
              Обновить
            </button>
          }
        />
      ) : (
        renderHub()
      )}

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
          saveMutation.mutate({ replaceConflicts: true });
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
        previewTitle={actionTarget?.publication.title || actionTarget?.publication.contentPreview}
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

      <PublicationDetailsSheet
        api={api}
        publication={detailsTarget}
        busy={anyBusy}
        onClose={() => setDetailsTarget(null)}
        onCancel={(publication) => {
          setDetailsTarget(null);
          setActionTarget({ publication, action: 'cancel' });
        }}
        onEdit={(publicationId) => {
          const publication =
            [...planItems, ...scheduleItems, ...historyItems].find(
              (item) => item.id === publicationId,
            ) ?? (detailsTarget?.id === publicationId ? detailsTarget : null);
          if (publication) {
            openPublicationMutation.mutate({ publication, mode: 'edit' });
          }
        }}
        onRetry={(publicationId, occurrenceId) =>
          retryMutation.mutate({ publicationId, occurrenceId })
        }
        onResolveAmbiguous={(publicationId, occurrenceId, deliveryId, resolution) =>
          setAmbiguousTarget({ publicationId, occurrenceId, deliveryId, resolution })
        }
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

function getRecurrenceError(draft: PublicationDraft): string {
  if (!draft.recurrence.startsAt) {
    return 'Выберите дату начала.';
  }
  if (!Number.isFinite(Date.parse(draft.recurrence.startsAt))) {
    return 'Выберите корректную дату начала.';
  }
  if (draft.recurrence.times.length === 0) {
    return 'Добавьте хотя бы одно время.';
  }
  if (draft.recurrence.frequency === 'weekly' && draft.recurrence.weekdays.length === 0) {
    return 'Выберите хотя бы один день недели.';
  }
  if (new Set(draft.recurrence.times).size !== draft.recurrence.times.length) {
    return 'Время не должно повторяться.';
  }
  if (
    draft.recurrence.startsAt &&
    draft.recurrence.endsAt &&
    Date.parse(draft.recurrence.endsAt) <= Date.parse(draft.recurrence.startsAt)
  ) {
    return 'Дата завершения должна быть позже даты начала.';
  }
  return '';
}

export default PublicationsPage;
