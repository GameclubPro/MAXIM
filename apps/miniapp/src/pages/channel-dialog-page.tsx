import type { ChannelDialogType } from '@maxim/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
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
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ChannelDialogPage({ api }: { api: ApiClient }) {
  const { chatId = '', mode } = useParams();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const dialogType = resolveDialogType(mode);
  const [draft, setDraft] = useState('');
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const screenTitle = dialogType === 'suggest' ? 'Предложить пост' : 'Обсуждение';
  const screenHint =
    dialogType === 'suggest'
      ? 'Напишите идею поста, она уйдёт админу в личку.'
      : 'Пишите комментарии в этом диалоге miniapp.';
  const chatTitle = useMemo(() => {
    return readChatTitle(chatId);
  }, [chatId]);

  const dialogQuery = useQuery({
    queryKey: ['channel-dialog', chatId, dialogType, token],
    queryFn: () => api.getChannelDialog(chatId, dialogType, token),
    enabled: Boolean(chatId && token),
    refetchInterval: dialogType === 'comments' ? 8_000 : false,
  });

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
          : 'Комментарий добавлен.';

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
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не найден"
            description="Откройте диалог заново из сообщения канала."
            action={
              <Link to="/" className="button button--accent">
                На главную
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="warning"
            title="Кнопка устарела"
            description="Откройте сообщение в канале и нажмите кнопку ещё раз."
            action={
              <Link to="/" className="button button--accent">
                На главную
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div className="page-stack page-enter">
      <GlassCard className="hero-card" elevated>
        <div className="page-header">
          <div className="page-header__main">
            <h1>{screenTitle}</h1>
            <p>{chatTitle ? `Канал: ${chatTitle}` : `ID канала: ${chatId}`}</p>
          </div>
        </div>
      </GlassCard>

      <GlassCard className="settings-section" elevated>
        <p className="field__hint">{screenHint}</p>

        <label className="field">
          <span>{dialogType === 'suggest' ? 'Текст предложки' : 'Ваш комментарий'}</span>
          <textarea
            rows={4}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={
              dialogType === 'suggest'
                ? 'Опишите идею поста: тема, текст, формат, когда лучше публиковать.'
                : 'Напишите комментарий...'
            }
            maxLength={2_000}
          />
          <small className="field__hint">{draft.length}/2000</small>
        </label>

        <div className="chat-card__actions">
          <button
            type="button"
            className="button button--accent"
            onClick={onSubmit}
            disabled={!draft.trim() || sendMutation.isPending}
          >
            {sendMutation.isPending
              ? 'Отправляем...'
              : dialogType === 'suggest'
                ? 'Отправить админу'
                : 'Отправить'}
          </button>
          <Link to="/" className="button button--ghost">
            На главную
          </Link>
        </div>
      </GlassCard>

      {dialogQuery.isLoading ? (
        <GlassCard className="settings-section">
          <SkeletonCard lines={6} />
        </GlassCard>
      ) : null}

      {dialogQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить диалог"
            description={normalizeApiError(dialogQuery.error)}
            action={
              <button type="button" className="button button--danger" onClick={() => void dialogQuery.refetch()}>
                Повторить
              </button>
            }
          />
        </GlassCard>
      ) : null}

      {!dialogQuery.isLoading && !dialogQuery.error ? (
        <div className="channel-dialog-list">
          {dialogQuery.data?.messages.length ? (
            dialogQuery.data.messages.map((message) => (
              <GlassCard key={message.id} className="channel-dialog-item" elevated>
                <div className="channel-dialog-item__head">
                  <strong>{message.authorDisplayName || message.authorUserId}</strong>
                  <small>{formatDateTime(message.createdAt)}</small>
                </div>
                <p>{message.text}</p>
                {dialogType === 'suggest' ? (
                  <small className="field__hint">
                    {message.delivered ? 'Доставлено админу' : 'Ожидает доставки админу'}
                  </small>
                ) : null}
              </GlassCard>
            ))
          ) : (
            <GlassCard>
              <StatusState
                tone="neutral"
                title="Пока пусто"
                description={
                  dialogType === 'suggest'
                    ? 'Отправьте первую идею поста.'
                    : 'Станьте первым, кто начнёт обсуждение.'
                }
              />
            </GlassCard>
          )}
        </div>
      ) : null}
    </div>
  );
}
