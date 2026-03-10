import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

type ChannelSettingsSectionKey = 'comments' | 'postSuggestions';

const AUTOSAVE_DELAY_MS = 700;
const AUTOSAVE_SAVED_HIDE_MS = 1600;

function buildAutoPostButtonsMode(
  includeComments: boolean,
  includeSuggest: boolean,
): ChannelAutoPostButtonsMode {
  if (includeComments && includeSuggest) {
    return 'BOTH';
  }
  if (includeComments) {
    return 'COMMENTS';
  }
  if (includeSuggest) {
    return 'SUGGEST';
  }
  return 'OFF';
}

function modeHasComments(mode: ChannelAutoPostButtonsMode): boolean {
  return mode === 'COMMENTS' || mode === 'BOTH';
}

function sanitizeAutoPostButtonsMode(
  mode: ChannelAutoPostButtonsMode,
  commentsEnabled: boolean,
  suggestEnabled: boolean,
): ChannelAutoPostButtonsMode {
  return buildAutoPostButtonsMode(commentsEnabled && modeHasComments(mode), suggestEnabled);
}

function resolveManualPublishButtons(settings: ChannelSettings) {
  return {
    includeCommentsButton:
      settings.autoPostButtonsMode === 'COMMENTS' || settings.autoPostButtonsMode === 'BOTH'
        ? true
        : settings.autoPostButtonsMode === 'OFF'
          ? settings.commentsEnabled
          : false,
    includeSuggestButton: true,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function getRouteState(state: unknown): ChannelRouteState {
  if (!state || typeof state !== 'object') {
    return { chatTitle: '', chatLink: '' };
  }

  const row = state as Record<string, unknown>;
  const chatTitle =
    typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '';
  const candidateLink =
    typeof row.chatLink === 'string' && row.chatLink.trim() ? row.chatLink.trim() : '';
  const chatLink = isHttpUrl(candidateLink) ? candidateLink : '';

  return { chatTitle, chatLink };
}

function formatParticipantsCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось сохранить настройки.';
  }

  const text = error.message.trim();
  if (!text) {
    return 'Не удалось сохранить настройки.';
  }

  if (text.startsWith('API request failed:')) {
    const details = text.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось сохранить настройки.';
  }

  return text;
}

function SectionChevron({ isOpen }: { isOpen: boolean }) {
  return (
    <span className={cn('settings-section__chevron', isOpen && 'is-open')} aria-hidden>
      <svg
        className="settings-section__chevron-icon"
        viewBox="0 0 20 20"
        fill="none"
        focusable="false"
      >
        <path
          d="M5.5 7.75L10 12.25L14.5 7.75"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function ChannelSettingsToggleCard({
  title,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('channel-settings-toggle-card', disabled && 'is-disabled')}>
      <div className="channel-settings-toggle-card__copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </div>
      <span className={cn('channel-settings-toggle-card__state', checked && 'is-on')}>
        {checked ? 'Вкл' : 'Выкл'}
      </span>
      <span className="settings-native-switch">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          disabled={disabled}
        />
        <span className="toggle-switch" aria-hidden>
          <span className="toggle-switch__thumb" />
        </span>
      </span>
    </label>
  );
}

function normalizeChannelSettingsDraft(
  draft: ChannelSettings,
  resolvedChannelLink: string,
): ChannelSettings {
  const autoPostButtonsMode = sanitizeAutoPostButtonsMode(
    draft.autoPostButtonsMode,
    draft.commentsEnabled,
    draft.postSuggestionsEnabled,
  );

  return {
    ...draft,
    autoPostButtonsMode,
    engagementMessageText:
      draft.engagementMessageText.trim() || 'Есть идея или обратная связь? Нажмите кнопку ниже.',
    postSuggestionsButtonText: draft.postSuggestionsButtonText.trim() || 'Предложить пост',
    postSuggestionsButtonUrl:
      draft.postSuggestionsButtonEnabled && resolvedChannelLink
        ? resolvedChannelLink
        : draft.postSuggestionsButtonUrl,
  };
}

export function ChannelSettingsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const [autosaveState, setAutosaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveHideTimerRef = useRef<number | null>(null);
  const saveInFlightRef = useRef<Promise<ChannelSettings> | null>(null);
  const lastFailedDraftKeyRef = useRef<string | null>(null);
  const latestNormalizedDraftRef = useRef<ChannelSettings | null>(null);
  const latestDraftKeyRef = useRef('');
  const isDirtyRef = useRef(false);
  const [expandedSections, setExpandedSections] = useState<
    Record<ChannelSettingsSectionKey, boolean>
  >({
    comments: false,
    postSuggestions: false,
  });
  const { pushToast } = useToast();

  const settingsQuery = useQuery({
    queryKey: ['channel-settings', chatId],
    queryFn: () => api.getChannelSettings(chatId),
    enabled: Boolean(chatId),
  });

  const channelHeaderQuery = useQuery({
    queryKey: ['channel-header', chatId],
    queryFn: () => api.getChannelHeader(chatId),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setSavedSnapshot(settingsQuery.data);
    setAutosaveState('idle');
    lastFailedDraftKeyRef.current = null;
  }, [settingsQuery.data]);

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId('channel', chatId);
    if (routeChatTitle) {
      saveChatTitle(chatId, routeChatTitle);
    }
  }, [chatId, routeChatTitle]);

  const resolvedTitle = useMemo(() => {
    const fromHeader = channelHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [channelHeaderQuery.data?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !resolvedTitle) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [chatId, resolvedTitle]);

  const resolvedChannelLink = useMemo(() => {
    const fromHeader = channelHeaderQuery.data?.link?.trim() ?? '';
    if (isHttpUrl(fromHeader)) {
      return fromHeader;
    }

    if (routeChatLink) {
      return routeChatLink;
    }

    return '';
  }, [channelHeaderQuery.data?.link, routeChatLink]);

  function toggleSection(section: ChannelSettingsSectionKey) {
    setExpandedSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }

  const normalizedDraft = useMemo(
    () => (draft ? normalizeChannelSettingsDraft(draft, resolvedChannelLink) : null),
    [draft, resolvedChannelLink],
  );

  const normalizedSavedSnapshot = useMemo(
    () =>
      savedSnapshot ? normalizeChannelSettingsDraft(savedSnapshot, resolvedChannelLink) : null,
    [resolvedChannelLink, savedSnapshot],
  );

  const normalizedDraftKey = useMemo(
    () => (normalizedDraft ? JSON.stringify(normalizedDraft) : ''),
    [normalizedDraft],
  );

  const normalizedSavedSnapshotKey = useMemo(
    () => (normalizedSavedSnapshot ? JSON.stringify(normalizedSavedSnapshot) : ''),
    [normalizedSavedSnapshot],
  );

  const isDirty = useMemo(() => {
    if (!normalizedDraft || !normalizedSavedSnapshot) {
      return false;
    }

    return normalizedDraftKey !== normalizedSavedSnapshotKey;
  }, [normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot, normalizedSavedSnapshotKey]);

  const patchDraft = <K extends keyof ChannelSettings>(key: K, value: ChannelSettings[K]) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextDraft: ChannelSettings = {
        ...current,
        [key]: value,
      };

      nextDraft.autoPostButtonsMode = sanitizeAutoPostButtonsMode(
        nextDraft.autoPostButtonsMode,
        nextDraft.commentsEnabled,
        nextDraft.postSuggestionsEnabled,
      );

      return nextDraft;
    });
  };

  useEffect(() => {
    latestNormalizedDraftRef.current = normalizedDraft;
    latestDraftKeyRef.current = normalizedDraftKey;
    isDirtyRef.current = isDirty;
  }, [isDirty, normalizedDraft, normalizedDraftKey]);

  const clearAutosaveTimer = () => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  };

  const clearAutosaveHideTimer = () => {
    if (autosaveHideTimerRef.current !== null) {
      window.clearTimeout(autosaveHideTimerRef.current);
      autosaveHideTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      clearAutosaveTimer();
      clearAutosaveHideTimer();
    },
    [],
  );

  const saveCurrentDraft = async ({
    force = false,
  }: {
    force?: boolean;
  } = {}): Promise<ChannelSettings | null> => {
    const payload = latestNormalizedDraftRef.current;
    const payloadKey = latestDraftKeyRef.current;

    if (!payload || (!force && !isDirtyRef.current)) {
      return null;
    }

    if (!force && payloadKey === lastFailedDraftKeyRef.current) {
      setAutosaveState('error');
      return null;
    }

    if (saveInFlightRef.current) {
      return saveInFlightRef.current;
    }

    clearAutosaveTimer();
    clearAutosaveHideTimer();
    setAutosaveState('saving');

    const request = api
      .updateChannelSettings(chatId, payload)
      .then((saved) => {
        lastFailedDraftKeyRef.current = null;
        setSavedSnapshot(saved);
        setDraft((current) => {
          if (!current) {
            return current;
          }

          const currentNormalized = normalizeChannelSettingsDraft(current, resolvedChannelLink);
          return JSON.stringify(currentNormalized) === payloadKey ? saved : current;
        });
        setAutosaveState('saved');
        autosaveHideTimerRef.current = window.setTimeout(() => {
          setAutosaveState((current) => (current === 'saved' ? 'idle' : current));
          autosaveHideTimerRef.current = null;
        }, AUTOSAVE_SAVED_HIDE_MS);
        return saved;
      })
      .catch((error: unknown) => {
        lastFailedDraftKeyRef.current = payloadKey;
        setAutosaveState('error');
        throw error;
      })
      .finally(() => {
        saveInFlightRef.current = null;
      });

    saveInFlightRef.current = request;
    return request;
  };

  useEffect(() => {
    clearAutosaveTimer();

    if (!chatId || !normalizedDraft || !normalizedSavedSnapshot || !isDirty) {
      return;
    }

    if (saveInFlightRef.current) {
      setAutosaveState('saving');
      return;
    }

    if (normalizedDraftKey === lastFailedDraftKeyRef.current) {
      setAutosaveState('error');
      return;
    }

    clearAutosaveHideTimer();
    setAutosaveState('saving');
    autosaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentDraft();
    }, AUTOSAVE_DELAY_MS);

    return clearAutosaveTimer;
  }, [chatId, isDirty, normalizedDraft, normalizedDraftKey, normalizedSavedSnapshot]);

  const publishMutation = useMutation({
    mutationFn: async () => {
      if (!chatId) {
        throw new Error('Канал не выбран.');
      }

      const payload = latestNormalizedDraftRef.current;
      if (!payload) {
        throw new Error('Нет данных для публикации.');
      }

      const { includeCommentsButton, includeSuggestButton } = resolveManualPublishButtons(payload);
      return api.publishChannelEngagement(chatId, {
        text:
          payload.engagementMessageText.trim() ||
          'Есть идея или обратная связь? Нажмите кнопку ниже.',
        commentsButtonText: '💬 Комментарии',
        suggestButtonText: payload.postSuggestionsButtonText.trim() || '📰 Предложить пост',
        includeCommentsButton,
        includeSuggestButton,
      });
    },
    onSuccess: (result) => {
      pushToast({
        tone: 'success',
        title: result.updatedExisting ? 'Пост обновлен' : 'Пост опубликован',
        description: result.updatedExisting
          ? 'Текст и кнопки обновлены в уже опубликованном сообщении.'
          : 'Сообщение с кнопками отправлено в канал.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка публикации',
        description: normalizeApiError(error),
      });
    },
  });

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (settingsQuery.isLoading) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      </div>
    );
  }

  if (settingsQuery.error) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить настройки"
            description={normalizeApiError(settingsQuery.error)}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => void settingsQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="page-stack page-enter">
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      </div>
    );
  }

  const headerStatusTone =
    autosaveState === 'error'
      ? 'error'
      : autosaveState === 'saving'
        ? 'saving'
        : autosaveState === 'saved' || !isDirty
          ? 'saved'
          : 'draft';
  const headerStatusLabel =
    headerStatusTone === 'error'
      ? 'Ошибка'
      : headerStatusTone === 'saving'
        ? 'Сохраняем'
        : headerStatusTone === 'draft'
          ? 'Черновик'
          : 'Сохранено';
  const channelMetaLabel =
    resolvedTitle && resolvedTitle !== chatId
      ? resolvedChannelLink || `ID ${chatId}`
      : 'Настройки канала';
  const showHeaderStatus = headerStatusTone !== 'saved';
  const participantsCountLabel = formatParticipantsCount(
    channelHeaderQuery.data?.participantsCount ?? null,
  );
  const publishButtons = resolveManualPublishButtons(
    normalizedDraft ?? normalizeChannelSettingsDraft(draft, resolvedChannelLink),
  );
  const canPublishEngagement =
    publishButtons.includeCommentsButton || publishButtons.includeSuggestButton;
  const publishHint = !canPublishEngagement
    ? 'Включите хотя бы один сценарий, чтобы публиковать пост с кнопками.'
    : draft.postSuggestionsEnabled
      ? publishButtons.includeCommentsButton
        ? 'На новых постах предложка появится автоматически. В этом сообщении будут кнопки «Комментарии» и «Предложить пост».'
        : 'На новых постах предложка появится автоматически. В этом сообщении будет кнопка «Предложить пост».'
      : publishButtons.includeCommentsButton
        ? 'Автопредложка выключена. Кнопка «Предложить пост» появится только под этим сообщением, вместе с кнопкой «Комментарии».'
        : 'Автопредложка выключена. Кнопка «Предложить пост» появится только под этим сообщением.';

  return (
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-header" elevated>
        <div className="channel-settings-header__top">
          <Link
            to={buildManagedEntitiesRoute('channel')}
            className="channel-settings-header__back"
            aria-label="Назад к каналам"
          >
            <BackChevronIcon />
          </Link>
          <div className="channel-settings-header__body">
            <div className="channel-settings-header__title-row">
              <div className="channel-settings-header__main">
                <h1>{resolvedTitle || 'Настройки'}</h1>
                <p>{channelMetaLabel}</p>
              </div>
              {showHeaderStatus ? (
                <div className="channel-settings-header__actions">
                  {showHeaderStatus ? (
                    <span
                      className={cn('channel-settings-header__status', `is-${headerStatusTone}`)}
                      aria-live="polite"
                    >
                      {headerStatusLabel}
                    </span>
                  ) : null}
                  {headerStatusTone === 'error' ? (
                    <button
                      type="button"
                      className="channel-settings-header__retry"
                      onClick={() => {
                        lastFailedDraftKeyRef.current = null;
                        void saveCurrentDraft({ force: true });
                      }}
                    >
                      Повторить
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
            {participantsCountLabel ? (
              <div className="channel-settings-header__footer">
                <span
                  className="channel-settings-header__members"
                  aria-label={`Участников: ${participantsCountLabel}`}
                >
                  <ParticipantsIcon />
                  <span>{participantsCountLabel}</span>
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <button
            type="button"
            className="settings-section__toggle"
            onClick={() => toggleSection('comments')}
            aria-expanded={expandedSections.comments}
            aria-controls="channel-settings-comments"
          >
            <span className="settings-section__toggle-main">
              <h3>Комментарии</h3>
              <small>
                {draft.commentsEnabled ? 'ОБСУЖДЕНИЕ ВКЛЮЧЕНО' : 'ОБСУЖДЕНИЕ ВЫКЛЮЧЕНО'}
              </small>
            </span>
            <SectionChevron isOpen={expandedSections.comments} />
          </button>
        </div>

        <div
          id="channel-settings-comments"
          className={cn('settings-section__collapse', expandedSections.comments && 'is-open')}
        >
          <div className="settings-section__collapse-inner">
            <ChannelSettingsToggleCard
              title="Включить комментарии"
              description="Открывает обсуждение под постами канала."
              checked={draft.commentsEnabled}
              onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
            />

            {draft.commentsEnabled ? (
              <div className="channel-settings-stack">
                <ChannelSettingsToggleCard
                  title="Модерация"
                  description="Бот следит за сообщениями в комментариях."
                  checked={draft.commentsModerationEnabled}
                  onChange={(nextValue) => patchDraft('commentsModerationEnabled', nextValue)}
                />

                {draft.commentsModerationEnabled ? (
                  <div className="channel-settings-stack">
                    <ChannelSettingsToggleCard
                      title="Запретить ссылки"
                      description="Комментарий со ссылкой сразу отклоняется."
                      checked={draft.commentsBlockLinksEnabled}
                      onChange={(nextValue) => patchDraft('commentsBlockLinksEnabled', nextValue)}
                    />

                    <ChannelSettingsToggleCard
                      title="Антиспам"
                      description="Блокирует частые и повторяющиеся комментарии."
                      checked={draft.commentsAntiSpamEnabled}
                      onChange={(nextValue) => patchDraft('commentsAntiSpamEnabled', nextValue)}
                    />

                    {draft.commentsAntiSpamEnabled ? (
                      <div className="channel-settings-inline-fields channel-settings-inline-fields--narrow">
                        <label className="field">
                          <span>Пауза между комментариями, сек</span>
                          <input
                            type="number"
                            min={0}
                            max={3600}
                            value={draft.commentsSlowModeSeconds}
                            onChange={(event) =>
                              patchDraft(
                                'commentsSlowModeSeconds',
                                Number.isFinite(Number(event.target.value))
                                  ? Math.max(
                                      0,
                                      Math.min(
                                        3600,
                                        Number.parseInt(event.target.value || '0', 10),
                                      ),
                                    )
                                  : 0,
                              )
                            }
                          />
                          <small className="field__hint">
                            0 = без таймера, но повторы всё равно режутся
                          </small>
                        </label>
                      </div>
                    ) : null}

                    <ChannelSettingsToggleCard
                      title="Не больше двух подряд"
                      description="Третий комментарий подряд от одного автора отклоняется."
                      checked={draft.commentsLimitTwoInRowEnabled}
                      onChange={(nextValue) =>
                        patchDraft('commentsLimitTwoInRowEnabled', nextValue)
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
          <button
            type="button"
            className="settings-section__toggle"
            onClick={() => toggleSection('postSuggestions')}
            aria-expanded={expandedSections.postSuggestions}
            aria-controls="channel-settings-post-suggestions"
          >
            <span className="settings-section__toggle-main">
              <h3>Предложить пост</h3>
              <small>
                {draft.postSuggestionsEnabled
                  ? 'ПОД КАЖДЫМ ПОСТОМ'
                  : 'ТОЛЬКО РУЧНАЯ ПУБЛИКАЦИЯ'}
              </small>
            </span>
            <SectionChevron isOpen={expandedSections.postSuggestions} />
          </button>
        </div>

        <div
          id="channel-settings-post-suggestions"
          className={cn(
            'settings-section__collapse',
            expandedSections.postSuggestions && 'is-open',
          )}
        >
          <div className="settings-section__collapse-inner">
            <ChannelSettingsToggleCard
              title="Разрешить предложения"
              description="Автоматически добавляет предложку под каждым новым постом. Если выключить, кнопку можно опубликовать вручную только для одного сообщения."
              checked={draft.postSuggestionsEnabled}
              onChange={(nextValue) => patchDraft('postSuggestionsEnabled', nextValue)}
            />

            <div className="channel-settings-stack">
              <label className="field">
                <span>Текст публикации</span>
                <textarea
                  rows={3}
                  value={draft.engagementMessageText}
                  onChange={(event) => patchDraft('engagementMessageText', event.target.value)}
                  placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
                />
                <small className="field__hint">
                  Этот текст будет опубликован в канале над кнопками.
                </small>
              </label>

              <label className="field">
                <span>Название кнопки</span>
                <input
                  type="text"
                  value={draft.postSuggestionsButtonText}
                  onChange={(event) =>
                    patchDraft('postSuggestionsButtonText', event.target.value)
                  }
                  placeholder="Предложить пост"
                  maxLength={32}
                />
              </label>

              <label className="field">
                <span>Текст</span>
                <textarea
                  rows={3}
                  value={draft.postSuggestionsText}
                  onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                  placeholder="Коротко объясните, что отправлять."
                />
              </label>

              <div className="channel-settings-inline-fields">
                <label className="field">
                  <span>Пост с кнопками</span>
                  <small className="field__hint">{publishHint}</small>
                </label>
                <button
                  type="button"
                  className="button button--accent"
                  onClick={() => publishMutation.mutate()}
                  disabled={!canPublishEngagement || publishMutation.isPending}
                >
                  {publishMutation.isPending ? 'Публикуем…' : 'Опубликовать или обновить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </GlassCard>
    </div>
  );
}
