import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type {
  BroadcastImage,
  BroadcastLinkButton,
  BroadcastTargetMode,
  ChatSummary,
  ManagedAutopostHubRuleDetails,
  ManagedAutopostHubRuleSummary,
  ManagedAutopostRuleStatus,
  ManagedEntityType,
} from '@maxim/contracts';
import {
  NavArrowLeft as IconoirArrowLeft,
  Plus as IconoirPlus,
  Trash as IconoirTrash,
} from 'iconoir-react';
import { BroadcastAudienceControls } from '../components/broadcast-audience-controls';
import { BroadcastButtonsSheet } from '../components/broadcast-buttons-sheet';
import { BroadcastContentComposer } from '../components/broadcast-content-composer';
import {
  BroadcastPublishBar,
  type BroadcastPublishIssueAction,
} from '../components/broadcast-publish-bar';
import { BroadcastSchedulePlanner } from '../components/broadcast-schedule-planner';
import { ManagedAutopostRuleCard } from '../components/managed-autopost-rule-card';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import {
  createAutopostRule,
  deleteAutopostRule,
  getAutopostRule,
  getAutopostRules,
  sendAutopostTest,
  updateAutopostRule,
} from '../lib/api/autopost-client';
import { getManagedBroadcastCalendar, getManagedBroadcasts } from '../lib/api/chat-settings-client';
import {
  getChannelManagedBroadcastCalendar,
  getChannelManagedBroadcasts,
} from '../lib/api/channel-settings-client';
import { getChats, getChannels } from '../lib/api/root-client';
import type { SendBroadcastPayload } from '../lib/api/shared-types';
import type { ApiTransport } from '../lib/api/transport';
import {
  buildBroadcastLinkButtonLegacyFields,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import { cn } from '../lib/cn';
import {
  buildManagedAutopostRuleFacts,
  normalizeManagedAutopostPayload,
  sortManagedAutopostRules,
} from '../lib/managed-autopost-ui';
import { maxImpact } from '../lib/max-bridge';
import { useNativeBackHandler } from '../lib/native-back';
import '../styles/autoposts-page.css';

type AutopostStatusFilter =
  | 'all'
  | Extract<ManagedAutopostRuleStatus, 'ACTIVE' | 'PAUSED' | 'ERROR'>;

type AutopostDraft = {
  sourceChatId: string;
  entityType: ManagedEntityType;
  title: string;
  text: string;
  images: BroadcastImage[];
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  scheduleTimezone: string;
  scheduledSlots: string[];
  mediaType: 'image' | 'video' | null;
  mediaPayload: Record<string, unknown> | null;
  mediaMimeType: string;
  mediaFileName: string;
};

type AutopostSources = {
  chats: ChatSummary[];
  channels: ChatSummary[];
};

const TEXT_MAX_LENGTH = 2_000;
const MIN_SLOT_DELAY_MS = 2 * 60_000;
const STATUS_FILTERS: Array<{ value: AutopostStatusFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'ACTIVE', label: 'Активные' },
  { value: 'PAUSED', label: 'Пауза' },
  { value: 'ERROR', label: 'Ошибки' },
];
const autopostQueryKeys = {
  rules: (...scope: readonly unknown[]) => ['autopost-hub-rules', ...scope] as const,
  rule: (ruleId: string | null | undefined) => ['autopost-hub-rule', ruleId] as const,
  sources: (...scope: readonly unknown[]) => ['autopost-sources', ...scope] as const,
};

function createEmptyDraft(
  source?: ChatSummary | null,
  entityType: ManagedEntityType = 'chat',
): AutopostDraft {
  return {
    sourceChatId: source?.id ?? '',
    entityType,
    title: '',
    text: '',
    images: [],
    buttons: [],
    buttonEnabled: false,
    targetMode: 'current',
    targetChatIds: source?.id ? [source.id] : [],
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
  };
}

function createDraftFromRule(rule: ManagedAutopostHubRuleDetails): AutopostDraft {
  return {
    sourceChatId: rule.sourceChatId,
    entityType: rule.entityType,
    title: rule.title,
    text: rule.payload.text,
    images: rule.payload.images,
    buttons: rule.payload.buttons,
    buttonEnabled: rule.payload.buttons.length > 0,
    targetMode: rule.payload.targetMode,
    targetChatIds:
      rule.payload.targetChatIds.length > 0 ? rule.payload.targetChatIds : [rule.sourceChatId],
    scheduleTimezone: rule.payload.scheduleTimezone,
    scheduledSlots: rule.payload.scheduledSlots,
    mediaType:
      rule.payload.mediaType === 'image' || rule.payload.mediaType === 'video'
        ? rule.payload.mediaType
        : null,
    mediaPayload: rule.payload.mediaPayload,
    mediaMimeType: rule.payload.mediaMimeType,
    mediaFileName: rule.payload.mediaFileName,
  };
}

function normalizeEntityTypeParam(value: string | null): ManagedEntityType | null {
  return value === 'channel' || value === 'chat' ? value : null;
}

function formatNextLabel(value: string | null): string {
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
  }).format(date);
}

function formatSlotLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return 'Время';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function resolveSourceLabel(source: ChatSummary | undefined, fallback: string): string {
  return source?.title.trim() || fallback;
}

function getRuleFacts(rule: ManagedAutopostHubRuleSummary): string[] {
  const facts = buildManagedAutopostRuleFacts(rule, rule.sourcePreview.title);
  const targetFact =
    rule.entityType === 'channel'
      ? rule.sourcePreview.title
      : rule.targetMode === 'all'
        ? 'Все чаты'
        : rule.targetPreviews.length > 1
          ? `${rule.targetPreviews.length} чата`
          : (rule.targetPreviews[0]?.title ?? rule.sourcePreview.title);

  return [
    `Из: ${rule.sourcePreview.title}`,
    `Куда: ${targetFact}`,
    ...facts.filter((fact) => fact !== targetFact && fact !== rule.sourcePreview.title),
  ];
}

function hasFutureSlot(slots: readonly string[]): boolean {
  const minTime = Date.now() + MIN_SLOT_DELAY_MS;
  return slots.some((slot) => {
    const parsed = new Date(slot).getTime();
    return Number.isFinite(parsed) && parsed >= minTime;
  });
}

function buildAutopostPayload(draft: AutopostDraft) {
  const visibleButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const legacyButtons = buildBroadcastLinkButtonLegacyFields(visibleButtons);
  const targetMode = draft.entityType === 'channel' ? 'current' : draft.targetMode;
  const targetChatIds =
    targetMode === 'current'
      ? [draft.sourceChatId]
      : targetMode === 'selected'
        ? draft.targetChatIds
        : [];
  const firstImage = draft.images[0];

  return normalizeManagedAutopostPayload({
    text: draft.text,
    textFormat: 'markdown',
    targetMode,
    targetChatIds,
    applyToAllChats: targetMode === 'all',
    buttons: visibleButtons,
    buttonEnabled: legacyButtons.buttonEnabled,
    buttonUrl: legacyButtons.buttonUrl,
    buttonText: legacyButtons.buttonText,
    imageEnabled: Boolean(firstImage),
    imageBase64: firstImage?.base64 ?? '',
    imageMimeType: firstImage?.mimeType ?? '',
    imageFileName: firstImage?.fileName ?? '',
    images: draft.mediaType === 'video' ? [] : draft.images,
    mediaType: draft.mediaType,
    mediaPayload: draft.mediaPayload,
    mediaMimeType: draft.mediaMimeType,
    mediaFileName: draft.mediaFileName,
    scheduleMode: 'calendar',
    scheduleTimezone: draft.scheduleTimezone,
    scheduledSlots: draft.scheduledSlots,
    replaceConflictingSlots: false,
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
  });
}

function buildAutopostTestPayload(draft: AutopostDraft): SendBroadcastPayload {
  const payload = buildAutopostPayload(draft);
  return {
    ...payload,
    mediaType:
      payload.mediaType === 'image' || payload.mediaType === 'video' ? payload.mediaType : null,
    targetMode: 'current' as const,
    targetChatIds: draft.sourceChatId ? [draft.sourceChatId] : [],
    applyToAllChats: false,
    scheduleMode: 'legacy' as const,
    scheduledSlots: [],
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
  };
}

function resolveInitialSource(
  sources: AutopostSources,
  entityType: ManagedEntityType,
  sourceChatId: string,
): ChatSummary | null {
  const choices = entityType === 'channel' ? sources.channels : sources.chats;
  return choices.find((source) => source.id === sourceChatId) ?? choices[0] ?? null;
}

export function AutopostsPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryEntityType =
    normalizeEntityTypeParam(searchParams.get('entityType')) ??
    normalizeEntityTypeParam(searchParams.get('sourceType'));
  const querySourceChatId = searchParams.get('entityId') ?? searchParams.get('sourceId') ?? '';
  const [statusFilter, setStatusFilter] = useState<AutopostStatusFilter>('all');
  const [creating, setCreating] = useState(false);
  const [editorRuleId, setEditorRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AutopostDraft>(() =>
    createEmptyDraft(null, queryEntityType ?? 'chat'),
  );
  const [buttonErrors, setButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>([]);
  const [buttonsOpen, setButtonsOpen] = useState(false);
  const [validationError, setValidationError] = useState('');
  const loadedRuleIdRef = useRef<string | null>(null);

  const sourcesQuery = useQuery({
    queryKey: autopostQueryKeys.sources('all'),
    queryFn: async () => {
      const [chats, channels] = await Promise.all([
        getChats(api, { fresh: false }),
        getChannels(api, { fresh: false }),
      ]);
      return { chats, channels };
    },
  });
  const sources = sourcesQuery.data ?? { chats: [], channels: [] };
  const sourceChoices = draft.entityType === 'channel' ? sources.channels : sources.chats;
  const source = sourceChoices.find((item) => item.id === draft.sourceChatId);
  const sourceLabel = resolveSourceLabel(source, draft.entityType === 'channel' ? 'Канал' : 'Чат');
  const sourceFilterEntityType = queryEntityType ?? undefined;
  const sourceFilterId = querySourceChatId.trim();
  const activeSourceFilter =
    sourceFilterEntityType && sourceFilterId
      ? [...sources.chats, ...sources.channels].find(
          (item) => item.id === sourceFilterId && item.entityType === sourceFilterEntityType,
        )
      : undefined;

  const rulesQuery = useQuery({
    queryKey: autopostQueryKeys.rules(
      statusFilter,
      sourceFilterEntityType ?? 'all',
      sourceFilterId,
    ),
    queryFn: () =>
      getAutopostRules(api, {
        entityType: sourceFilterEntityType ?? 'all',
        ...(statusFilter !== 'all' ? { status: statusFilter } : {}),
        ...(sourceFilterId ? { sourceChatId: sourceFilterId } : {}),
      }),
  });
  const rules = useMemo(
    () => sortManagedAutopostRules(rulesQuery.data ?? []) as ManagedAutopostHubRuleSummary[],
    [rulesQuery.data],
  );
  const editingRuleQuery = useQuery({
    queryKey: autopostQueryKeys.rule(editorRuleId),
    queryFn: () => getAutopostRule(api, editorRuleId ?? ''),
    enabled: Boolean(editorRuleId),
  });
  const broadcastsQuery = useQuery({
    queryKey: ['autoposts-broadcasts', draft.entityType, draft.sourceChatId],
    queryFn: () =>
      draft.entityType === 'channel'
        ? getChannelManagedBroadcasts(api, draft.sourceChatId)
        : getManagedBroadcasts(api, draft.sourceChatId),
    enabled: Boolean(draft.sourceChatId),
  });
  const calendarQuery = useQuery({
    queryKey: [
      'autoposts-calendar',
      draft.entityType,
      draft.sourceChatId,
      draft.targetMode,
      draft.targetChatIds.join(','),
    ],
    queryFn: () => {
      const params = {
        targetMode: draft.entityType === 'channel' ? ('current' as const) : draft.targetMode,
        targetChatIds: draft.targetMode === 'selected' ? draft.targetChatIds : [],
      };
      return draft.entityType === 'channel'
        ? getChannelManagedBroadcastCalendar(api, draft.sourceChatId, params)
        : getManagedBroadcastCalendar(api, draft.sourceChatId, params);
    },
    enabled: Boolean(draft.sourceChatId),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = buildAutopostPayload(draft);
      if (editorRuleId) {
        return updateAutopostRule(api, editorRuleId, {
          title: draft.title,
          payload,
        });
      }
      return createAutopostRule(api, {
        sourceChatId: draft.sourceChatId,
        entityType: draft.entityType,
        title: draft.title,
        payload,
      });
    },
    onSuccess: (rule) => {
      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.rules() });
      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.rule(rule.id) });
      pushToast({ tone: 'success', title: editorRuleId ? 'Сохранено' : 'Автопост создан' });
      closeEditor();
    },
    onError: (error) => {
      pushToast({ tone: 'danger', title: describeApiError(error, 'Не удалось сохранить') });
    },
  });
  const statusMutation = useMutation({
    mutationFn: ({ ruleId, status }: { ruleId: string; status: 'ACTIVE' | 'PAUSED' }) =>
      updateAutopostRule(api, ruleId, { status }),
    onSuccess: (rule) => {
      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.rules() });
      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.rule(rule.id) });
    },
    onError: (error) => {
      pushToast({ tone: 'danger', title: describeApiError(error, 'Не удалось обновить') });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (ruleId: string) => deleteAutopostRule(api, ruleId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.rules() });
      pushToast({ tone: 'info', title: 'Автопост удалён' });
      closeEditor();
    },
    onError: (error) => {
      pushToast({ tone: 'danger', title: describeApiError(error, 'Не удалось удалить') });
    },
  });
  const testMutation = useMutation({
    mutationFn: () =>
      sendAutopostTest(api, draft.sourceChatId, draft.entityType, buildAutopostTestPayload(draft)),
    onSuccess: () => {
      pushToast({ tone: 'success', title: 'Тест отправлен' });
    },
    onError: (error) => {
      pushToast({ tone: 'danger', title: describeApiError(error, 'Тест не отправлен') });
    },
  });

  const isEditor = creating || editorRuleId !== null;
  const isBusy =
    saveMutation.isPending ||
    statusMutation.isPending ||
    deleteMutation.isPending ||
    testMutation.isPending;
  const visibleButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const hasContent = Boolean(
    draft.text.trim() || draft.images.length > 0 || draft.mediaType === 'video',
  );
  const hasButtonErrors =
    draft.buttonEnabled &&
    hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(draft.buttons));
  const validationIssues = useMemo<BroadcastPublishIssueAction[]>(() => {
    const issues: BroadcastPublishIssueAction[] = [];
    if (!hasContent) {
      issues.push({
        label: 'Сообщение',
        onClick: () => setValidationError('Добавьте текст или фото.'),
      });
    }
    if (!draft.sourceChatId) {
      issues.push({ label: 'Куда', onClick: () => setValidationError('Выберите источник.') });
    }
    if (
      draft.entityType === 'chat' &&
      draft.targetMode === 'selected' &&
      draft.targetChatIds.length === 0
    ) {
      issues.push({ label: 'Чаты', onClick: () => setValidationError('Выберите чаты.') });
    }
    if (!hasFutureSlot(draft.scheduledSlots)) {
      issues.push({ label: 'Когда', onClick: () => setValidationError('Выберите будущее время.') });
    }
    if (hasButtonErrors) {
      issues.push({ label: 'Кнопки', onClick: () => setButtonsOpen(true) });
    }
    return issues;
  }, [
    draft.entityType,
    draft.scheduledSlots,
    draft.sourceChatId,
    draft.targetChatIds.length,
    draft.targetMode,
    hasButtonErrors,
    hasContent,
  ]);

  useEffect(() => {
    if (!sourcesQuery.data || editorRuleId) {
      return;
    }
    const desiredType = queryEntityType ?? draft.entityType;
    const nextSource = resolveInitialSource(sourcesQuery.data, desiredType, querySourceChatId);
    if (!nextSource || draft.sourceChatId) {
      return;
    }
    setDraft(createEmptyDraft(nextSource, desiredType));
  }, [
    draft.entityType,
    draft.sourceChatId,
    editorRuleId,
    queryEntityType,
    querySourceChatId,
    sourcesQuery.data,
  ]);

  useEffect(() => {
    const details = editingRuleQuery.data;
    if (!details || loadedRuleIdRef.current === details.id) {
      return;
    }
    loadedRuleIdRef.current = details.id;
    setDraft(createDraftFromRule(details));
    setButtonErrors(validateBroadcastLinkButtons(details.payload.buttons));
  }, [editingRuleQuery.data]);

  useNativeBackHandler(
    () => {
      closeEditor();
      return true;
    },
    { enabled: isEditor, priority: 610 },
  );

  function closeEditor() {
    setCreating(false);
    setEditorRuleId(null);
    loadedRuleIdRef.current = null;
    setButtonsOpen(false);
    setValidationError('');
  }

  function openCreateEditor() {
    const desiredType = queryEntityType ?? draft.entityType;
    const nextSource = resolveInitialSource(sources, desiredType, querySourceChatId);
    setDraft(createEmptyDraft(nextSource, desiredType));
    setButtonErrors([]);
    setCreating(true);
    loadedRuleIdRef.current = null;
    setEditorRuleId(null);
    maxImpact('soft');
  }

  function openRuleEditor(rule: ManagedAutopostHubRuleSummary) {
    loadedRuleIdRef.current = null;
    setEditorRuleId(rule.id);
    maxImpact('soft');
  }

  function clearSourceFilter() {
    const next = new URLSearchParams(searchParams);
    next.delete('entityType');
    next.delete('entityId');
    next.delete('sourceType');
    next.delete('sourceId');
    setSearchParams(next, { replace: true });
  }

  function changeDraftSourceType(entityType: ManagedEntityType) {
    const choices = entityType === 'channel' ? sources.channels : sources.chats;
    const nextSource = choices[0] ?? null;
    setDraft(createEmptyDraft(nextSource, entityType));
    setValidationError('');
  }

  function changeDraftSource(sourceChatId: string) {
    const nextSource = sourceChoices.find((item) => item.id === sourceChatId) ?? null;
    if (!nextSource) {
      return;
    }
    setDraft((current) => ({
      ...current,
      sourceChatId: nextSource.id,
      targetMode: 'current',
      targetChatIds: [nextSource.id],
    }));
    setValidationError('');
  }

  function validateDraft(): boolean {
    const nextButtonErrors = validateBroadcastLinkButtons(draft.buttons);
    setButtonErrors(nextButtonErrors);
    if (validationIssues.length > 0) {
      validationIssues[0]?.onClick();
      return false;
    }
    setValidationError('');
    return true;
  }

  function handleSave() {
    if (!validateDraft()) {
      return;
    }
    saveMutation.mutate();
  }

  function handleTest() {
    if (!validateDraft()) {
      return;
    }
    testMutation.mutate();
  }

  function handleDeleteRule(ruleId: string) {
    if (!window.confirm('Удалить автопост?')) {
      return;
    }
    deleteMutation.mutate(ruleId);
  }

  function renderList() {
    return (
      <>
        <header className="autoposts-header">
          <div className="autoposts-header__copy">
            <h1>Автопосты</h1>
            <span>
              {activeSourceFilter ? activeSourceFilter.title : `${rules.length} в списке`}
            </span>
          </div>
          <button type="button" className="autoposts-primary-button" onClick={openCreateEditor}>
            <IconoirPlus aria-hidden />
            <span>Создать</span>
          </button>
        </header>

        {activeSourceFilter ? (
          <div className="autoposts-source-strip">
            <span>
              <strong>{activeSourceFilter.title}</strong>
              <small>{activeSourceFilter.entityType === 'channel' ? 'Канал' : 'Чат'}</small>
            </span>
            <button type="button" className="autoposts-chip" onClick={clearSourceFilter}>
              Все
            </button>
          </div>
        ) : null}

        <div className="autoposts-filters" aria-label="Фильтр автопостов">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              className={cn('autoposts-filter', statusFilter === filter.value && 'is-active')}
              onClick={() => setStatusFilter(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        {rulesQuery.isLoading ? (
          <StatusState tone="neutral" title="Загружаю" />
        ) : rulesQuery.isError ? (
          <StatusState
            tone="danger"
            title="Не загрузилось"
            description={describeApiError(rulesQuery.error, 'Повторите позже.')}
          />
        ) : rules.length === 0 ? (
          <div className="autoposts-empty">
            <strong>Пока пусто</strong>
            <span>Создайте первый автопост.</span>
            <button type="button" className="autoposts-primary-button" onClick={openCreateEditor}>
              <IconoirPlus aria-hidden />
              <span>Создать</span>
            </button>
          </div>
        ) : (
          <div className="autoposts-list">
            {rules.map((rule) => {
              const busyRule =
                statusMutation.variables?.ruleId === rule.id ||
                deleteMutation.variables === rule.id;
              return (
                <ManagedAutopostRuleCard
                  key={rule.id}
                  rule={rule}
                  nextLabel={formatNextLabel(rule.nextSendAt)}
                  facts={getRuleFacts(rule)}
                  isBusy={busyRule}
                  onOpen={() => openRuleEditor(rule)}
                  onPause={() => statusMutation.mutate({ ruleId: rule.id, status: 'PAUSED' })}
                  onResume={() => statusMutation.mutate({ ruleId: rule.id, status: 'ACTIVE' })}
                  onDelete={() => handleDeleteRule(rule.id)}
                />
              );
            })}
          </div>
        )}
      </>
    );
  }

  function renderEditor() {
    const isEditing = Boolean(editorRuleId);
    const sourceTypeLocked = isEditing;
    const titleMeta = source ? source.title : draft.entityType === 'channel' ? 'Канал' : 'Чат';

    return (
      <>
        <header className="autoposts-header">
          <button
            type="button"
            className="autoposts-icon-button"
            onClick={closeEditor}
            aria-label="Назад"
            title="Назад"
          >
            <IconoirArrowLeft aria-hidden />
          </button>
          <div className="autoposts-header__copy">
            <h1>{isEditing ? 'Редактировать' : 'Новый автопост'}</h1>
            <span>{titleMeta}</span>
          </div>
          {isEditing ? (
            <button
              type="button"
              className="autoposts-icon-button"
              onClick={() => editorRuleId && handleDeleteRule(editorRuleId)}
              aria-label="Удалить"
              title="Удалить"
              disabled={isBusy}
            >
              <IconoirTrash aria-hidden />
            </button>
          ) : (
            <span className="autoposts-icon-button" aria-hidden />
          )}
        </header>

        {editingRuleQuery.isLoading ? (
          <StatusState tone="neutral" title="Открываю" />
        ) : editingRuleQuery.isError ? (
          <StatusState
            tone="danger"
            title="Не открылось"
            description={describeApiError(editingRuleQuery.error, 'Повторите позже.')}
          />
        ) : (
          <div className="autoposts-editor">
            <section className="autoposts-editor-card autoposts-editor-card--message">
              <div className="autoposts-editor-card__head">
                <strong>Сообщение</strong>
                <small>
                  {draft.text.length}/{TEXT_MAX_LENGTH}
                </small>
              </div>
              <div className="autoposts-editor-card__body">
                <input
                  className="autoposts-title-input"
                  value={draft.title}
                  maxLength={120}
                  placeholder="Название"
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, title: event.currentTarget.value }))
                  }
                  disabled={isBusy}
                />
                <BroadcastContentComposer
                  text={draft.text}
                  maxLength={TEXT_MAX_LENGTH}
                  images={draft.images}
                  buttons={visibleButtons}
                  buttonsStatusLabel="Кнопки"
                  buttonsActive={visibleButtons.length > 0}
                  buttonsError={hasButtonErrors}
                  videoLabel={draft.mediaType === 'video' ? draft.mediaFileName || 'Видео' : null}
                  disabled={isBusy}
                  textError={validationError.includes('текст') ? validationError : ''}
                  textPlaceholder="Текст"
                  onTextChange={(value) => {
                    setDraft((current) => ({ ...current, text: value }));
                    setValidationError('');
                  }}
                  onImagesChange={(images) =>
                    setDraft((current) => ({
                      ...current,
                      images,
                      mediaType: current.mediaType === 'video' ? null : current.mediaType,
                      mediaPayload: current.mediaType === 'video' ? null : current.mediaPayload,
                      mediaMimeType: current.mediaType === 'video' ? '' : current.mediaMimeType,
                      mediaFileName: current.mediaType === 'video' ? '' : current.mediaFileName,
                    }))
                  }
                  onOpenButtons={() => setButtonsOpen(true)}
                  onClearVideo={() =>
                    setDraft((current) => ({
                      ...current,
                      mediaType: null,
                      mediaPayload: null,
                      mediaMimeType: '',
                      mediaFileName: '',
                    }))
                  }
                  onError={(message) => pushToast({ tone: 'info', title: message })}
                />
              </div>
            </section>

            <section className="autoposts-editor-card">
              <div className="autoposts-editor-card__head">
                <strong>Куда</strong>
                <small>{sourceLabel}</small>
              </div>
              <div className="autoposts-editor-card__body">
                <div className="autoposts-source-grid">
                  <div className="autoposts-source-toggle" aria-label="Источник">
                    <button
                      type="button"
                      className={cn(draft.entityType === 'chat' && 'is-active')}
                      onClick={() => changeDraftSourceType('chat')}
                      disabled={sourceTypeLocked || isBusy}
                    >
                      Чаты
                    </button>
                    <button
                      type="button"
                      className={cn(draft.entityType === 'channel' && 'is-active')}
                      onClick={() => changeDraftSourceType('channel')}
                      disabled={sourceTypeLocked || isBusy}
                    >
                      Каналы
                    </button>
                  </div>
                  <select
                    className="autoposts-source-select"
                    value={draft.sourceChatId}
                    onChange={(event) => changeDraftSource(event.currentTarget.value)}
                    disabled={sourceTypeLocked || isBusy || sourceChoices.length === 0}
                  >
                    {sourceChoices.length === 0 ? (
                      <option value="">Нет доступа</option>
                    ) : (
                      sourceChoices.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))
                    )}
                  </select>
                </div>

                {draft.entityType === 'channel' ? (
                  <div className="autoposts-target-locked">
                    <span>
                      <strong>{sourceLabel}</strong>
                      <small>Текущий канал</small>
                    </span>
                    <span className="autoposts-chip">Канал</span>
                  </div>
                ) : (
                  <BroadcastAudienceControls
                    targetMode={draft.targetMode}
                    currentChatId={draft.sourceChatId}
                    targetChatIds={draft.targetChatIds}
                    choices={sources.chats}
                    currentLabel="Текущий чат"
                    selectedLabel="Выбрать"
                    allLabel="Все чаты"
                    loading={sourcesQuery.isLoading}
                    refreshing={sourcesQuery.isFetching}
                    validationError={validationError.includes('чат') ? validationError : null}
                    disabled={isBusy}
                    onToggleAllChats={(enabled) =>
                      setDraft((current) => ({
                        ...current,
                        targetMode: enabled ? 'all' : 'current',
                        targetChatIds: enabled ? [] : [current.sourceChatId],
                      }))
                    }
                    onChangeScopedMode={(mode) =>
                      setDraft((current) => ({
                        ...current,
                        targetMode: mode,
                        targetChatIds:
                          mode === 'current' ? [current.sourceChatId] : current.targetChatIds,
                      }))
                    }
                    onApplySelection={(nextSelection) =>
                      setDraft((current) => ({
                        ...current,
                        targetMode: 'selected',
                        targetChatIds: nextSelection,
                      }))
                    }
                    onClearValidationError={() => setValidationError('')}
                    onRefreshChoices={() =>
                      void queryClient.invalidateQueries({ queryKey: autopostQueryKeys.sources() })
                    }
                  />
                )}
              </div>
            </section>

            <section className="autoposts-editor-card">
              <div className="autoposts-editor-card__head">
                <strong>Когда</strong>
                <small>
                  {draft.scheduledSlots.length ? `${draft.scheduledSlots.length}` : 'Время'}
                </small>
              </div>
              <div className="autoposts-editor-card__body">
                <BroadcastSchedulePlanner
                  value={draft.scheduledSlots}
                  error={validationError.includes('время') ? validationError : ''}
                  disabled={isBusy}
                  onChange={(nextValue) =>
                    setDraft((current) => ({ ...current, scheduledSlots: nextValue }))
                  }
                  managedBroadcasts={broadcastsQuery.data ?? []}
                  calendarSlots={calendarQuery.data?.slots ?? []}
                  targetAwareAvailability
                  sourceChatId={draft.sourceChatId}
                  managedBroadcastsLoading={broadcastsQuery.isFetching || calendarQuery.isFetching}
                  currentTargetLabel={sourceLabel}
                  targetContextLabel={sourceLabel}
                  calendarRefreshing={calendarQuery.isFetching}
                  excludeAutopostRuleId={editorRuleId}
                  timingMode="scheduled"
                  availableTimingModes={['scheduled']}
                  viewMode="compose"
                />
                {draft.scheduledSlots.length > 0 ? (
                  <div className="autoposts-slot-list">
                    {draft.scheduledSlots.slice(0, 4).map((slot) => (
                      <span key={slot} className="autoposts-chip">
                        {formatSlotLabel(slot)}
                      </span>
                    ))}
                  </div>
                ) : null}
                {validationError ? (
                  <div className="autoposts-inline-error">{validationError}</div>
                ) : null}
              </div>
            </section>
          </div>
        )}

        <BroadcastButtonsSheet
          open={buttonsOpen}
          api={api}
          enabled={draft.buttonEnabled}
          buttons={draft.buttons}
          errors={buttonErrors}
          disabled={isBusy}
          contextEntityType={draft.entityType}
          onEnabledChange={(enabled) =>
            setDraft((current) => ({
              ...current,
              buttonEnabled: enabled,
              buttons:
                enabled && current.buttons.length === 0
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

        <div className="autoposts-publish-bar">
          <BroadcastPublishBar
            title={isEditing ? 'Автопост' : 'Новый'}
            meta={sourceLabel}
            issues={validationIssues}
            busy={isBusy}
            testLabel="Тест"
            testAriaLabel="Отправить тест"
            testDisabled={isBusy || validationIssues.length > 0}
            primaryLabel="Сохранить"
            primaryDisabled={isBusy}
            onTest={handleTest}
            onPrimary={handleSave}
          />
        </div>
      </>
    );
  }

  return (
    <div className={cn('autoposts-page', isEditor && 'is-editor')}>
      {isEditor ? renderEditor() : renderList()}
    </div>
  );
}
