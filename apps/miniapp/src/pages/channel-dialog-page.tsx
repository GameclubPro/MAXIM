import type { ChannelDialogType } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { cn } from '../lib/cn';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle } from '../lib/chat-titles';

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось отправить сообщение.';
  }

  const normalized = error.message.trim();
  if (!normalized) {
    return 'Не удалось отправить сообщение.';
  }

  if (normalized.startsWith('API request failed:')) {
    const details = normalized.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось отправить сообщение.';
  }

  return normalized;
}

function resolveDialogType(mode: string | undefined): ChannelDialogType {
  return mode === 'suggest' ? 'suggest' : 'comments';
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelativeMoment(value: string | null): string {
  if (!value) {
    return 'Сейчас';
  }

  const date = new Date(value);
  const diffMs = Date.now() - date.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) {
    return 'Сейчас';
  }

  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) {
    return 'Только что';
  }
  if (diffMin < 60) {
    return `${diffMin} мин назад`;
  }

  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours} ч назад`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} д назад`;
}

function buildAuthorBadge(value: string | null | undefined): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    return 'MX';
  }

  const words = normalized
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);

  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}`.toUpperCase();
  }

  return normalized.slice(0, 2).toUpperCase();
}

type DialogViewModel = {
  eyebrow: string;
  title: string;
  subtitle: string;
  liveBadge: string;
  leadTitle: string;
  leadDescription: string;
  supportTitle: string;
  supportDescription: string;
  timelineTitle: string;
  timelineHint: string;
  inputLabel: string;
  inputPlaceholder: string;
  submitLabel: string;
  emptyTitle: string;
  emptyDescription: string;
  statusTone: 'live' | 'private';
};

function buildViewModel(dialogType: ChannelDialogType): DialogViewModel {
  if (dialogType === 'suggest') {
    return {
      eyebrow: 'Приватная предложка',
      title: 'Предложить новость',
      subtitle:
        'Отдельное окно для идей, анонсов и черновиков. Сообщение не уходит в публичную ленту и попадает админу напрямую.',
      liveBadge: 'Только для вас',
      leadTitle: 'Личный канал связи',
      leadDescription:
        'Опишите тему, тезисы и формат публикации. Если админ доступен в личке бота, идея уйдёт сразу.',
      supportTitle: 'Что написать',
      supportDescription:
        'Лучше всего работают короткий заголовок, суть новости, ссылка на источник и желаемое время публикации.',
      timelineTitle: 'Ваши идеи',
      timelineHint: 'Здесь видны только ваши отправки и статус доставки.',
      inputLabel: 'Текст предложки',
      inputPlaceholder: 'Например: короткая новость, ссылка, пара тезисов и почему это стоит выложить сегодня.',
      submitLabel: 'Отправить админу',
      emptyTitle: 'Пока нет предложек',
      emptyDescription: 'Отправьте первую идею. Она появится здесь отдельной карточкой.',
      statusTone: 'private',
    };
  }

  return {
    eyebrow: 'Живая комната канала',
    title: 'Комментарии',
    subtitle:
      'Отдельная комната обсуждения без экрана настроек. Пишите быстро, коротко и по делу, как в нативном чате.',
    liveBadge: 'Эфир обновляется',
    leadTitle: 'Обсуждение без шума',
    leadDescription:
      'Комментарии собираются в отдельном потоке miniapp. Новые сообщения подгружаются автоматически каждые несколько секунд.',
    supportTitle: 'Формат',
    supportDescription:
      'Подходит для реакции на пост, коротких уточнений и обратной связи без перехода в админские разделы.',
    timelineTitle: 'Лента обсуждения',
    timelineHint: 'Новые комментарии появляются в хронологическом порядке.',
    inputLabel: 'Ваш комментарий',
    inputPlaceholder: 'Напишите, что думаете о посте.',
    submitLabel: 'Отправить комментарий',
    emptyTitle: 'Обсуждение ещё не началось',
    emptyDescription: 'Откройте ленту первым и задайте тон разговору.',
    statusTone: 'live',
  };
}

export function ChannelDialogPage({ api }: { api: ApiClient }) {
  const { chatId = '', mode } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(mode);
  const [draft, setDraft] = useState('');
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const chatTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const view = useMemo(() => buildViewModel(dialogType), [dialogType]);

  const dialogQuery = useQuery({
    queryKey: ['channel-dialog', chatId, dialogType, token],
    queryFn: () => api.getChannelDialog(chatId, dialogType, token),
    enabled: Boolean(chatId && token),
    refetchInterval: dialogType === 'comments' ? 8_000 : false,
  });

  const messages = dialogQuery.data?.messages ?? [];
  const authorsCount = useMemo(
    () => new Set(messages.map((message) => message.authorUserId)).size,
    [messages],
  );
  const lastActivityAt = messages.at(-1)?.createdAt ?? null;
  const pendingSuggestionsCount = useMemo(
    () => messages.filter((message) => message.delivered === false).length,
    [messages],
  );

  const sendMutation = useMutation({
    mutationFn: (text: string) =>
      api.createChannelDialogMessage(chatId, dialogType, {
        token,
        text,
      }),
    onSuccess: (result) => {
      const deliveryHint =
        dialogType === 'suggest'
          ? result.message.delivered
            ? 'Идея отправлена админу.'
            : 'Идея сохранена. Админ ещё не открыл личку бота.'
          : 'Комментарий добавлен в ленту.';

      pushToast({
        tone: result.message.delivered === false ? 'info' : 'success',
        title: 'Готово',
        description: deliveryHint,
      });
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['channel-dialog', chatId, dialogType, token] });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Ошибка',
        description: normalizeApiError(error),
      });
    },
  });

  const onSubmit = () => {
    const text = draft.trim();
    if (!text || sendMutation.isPending || !chatId || !token) {
      return;
    }

    sendMutation.mutate(text);
  };

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <div className="glass-card glass-card--md">
          <StatusState
            tone="warning"
            title="Канал не найден"
            description="Откройте диалог заново из сообщения канала."
            action={
              <Link to="/" className="button button--accent">
                К списку
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-stack page-enter">
        <div className="glass-card glass-card--md">
          <StatusState
            tone="warning"
            title="Кнопка устарела"
            description="Откройте сообщение в канале и нажмите кнопку ещё раз."
            action={
              <Link to="/" className="button button--accent">
                К списку
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('channel-dialog-screen', `channel-dialog-screen--${dialogType}`, 'page-enter')}>
      <div className="channel-dialog-screen__backdrop" aria-hidden />
      <div className="channel-dialog-screen__glow channel-dialog-screen__glow--one" aria-hidden />
      <div className="channel-dialog-screen__glow channel-dialog-screen__glow--two" aria-hidden />

      <header className="channel-dialog-hero">
        <div className="channel-dialog-hero__topbar">
          <span className="channel-dialog-hero__eyebrow">{view.eyebrow}</span>
          <Link to="/" className="channel-dialog-hero__close">
            Закрыть
          </Link>
        </div>

        <div className="channel-dialog-hero__content">
          <div className="channel-dialog-hero__copy">
            <h1>{view.title}</h1>
            <p>{view.subtitle}</p>
          </div>

          <div className="channel-dialog-hero__chips">
            <span className={cn('channel-dialog-pill', `is-${view.statusTone}`)}>
              <span className="channel-dialog-pill__dot" aria-hidden />
              {view.liveBadge}
            </span>
            <span className="channel-dialog-pill is-neutral">
              {chatTitle ? `Канал: ${chatTitle}` : `ID: ${chatId}`}
            </span>
          </div>

          <div className="channel-dialog-stats">
            <div className="channel-dialog-stat">
              <strong>{messages.length}</strong>
              <span>{dialogType === 'suggest' ? 'идей отправлено' : 'сообщений в ленте'}</span>
            </div>
            <div className="channel-dialog-stat">
              <strong>{dialogType === 'suggest' ? pendingSuggestionsCount : authorsCount || 1}</strong>
              <span>
                {dialogType === 'suggest' ? 'ожидают доставки' : 'участников в обсуждении'}
              </span>
            </div>
            <div className="channel-dialog-stat">
              <strong>{formatRelativeMoment(lastActivityAt)}</strong>
              <span>последняя активность</span>
            </div>
          </div>
        </div>
      </header>

      <section className="channel-dialog-panels">
        <article className="channel-dialog-panel channel-dialog-panel--lead">
          <span className="channel-dialog-panel__label">Сценарий</span>
          <h2>{view.leadTitle}</h2>
          <p>{view.leadDescription}</p>
        </article>

        <article className="channel-dialog-panel channel-dialog-panel--support">
          <span className="channel-dialog-panel__label">Подсказка</span>
          <h2>{view.supportTitle}</h2>
          <p>{view.supportDescription}</p>
        </article>
      </section>

      <section className="channel-dialog-timeline">
        <div className="channel-dialog-timeline__head">
          <div>
            <span className="channel-dialog-panel__label">Поток</span>
            <h2>{view.timelineTitle}</h2>
          </div>
          <p>{view.timelineHint}</p>
        </div>

        {dialogQuery.isLoading ? (
          <div className="channel-dialog-skeletons" aria-label="Загрузка">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="channel-dialog-skeleton">
                <span className="channel-dialog-skeleton__avatar" />
                <div className="channel-dialog-skeleton__body">
                  <span className="channel-dialog-skeleton__line is-short" />
                  <span className="channel-dialog-skeleton__line" />
                  <span className="channel-dialog-skeleton__line is-mid" />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {dialogQuery.error ? (
          <div className="channel-dialog-error">
            <StatusState
              tone="danger"
              title="Не удалось загрузить поток"
              description={normalizeApiError(dialogQuery.error)}
              action={
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void dialogQuery.refetch()}
                >
                  Повторить
                </button>
              }
            />
          </div>
        ) : null}

        {!dialogQuery.isLoading && !dialogQuery.error ? (
          messages.length ? (
            <div className="channel-dialog-message-list">
              {messages.map((message) => (
                <article key={message.id} className="channel-dialog-message">
                  <div className="channel-dialog-message__avatar">
                    {buildAuthorBadge(message.authorDisplayName || message.authorUserId)}
                  </div>
                  <div className="channel-dialog-message__bubble">
                    <div className="channel-dialog-message__meta">
                      <strong>{message.authorDisplayName || `Участник ${message.authorUserId}`}</strong>
                      <span>{formatDateTime(message.createdAt)}</span>
                    </div>
                    <p>{message.text}</p>
                    {dialogType === 'suggest' ? (
                      <div className="channel-dialog-message__footer">
                        <span
                          className={cn(
                            'channel-dialog-delivery',
                            message.delivered ? 'is-delivered' : 'is-pending',
                          )}
                        >
                          {message.delivered ? 'Доставлено админу' : 'Ожидает открытия лички админом'}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="channel-dialog-empty">
              <h3>{view.emptyTitle}</h3>
              <p>{view.emptyDescription}</p>
            </div>
          )
        ) : null}
      </section>

      <section className="channel-dialog-compose">
        <div className="channel-dialog-compose__surface">
          <div className="channel-dialog-compose__head">
            <div>
              <span className="channel-dialog-panel__label">Новое сообщение</span>
              <h2>{view.inputLabel}</h2>
            </div>
            <span className="channel-dialog-compose__counter">{draft.length}/2000</span>
          </div>

          <label className="channel-dialog-compose__field">
            <textarea
              rows={5}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={view.inputPlaceholder}
              maxLength={2_000}
            />
          </label>

          <div className="channel-dialog-compose__actions">
            <button
              type="button"
              className="channel-dialog-submit"
              onClick={onSubmit}
              disabled={!draft.trim() || sendMutation.isPending}
            >
              {sendMutation.isPending ? 'Отправляем...' : view.submitLabel}
            </button>
            <Link to="/" className="channel-dialog-secondary">
              Вернуться к чатам
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
