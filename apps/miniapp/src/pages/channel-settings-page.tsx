import type { ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastChatId, saveLastEntityType } from '../lib/last-chat';

function getRouteChatTitle(state: unknown): string {
  if (
    typeof state === 'object' &&
    state &&
    'chatTitle' in state &&
    typeof state.chatTitle === 'string'
  ) {
    return state.chatTitle.trim();
  }

  return '';
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

export function ChannelSettingsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeChatTitle = getRouteChatTitle(location.state);
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const { pushToast } = useToast();

  const settingsQuery = useQuery({
    queryKey: ['channel-settings', chatId],
    queryFn: () => api.getChannelSettings(chatId),
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

  const saveDraft = () => {
    if (!draft || saveMutation.isPending || !isDirty) {
      return;
    }

    saveMutation.mutate(draft);
  };

  return (
    <div className="page-stack page-enter">
      <GlassCard className="hero-card" elevated>
        <div className="page-header">
          <div className="page-header__main">
            <h1>Настройки канала</h1>
            <p>{resolvedTitle ? `Канал: ${resolvedTitle}` : 'Управление разделами канала'}</p>
          </div>
          <span className="page-header__badge">ID: {chatId}</span>
        </div>
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <h2>Предложить пост</h2>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.postSuggestionsEnabled}
              onChange={(event) => patchDraft('postSuggestionsEnabled', event.target.checked)}
            />{' '}
            Включить раздел
          </span>
        </label>

        <label className="field">
          <span>Текст подсказки</span>
          <textarea
            rows={3}
            value={draft.postSuggestionsText}
            onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
            placeholder="Опишите, как правильно предложить пост"
          />
        </label>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.postSuggestionsButtonEnabled}
              onChange={(event) => patchDraft('postSuggestionsButtonEnabled', event.target.checked)}
            />{' '}
            Показывать кнопку
          </span>
        </label>

        {draft.postSuggestionsButtonEnabled ? (
          <>
            <label className="field">
              <span>Текст кнопки</span>
              <input
                type="text"
                value={draft.postSuggestionsButtonText}
                onChange={(event) => patchDraft('postSuggestionsButtonText', event.target.value)}
                placeholder="Предложить пост"
                maxLength={32}
              />
            </label>

            <label className="field">
              <span>Ссылка кнопки</span>
              <input
                type="url"
                value={draft.postSuggestionsButtonUrl}
                onChange={(event) => patchDraft('postSuggestionsButtonUrl', event.target.value)}
                placeholder="https://max.ru/..."
              />
            </label>
          </>
        ) : null}
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <h2>Комментарии</h2>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.commentsEnabled}
              onChange={(event) => patchDraft('commentsEnabled', event.target.checked)}
            />{' '}
            Разрешить комментарии
          </span>
        </label>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.commentsModerationEnabled}
              onChange={(event) => patchDraft('commentsModerationEnabled', event.target.checked)}
            />{' '}
            Включить модерацию комментариев
          </span>
        </label>

        <label className="field">
          <span>Медленный режим (сек)</span>
          <input
            type="number"
            min={0}
            max={3600}
            value={draft.commentsSlowModeSeconds}
            onChange={(event) =>
              patchDraft(
                'commentsSlowModeSeconds',
                Number.isFinite(Number(event.target.value))
                  ? Math.max(0, Math.min(3600, Number.parseInt(event.target.value || '0', 10)))
                  : 0,
              )
            }
          />
        </label>

        <label className="field">
          <span>Текст для комментариев</span>
          <textarea
            rows={3}
            value={draft.commentsMessageText}
            onChange={(event) => patchDraft('commentsMessageText', event.target.value)}
            placeholder="Правила и подсказки для комментаторов"
          />
        </label>
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <div className="chat-card__actions">
          <button
            type="button"
            className="button button--accent"
            onClick={saveDraft}
            disabled={!isDirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить'}
          </button>
          <Link to="/" className="button button--ghost">
            К списку
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
