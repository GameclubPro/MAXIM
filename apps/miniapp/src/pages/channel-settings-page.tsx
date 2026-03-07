import type { ChannelAutoPostButtonsMode, ChannelSettings } from '@maxim/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

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

function modeHasSuggest(mode: ChannelAutoPostButtonsMode): boolean {
  return mode === 'SUGGEST' || mode === 'BOTH';
}

function sanitizeAutoPostButtonsMode(
  mode: ChannelAutoPostButtonsMode,
  commentsEnabled: boolean,
  suggestEnabled: boolean,
): ChannelAutoPostButtonsMode {
  return buildAutoPostButtonsMode(
    commentsEnabled && modeHasComments(mode),
    suggestEnabled && modeHasSuggest(mode),
  );
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

function ChannelSettingsSectionHead({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="channel-settings-section-head">
      <div className="channel-settings-section-head__copy">
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
    </div>
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

function ChannelSettingsFeatureCard({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
}) {
  return (
    <label className={cn('channel-settings-feature-card', checked && 'is-active')}>
      <div className="channel-settings-feature-card__head">
        <div className="channel-settings-feature-card__identity">
          <span className="channel-settings-feature-card__icon" aria-hidden>
            {icon}
          </span>
          <div className="channel-settings-feature-card__copy">
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
        </div>

        <div className="channel-settings-feature-card__toggle">
          <span className={cn('channel-settings-feature-card__state', checked && 'is-on')}>
            {checked ? 'Вкл' : 'Выкл'}
          </span>
          <span className="settings-native-switch">
            <input
              type="checkbox"
              checked={checked}
              onChange={(event) => onChange(event.target.checked)}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </span>
        </div>
      </div>
    </label>
  );
}

function ChannelSettingsSaveNotice({
  state,
  onRetry,
}: {
  state: 'idle' | 'saving' | 'saved' | 'error';
  onRetry: () => void;
}) {
  if (state === 'idle') {
    return null;
  }

  return (
    <div className="channel-settings-save-float">
      <div className={cn('channel-settings-save-notice', `is-${state}`)}>
        <span className="channel-settings-save-notice__dot" aria-hidden />
        <span className="channel-settings-save-notice__text">
          {state === 'saving' ? 'Сохраняем' : state === 'saved' ? 'Сохранено' : 'Не сохранилось'}
        </span>
        {state === 'error' ? (
          <button type="button" className="channel-settings-save-notice__retry" onClick={onRetry}>
            Повторить
          </button>
        ) : null}
      </div>
    </div>
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

  const settingsQuery = useQuery({
    queryKey: ['channel-settings', chatId],
    queryFn: () => api.getChannelSettings(chatId),
    enabled: Boolean(chatId),
  });

  const channelsQuery = useQuery({
    queryKey: ['channels'],
    queryFn: () => api.getChannels(),
    enabled: Boolean(chatId),
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

    saveLastChatId(chatId);
    saveLastEntityType('channel');
    if (routeChatTitle) {
      saveChatTitle(chatId, routeChatTitle);
    }
  }, [chatId, routeChatTitle]);

  const resolvedTitle = useMemo(() => {
    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatId, routeChatTitle]);

  const resolvedChannelLink = useMemo(() => {
    if (routeChatLink) {
      return routeChatLink;
    }

    const candidate =
      channelsQuery.data?.find((channel) => channel.id === chatId)?.link?.trim() ?? '';
    return isHttpUrl(candidate) ? candidate : '';
  }, [chatId, channelsQuery.data, routeChatLink]);

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

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to="/" className="button button--accent">
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

  return (
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-header" elevated>
        <div className="channel-settings-hero__top">
          <Link to="/" className="button button--ghost channel-settings-hero__back">
            Назад
          </Link>
          <span className="channel-settings-hero__badge">Канал</span>
        </div>

        <div className="channel-settings-header__main">
          <h1>{resolvedTitle || 'Настройки'}</h1>
          <p>{chatId}</p>
        </div>
      </GlassCard>

      <ChannelSettingsSaveNotice
        state={autosaveState}
        onRetry={() => {
          lastFailedDraftKeyRef.current = null;
          void saveCurrentDraft({ force: true });
        }}
      />

      <GlassCard className="channel-settings-card" elevated>
        <ChannelSettingsSectionHead title="Сценарии" />

        <div className="channel-settings-feature-grid">
          <ChannelSettingsFeatureCard
            icon="💬"
            title="Комментарии"
            description="Диалог под постом."
            checked={draft.commentsEnabled}
            onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
          />

          <ChannelSettingsFeatureCard
            icon="📰"
            title="Идеи для постов"
            description="Идеи постов от подписчиков."
            checked={draft.postSuggestionsEnabled}
            onChange={(nextValue) => patchDraft('postSuggestionsEnabled', nextValue)}
          />
        </div>
      </GlassCard>

      {draft.postSuggestionsEnabled ? (
        <GlassCard className="channel-settings-card" elevated>
          <ChannelSettingsSectionHead title="Идеи для постов" />

          <div className="channel-settings-stack">
            <label className="field">
              <span>Название кнопки</span>
              <input
                type="text"
                value={draft.postSuggestionsButtonText}
                onChange={(event) => patchDraft('postSuggestionsButtonText', event.target.value)}
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
          </div>
        </GlassCard>
      ) : null}

      {draft.commentsEnabled ? (
        <GlassCard className="channel-settings-card" elevated>
          <ChannelSettingsSectionHead title="Комментарии" />

          <ChannelSettingsToggleCard
            title="Модерация"
            description="Бот следит за сообщениями."
            checked={draft.commentsModerationEnabled}
            onChange={(nextValue) => patchDraft('commentsModerationEnabled', nextValue)}
          />

          <div className="channel-settings-stack">
            <div className="channel-settings-inline-fields channel-settings-inline-fields--narrow">
              <label className="field">
                <span>Пауза между сообщениями, сек</span>
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
                            Math.min(3600, Number.parseInt(event.target.value || '0', 10)),
                          )
                        : 0,
                    )
                  }
                />
                <small className="field__hint">0 = без паузы</small>
              </label>
            </div>

            <label className="field">
              <span>Текст</span>
              <textarea
                rows={3}
                value={draft.commentsMessageText}
                onChange={(event) => patchDraft('commentsMessageText', event.target.value)}
                placeholder="Например: обсуждаем посты спокойно, без рекламы и оскорблений."
              />
            </label>
          </div>
        </GlassCard>
      ) : null}
    </div>
  );
}
