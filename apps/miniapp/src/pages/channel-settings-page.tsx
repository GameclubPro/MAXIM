import type { ChannelSettings } from '@maxim/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
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

function ChannelSettingsSectionHead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="channel-settings-section-head">
      <span className="channel-settings-section-head__eyebrow">{eyebrow}</span>
      <div className="channel-settings-section-head__copy">
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function ChannelSettingsStatusPill({
  icon,
  label,
  enabled,
  tone,
}: {
  icon: string;
  label: string;
  enabled: boolean;
  tone: 'blue' | 'orange' | 'emerald';
}) {
  return (
    <span
      className={cn(
        'channel-settings-status-pill',
        `channel-settings-status-pill--${tone}`,
        enabled ? 'is-on' : 'is-off',
      )}
    >
      <span>{`${icon} ${label}`}</span>
      <strong>{enabled ? 'вкл' : 'выкл'}</strong>
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
  description: string;
  checked: boolean;
  onChange: (nextValue: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn('channel-settings-toggle-card', disabled && 'is-disabled')}>
      <div className="channel-settings-toggle-card__copy">
        <strong>{title}</strong>
        <span>{description}</span>
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

export function ChannelSettingsPage({ api }: { api: ApiClient }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const routeState = getRouteState(location.state);
  const routeChatTitle = routeState.chatTitle;
  const routeChatLink = routeState.chatLink;
  const [draft, setDraft] = useState<ChannelSettings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<ChannelSettings | null>(null);
  const [engagementText, setEngagementText] = useState(
    'Есть идея или обратная связь? Нажмите кнопку ниже.',
  );
  const [engagementCommentsButtonText, setEngagementCommentsButtonText] =
    useState('💬 Комментарии');
  const [engagementSuggestButtonText, setEngagementSuggestButtonText] =
    useState('📰 Предложить пост');
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
    mutationFn: () =>
      api.publishChannelEngagement(chatId, {
        text: engagementText,
        commentsButtonText: engagementCommentsButtonText,
        suggestButtonText: engagementSuggestButtonText,
      }),
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
    <div className="channel-settings-screen page-enter">
      <GlassCard className="channel-settings-hero" elevated>
        <div className="channel-settings-hero__top">
          <div className="channel-settings-hero__identity">
            <span className="channel-settings-hero__eyebrow">Управление каналом</span>
            <h1>{resolvedTitle || 'Настройки канала'}</h1>
            <p>Только нужные сценарии для подписчиков: пост с кнопками, предложка и обсуждение.</p>
          </div>
          <span className="page-header__badge">ID: {chatId}</span>
        </div>

        <div className="channel-settings-hero__status">
          <ChannelSettingsStatusPill
            icon="📰"
            label="Предложка"
            enabled={draft.postSuggestionsEnabled}
            tone="orange"
          />
          <ChannelSettingsStatusPill
            icon="💬"
            label="Комментарии"
            enabled={draft.commentsEnabled}
            tone="blue"
          />
          <ChannelSettingsStatusPill
            icon="🛡️"
            label="Модерация"
            enabled={draft.commentsModerationEnabled}
            tone="emerald"
          />
        </div>

        <div className="channel-settings-hero__actions">
          {resolvedChannelLink ? (
            <a
              className="button button--ghost"
              href={resolvedChannelLink}
              target="_blank"
              rel="noreferrer"
            >
              Открыть канал
            </a>
          ) : null}
          <button
            type="button"
            className="button button--accent"
            onClick={saveDraft}
            disabled={!isDirty || saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Сохраняем...' : isDirty ? 'Сохранить' : 'Сохранено'}
          </button>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card channel-settings-card--engagement" elevated>
        <ChannelSettingsSectionHead
          eyebrow="Пост"
          title="Кнопки под постом"
          description="Подписчик видит два понятных действия без лишнего текста."
        />

        <div className="channel-settings-preview">
          <span>{engagementCommentsButtonText.trim() || '💬 Комментарии'}</span>
          <span>{engagementSuggestButtonText.trim() || '📰 Предложить пост'}</span>
        </div>

        <label className="field">
          <span>Текст поста</span>
          <textarea
            rows={3}
            value={engagementText}
            onChange={(event) => setEngagementText(event.target.value)}
            placeholder="Есть идея или обратная связь? Нажмите кнопку ниже."
            maxLength={2_000}
          />
        </label>

        <div className="channel-settings-inline-fields">
          <label className="field">
            <span>Первая кнопка</span>
            <input
              type="text"
              value={engagementCommentsButtonText}
              onChange={(event) => setEngagementCommentsButtonText(event.target.value)}
              maxLength={32}
            />
          </label>
          <label className="field">
            <span>Вторая кнопка</span>
            <input
              type="text"
              value={engagementSuggestButtonText}
              onChange={(event) => setEngagementSuggestButtonText(event.target.value)}
              maxLength={32}
            />
          </label>
        </div>

        <div className="channel-settings-card__footer">
          <p className="channel-settings-muted">
            В канале они будут стоять друг под другом на всю ширину.
          </p>
          <button
            type="button"
            className="button button--accent"
            onClick={() => publishEngagementMutation.mutate()}
            disabled={
              publishEngagementMutation.isPending ||
              !engagementText.trim() ||
              !engagementCommentsButtonText.trim() ||
              !engagementSuggestButtonText.trim()
            }
          >
            {publishEngagementMutation.isPending ? 'Публикуем...' : 'Опубликовать пост'}
          </button>
        </div>
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <ChannelSettingsSectionHead
          eyebrow="Предложка"
          title="Приём идей от подписчиков"
          description="Короткая подсказка и одна кнопка перехода."
        />

        <ChannelSettingsToggleCard
          title="Включить предложку"
          description="Показывать подписчикам, куда отправлять идеи для постов."
          checked={draft.postSuggestionsEnabled}
          onChange={(nextValue) => patchDraft('postSuggestionsEnabled', nextValue)}
        />

        {draft.postSuggestionsEnabled ? (
          <div className="channel-settings-stack">
            <label className="field">
              <span>Короткая инструкция</span>
              <textarea
                rows={3}
                value={draft.postSuggestionsText}
                onChange={(event) => patchDraft('postSuggestionsText', event.target.value)}
                placeholder="Например: отправьте текст и фото, ответим после проверки."
              />
            </label>

            <ChannelSettingsToggleCard
              title="Показывать кнопку"
              description="Подписчик увидит переход по ссылке без лишних шагов."
              checked={draft.postSuggestionsButtonEnabled}
              onChange={(nextValue) => patchDraft('postSuggestionsButtonEnabled', nextValue)}
            />

            {draft.postSuggestionsButtonEnabled ? (
              <div className="channel-settings-stack channel-settings-stack--tight">
                <div className="channel-settings-inline-fields">
                  <label className="field">
                    <span>Текст кнопки</span>
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
                    <span>Ссылка</span>
                    <input
                      type="url"
                      value={draft.postSuggestionsButtonUrl}
                      onChange={(event) =>
                        patchDraft('postSuggestionsButtonUrl', event.target.value)
                      }
                      placeholder="https://max.ru/channel/..."
                    />
                  </label>
                </div>

                <div className="channel-settings-inline-actions">
                  {resolvedChannelLink ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={useDetectedChannelLink}
                    >
                      Подставить ссылку
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={useChannelLinkTemplate}
                  >
                    Вставить шаблон
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </GlassCard>

      <GlassCard className="channel-settings-card" elevated>
        <ChannelSettingsSectionHead
          eyebrow="Комментарии"
          title="Обсуждение через mini app"
          description="Понятный сценарий для подписчиков без лишнего шума."
        />

        <div className="channel-settings-quiet-note">
          Реакции в канале по-прежнему включаются вручную в MAX.
        </div>

        <ChannelSettingsToggleCard
          title="Включить комментарии"
          description="Открывать отдельное окно обсуждения под постом."
          checked={draft.commentsEnabled}
          onChange={(nextValue) => patchDraft('commentsEnabled', nextValue)}
        />

        <ChannelSettingsToggleCard
          title="Включить модерацию"
          description="Бот будет следить за сообщениями внутри обсуждения."
          checked={draft.commentsModerationEnabled}
          onChange={(nextValue) => patchDraft('commentsModerationEnabled', nextValue)}
          disabled={!draft.commentsEnabled}
        />

        {draft.commentsEnabled ? (
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
        ) : null}
      </GlassCard>

      <GlassCard className="channel-settings-actionbar" elevated>
        <div className="channel-settings-actionbar__meta">
          <strong>{isDirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}</strong>
          <span>Обычному администратору должно быть понятно с первого захода.</span>
        </div>
        <div className="channel-settings-actionbar__actions">
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
