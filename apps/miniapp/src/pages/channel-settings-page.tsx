import type { ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient, PublishChannelEngagementPayload } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

const DEFAULT_ENGAGEMENT_TEXT = 'Есть идея или обратная связь? Нажмите кнопку ниже.';
const DEFAULT_COMMENTS_BUTTON_TEXT = '💬 Комментарии';
const DEFAULT_SUGGEST_BUTTON_TEXT = '📰 Предложить пост';

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

function normalizeChannelSettingsDraft(
  draft: ChannelSettings,
  resolvedChannelLink: string,
): ChannelSettings {
  return {
    ...draft,
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
  const [engagementText, setEngagementText] = useState(DEFAULT_ENGAGEMENT_TEXT);
  const { pushToast } = useToast();

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

  const saveMutation = useMutation({
    mutationFn: async (payload: ChannelSettings) => api.updateChannelSettings(chatId, payload),
    onSuccess: (payload) => {
      setDraft(payload);
      setSavedSnapshot(payload);
      pushToast({
        tone: 'success',
        title: 'Сохранено',
        description: 'Настройки канала обновлены.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка сохранения',
        description: normalizeApiError(error),
      });
    },
  });

  const publishEngagementMutation = useMutation({
    mutationFn: (payload: PublishChannelEngagementPayload) =>
      api.publishChannelEngagement(chatId, payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Опубликовано',
        description: 'Сообщение с кнопками отправлено в канал.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось опубликовать',
        description: normalizeApiError(error),
      });
    },
  });

  useEffect(() => {
    if (!settingsQuery.data) {
      return;
    }

    setDraft(settingsQuery.data);
    setSavedSnapshot(settingsQuery.data);
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

  const isDirty = useMemo(() => {
    if (!draft || !savedSnapshot) {
      return false;
    }

    return JSON.stringify(draft) !== JSON.stringify(savedSnapshot);
  }, [draft, savedSnapshot]);

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
            title="Не удалось загрузить настройки канала"
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

  const patchDraft = <K extends keyof ChannelSettings>(key: K, value: ChannelSettings[K]) => {
    setDraft((current) => {
      if (!current) {
        return current;
      }
      return {
        ...current,
        [key]: value,
      };
    });
  };

  const toggleEngagementOption = (key: 'commentsEnabled' | 'postSuggestionsEnabled') => {
    if (!draft) {
      return;
    }

    const otherKey = key === 'commentsEnabled' ? 'postSuggestionsEnabled' : 'commentsEnabled';
    const nextValue = !draft[key];
    if (!nextValue && !draft[otherKey]) {
      pushToast({
        tone: 'info',
        title: 'Нужна хотя бы одна кнопка',
        description: 'Оставьте комментарии, предложку или оба варианта.',
      });
      return;
    }

    patchDraft(key, nextValue);
  };

  const saveDraft = async () => {
    if (!draft || saveMutation.isPending || !isDirty) {
      return;
    }

    await saveMutation.mutateAsync(normalizeChannelSettingsDraft(draft, resolvedChannelLink));
  };

  const handlePublishEngagement = async () => {
    if (!draft || publishEngagementMutation.isPending || saveMutation.isPending) {
      return;
    }

    const normalizedDraft = normalizeChannelSettingsDraft(draft, resolvedChannelLink);
    if (!normalizedDraft.commentsEnabled && !normalizedDraft.postSuggestionsEnabled) {
      pushToast({
        tone: 'info',
        title: 'Нечего публиковать',
        description: 'Включите комментарии, предложку или оба варианта.',
      });
      return;
    }

    try {
      if (isDirty) {
        await saveMutation.mutateAsync(normalizeChannelSettingsDraft(draft, resolvedChannelLink));
      }

      await publishEngagementMutation.mutateAsync({
        text: engagementText,
        commentsButtonText: DEFAULT_COMMENTS_BUTTON_TEXT,
        suggestButtonText:
          normalizedDraft.postSuggestionsButtonText.trim() || DEFAULT_SUGGEST_BUTTON_TEXT,
        includeCommentsButton: normalizedDraft.commentsEnabled,
        includeSuggestButton: normalizedDraft.postSuggestionsEnabled,
      });
    } catch {
      return;
    }
  };

  const engagementButtons = [
    draft.commentsEnabled ? DEFAULT_COMMENTS_BUTTON_TEXT : null,
    draft.postSuggestionsEnabled
      ? draft.postSuggestionsButtonText.trim() || DEFAULT_SUGGEST_BUTTON_TEXT
      : null,
  ].filter((value): value is string => Boolean(value));

  return (
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-header" elevated>
        <div className="channel-settings-header__main">
          <h1>{resolvedTitle || 'Настройки канала'}</h1>
          <p>{chatId}</p>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card channel-settings-card--engagement" elevated>
        <ChannelSettingsSectionHead
          title="Кнопки под постом"
          description="Бот прикрепит выбранные варианты автоматически"
        />

        <div className="channel-settings-choice-grid">
          <button
            type="button"
            className={cn('channel-settings-choice', draft.commentsEnabled && 'is-active')}
            onClick={() => toggleEngagementOption('commentsEnabled')}
          >
            {DEFAULT_COMMENTS_BUTTON_TEXT}
          </button>
          <button
            type="button"
            className={cn('channel-settings-choice', draft.postSuggestionsEnabled && 'is-active')}
            onClick={() => toggleEngagementOption('postSuggestionsEnabled')}
          >
            {draft.postSuggestionsButtonText.trim() || DEFAULT_SUGGEST_BUTTON_TEXT}
          </button>
        </div>

        <div className="channel-settings-preview">
          {engagementButtons.map((buttonText) => (
            <span key={buttonText}>{buttonText}</span>
          ))}
        </div>

        <label className="field">
          <span>Текст поста</span>
          <textarea
            rows={3}
            value={engagementText}
            onChange={(event) => setEngagementText(event.target.value)}
            placeholder={DEFAULT_ENGAGEMENT_TEXT}
            maxLength={2_000}
          />
        </label>

        <div className="channel-settings-card__footer">
          <button
            type="button"
            className="button button--accent"
            onClick={() => void handlePublishEngagement()}
            disabled={
              saveMutation.isPending ||
              publishEngagementMutation.isPending ||
              !engagementText.trim() ||
              engagementButtons.length === 0
            }
          >
            {publishEngagementMutation.isPending ? 'Публикуем...' : 'Опубликовать пост'}
          </button>
        </div>
      </GlassCard>

      {draft.postSuggestionsEnabled ? (
        <GlassCard className="channel-settings-card" elevated>
          <ChannelSettingsSectionHead title="Предложка" />

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
              <span>Короткая инструкция</span>
              <textarea
                rows={3}
                value={draft.postSuggestionsText}
                onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                placeholder="Например: отправьте текст и фото, ответим после проверки."
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
              <span>Что увидят участники</span>
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

      {isDirty || saveMutation.isPending ? (
        <GlassCard className="channel-settings-savebar" elevated>
          <button
            type="button"
            className="button button--accent"
            onClick={() => void saveDraft()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
          </button>
        </GlassCard>
      ) : null}
    </div>
  );
}
