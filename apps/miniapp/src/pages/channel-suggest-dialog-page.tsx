import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { isSessionExpiredApiMessage, isTerminalDialogApiMessage } from '../lib/api-error';
import { getChannelSuggestionRedirect } from '../lib/api/channel-dialog-client';
import type { ApiTransport } from '../lib/api/transport';
import { PREVIEW_CHANNEL_ID, PREVIEW_CHANNEL_TITLE } from '../lib/design-preview';
import { readChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute } from '../lib/last-chat';
import { openMaxBotLink, openMaxBotLinkAndClose } from '../lib/max-bridge';

function normalizeApiError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Не удалось открыть чат с ботом.';
  }

  const normalized = error.message.trim();
  if (!normalized) {
    return 'Не удалось открыть чат с ботом.';
  }

  if (normalized.startsWith('API request failed:')) {
    const details = normalized.replace(/^API request failed:\s*\d+\s*/u, '').trim();
    return details || 'Не удалось открыть чат с ботом.';
  }

  return normalized;
}

function resolveSuggestDialogTitle(chatId: string, storedTitle: string): string {
  const normalizedTitle = storedTitle.trim();
  if (normalizedTitle) {
    return normalizedTitle;
  }

  if (chatId === PREVIEW_CHANNEL_ID) {
    return PREVIEW_CHANNEL_TITLE;
  }

  return chatId;
}

export function ChannelSuggestDialogPage({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const token = searchParams.get('token')?.trim() ?? '';
  const storedTitle = useMemo(() => readChatTitle(chatId), [chatId]);
  const chatLabel = useMemo(
    () => resolveSuggestDialogTitle(chatId, storedTitle),
    [chatId, storedTitle],
  );
  const isPreviewChannel = chatId === PREVIEW_CHANNEL_ID;
  const launchErrorRedirectedRef = useRef(false);
  const redirectOpenedRef = useRef(false);
  const queryKey = ['channel-suggestion-redirect', chatId, token] as const;

  const redirectQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => getChannelSuggestionRedirect(api, chatId, token, { signal }),
    enabled: Boolean(chatId && token),
    retry: (failureCount, error) =>
      !isTerminalDialogApiMessage(normalizeApiError(error)) && failureCount < 1,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (launchErrorRedirectedRef.current) {
      return;
    }

    const message = redirectQuery.error ? normalizeApiError(redirectQuery.error) : '';
    if (!message || !isTerminalDialogApiMessage(message)) {
      return;
    }

    launchErrorRedirectedRef.current = true;
    void queryClient.cancelQueries({ queryKey });
    pushToast({
      tone: 'info',
      title: isSessionExpiredApiMessage(message)
        ? 'Откройте мини-приложение заново'
        : 'Диалог недоступен',
      description: message,
      durationMs: 4_000,
    });
    navigate(buildManagedEntitiesRoute('channel'), { replace: true });
  }, [navigate, pushToast, queryClient, queryKey, redirectQuery.error]);

  useEffect(() => {
    const url = redirectQuery.data?.url?.trim() ?? '';
    if (!url || isPreviewChannel || redirectOpenedRef.current) {
      return;
    }

    if (openMaxBotLinkAndClose(url)) {
      redirectOpenedRef.current = true;
    }
  }, [isPreviewChannel, redirectQuery.data?.url]);

  if (!chatId) {
    return (
      <div className="page-stack page-enter">
        <div className="glass-card glass-card--md">
          <StatusState
            tone="warning"
            title="Канал не найден"
            description="Откройте предложку заново из сообщения."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
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
            description="Откройте сообщение и нажмите кнопку ещё раз."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  const redirectUrl = redirectQuery.data?.url?.trim() ?? '';
  const redirectTitle = redirectQuery.data?.title?.trim() || chatLabel;
  const isRedirectLoading = redirectQuery.isLoading && !redirectUrl;

  return (
    <div className="page-stack page-enter">
      <div className="glass-card glass-card--md">
        <StatusState
          tone={redirectQuery.error ? 'danger' : 'neutral'}
          title={redirectQuery.error ? 'Не удалось открыть чат с ботом' : 'Открываем чат с ботом'}
          description={
            redirectQuery.error
              ? normalizeApiError(redirectQuery.error)
              : isRedirectLoading
                ? `Переводим в диалог с ботом для канала «${redirectTitle}».`
                : 'Если чат не открылся автоматически, нажмите кнопку ниже.'
          }
          action={
            redirectQuery.error ? (
              <div className="button-row">
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void redirectQuery.refetch()}
                >
                  Повторить
                </button>
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => navigate(buildManagedEntitiesRoute('channel'), { replace: true })}
                >
                  Назад
                </button>
              </div>
            ) : redirectUrl ? (
              <button
                type="button"
                className="button button--accent"
                onClick={() => {
                  if (isPreviewChannel) {
                    openMaxBotLink(redirectUrl);
                    return;
                  }

                  openMaxBotLinkAndClose(redirectUrl);
                }}
              >
                Открыть чат
              </button>
            ) : null
          }
        />
      </div>
    </div>
  );
}
