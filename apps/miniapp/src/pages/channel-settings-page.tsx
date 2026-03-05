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

type ChannelRouteState = {
  chatTitle: string;
  chatLink: string;
};

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

export function ChannelSettingsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
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

    const candidate = channelsQuery.data?.find((channel) => channel.id === chatId)?.link?.trim() ?? '';
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

  const useDetectedChannelLink = () => {
    if (!resolvedChannelLink) {
      return;
    }

    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        postSuggestionsButtonEnabled: true,
        postSuggestionsButtonUrl: resolvedChannelLink,
        postSuggestionsButtonText: current.postSuggestionsButtonText.trim() || 'Предложить пост',
      };
    });
  };

  const useChannelLinkTemplate = () => {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        postSuggestionsButtonEnabled: true,
        postSuggestionsButtonUrl: 'https://max.ru/channel/ваш_канал',
        postSuggestionsButtonText: current.postSuggestionsButtonText.trim() || 'Предложить пост',
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
            <p>{resolvedTitle ? `Канал: ${resolvedTitle}` : 'Простая настройка для подписчиков канала'}</p>
          </div>
          <span className="page-header__badge">ID: {chatId}</span>
        </div>
      </GlassCard>

      <GlassCard>
        <StatusState
          tone="warning"
          title="Важно: права участников включаются в MAX"
          description="Комментарии и приём предложенных постов включаются в самом канале MAX. Здесь вы настраиваете подсказки, кнопку и правила работы бота."
        />
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <h2>Предложить пост</h2>
        <p className="field__hint">
          Если включить, бот покажет участникам понятную инструкцию и кнопку, куда отправлять пост.
        </p>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.postSuggestionsEnabled}
              onChange={(event) => patchDraft('postSuggestionsEnabled', event.target.checked)}
            />{' '}
            Включить подсказку «Предложить пост»
          </span>
        </label>

        <label className="field">
          <span>Что увидят участники</span>
          <textarea
            rows={3}
            value={draft.postSuggestionsText}
            onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
            placeholder="Например: отправьте текст и фото через форму, ответ придёт в течение дня."
          />
          <small className="field__hint">Пишите простыми словами, как в обычном сообщении.</small>
        </label>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.postSuggestionsButtonEnabled}
              onChange={(event) => patchDraft('postSuggestionsButtonEnabled', event.target.checked)}
            />{' '}
            Показать кнопку для перехода
          </span>
        </label>

        {draft.postSuggestionsButtonEnabled ? (
          <>
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
              <span>Ссылка, куда ведёт кнопка</span>
              <input
                type="url"
                value={draft.postSuggestionsButtonUrl}
                onChange={(event) => patchDraft('postSuggestionsButtonUrl', event.target.value)}
                placeholder="https://max.ru/channel/..."
              />
              <small className="field__hint">
                Если не знаете ссылку: в MAX откройте канал → Поделиться → Скопировать ссылку.
              </small>
            </label>

            <div className="chat-card__actions">
              {resolvedChannelLink ? (
                <button type="button" className="button button--ghost" onClick={useDetectedChannelLink}>
                  Подставить ссылку канала
                </button>
              ) : null}
              <button type="button" className="button button--ghost" onClick={useChannelLinkTemplate}>
                Вставить шаблон
              </button>
            </div>
          </>
        ) : null}
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <h2>Комментарии</h2>
        <p className="field__hint">
          Здесь настраиваются подсказки и правила бота для комментариев. Включение самих комментариев делается в
          настройках канала MAX.
        </p>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.commentsEnabled}
              onChange={(event) => patchDraft('commentsEnabled', event.target.checked)}
            />{' '}
            Комментарии включены в канале
          </span>
          <small className="field__hint">Это флаг состояния для интерфейса и команды.</small>
        </label>

        <label className="field">
          <span>
            <input
              type="checkbox"
              checked={draft.commentsModerationEnabled}
              onChange={(event) => patchDraft('commentsModerationEnabled', event.target.checked)}
            />{' '}
            Включить модерацию комментариев ботом
          </span>
        </label>

        <label className="field">
          <span>Пауза между комментариями (сек)</span>
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
          <small className="field__hint">0 = без ограничения.</small>
        </label>

        <label className="field">
          <span>Подсказка для комментаторов</span>
          <textarea
            rows={3}
            value={draft.commentsMessageText}
            onChange={(event) => patchDraft('commentsMessageText', event.target.value)}
            placeholder="Например: без оскорблений и рекламы, нарушители блокируются автоматически."
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
            {saveMutation.isPending ? 'Сохраняем...' : 'Сохранить изменения'}
          </button>
          <Link to="/" className="button button--ghost">
            К списку
          </Link>
        </div>
      </GlassCard>
    </div>
  );
}
