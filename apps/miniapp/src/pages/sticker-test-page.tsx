import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { GlassCard } from '../components/ui/glass-card';
import { BackChevronIcon, ParticipantsIcon } from '../components/ui/entity-header-icons';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import type { ApiClient } from '../lib/api-client';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { saveLastEntityId } from '../lib/last-chat';

function getRouteChatTitle(state: unknown): string {
  if (!state || typeof state !== 'object') {
    return '';
  }

  if (!('chatTitle' in state)) {
    return '';
  }

  return typeof state.chatTitle === 'string' ? state.chatTitle.trim() : '';
}

function formatParticipantsCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return new Intl.NumberFormat('ru-RU').format(value);
}

export function StickerTestPage({ api }: { api: ApiClient }) {
  const { chatId } = useParams();
  const location = useLocation();
  const routeChatTitle = getRouteChatTitle(location.state);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  const settingsQuery = useQuery({
    queryKey: ['settings', chatId],
    queryFn: () => api.getSettings(chatId ?? ''),
    enabled: Boolean(chatId),
    refetchOnWindowFocus: false,
  });

  const chatHeaderQuery = useQuery({
    queryKey: ['chat-header', chatId],
    queryFn: () => api.getChatHeader(chatId ?? ''),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    const fromHeader = chatHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatHeaderQuery.data?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  const participantsCountLabel = formatParticipantsCount(
    chatHeaderQuery.data?.participantsCount ?? null,
  );
  const stickerModeLabel = settingsQuery.data?.stickerMessageCooldownEnabled
    ? `1 стикер раз в ${settingsQuery.data.stickerMessageCooldownMinutes} мин`
    : 'Лимит выключен';
  const stickerModeDescription = settingsQuery.data?.stickerMessageCooldownEnabled
    ? 'Первое сообщение со стикером проходит, повтор в интервале должен удаляться.'
    : 'Сейчас отдельного ограничения на частоту стикеров нет.';
  const photoModeLabel = settingsQuery.data?.photoMessageCooldownEnabled
    ? `Фото: 1 раз в ${settingsQuery.data.photoMessageCooldownHours} ч`
    : 'Фото без отдельного лимита';

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Откройте раздел из настроек конкретного чата."
        />
      </GlassCard>
    );
  }

  return (
    <div className="sticker-test-screen">
      <header className="settings-page-header sticker-test-header">
        <div className="settings-page-header__top">
          <Link
            to={`/chat/${chatId}/settings`}
            state={chatTitle ? { chatTitle } : undefined}
            className="settings-page-header__back"
            aria-label="Назад к настройкам чата"
          >
            <BackChevronIcon />
          </Link>

          <div className="settings-page-header__body">
            <div className="settings-page-header__title-row">
              <div className="settings-page-header__identity">
                <h2 className="settings-page-header__title">Стикеры</h2>
                <p className="settings-page-header__meta">
                  {chatTitle || chatId}
                  {chatTitle && chatTitle !== chatId ? ` • ID ${chatId}` : ' • Тестовый экран'}
                </p>
              </div>
              <span className="sticker-test-header__badge">Тест</span>
            </div>

            <div className="sticker-test-header__footer">
              {participantsCountLabel ? (
                <span
                  className="settings-page-header__members"
                  aria-label={`Участников: ${participantsCountLabel}`}
                >
                  <ParticipantsIcon />
                  <span>{participantsCountLabel}</span>
                </span>
              ) : null}

              <Link
                to={`/chat/${chatId}/settings`}
                state={chatTitle ? { chatTitle } : undefined}
                className="settings-page-header__quick-link"
              >
                К настройкам
              </Link>
            </div>
          </div>
        </div>
      </header>

      {settingsQuery.isLoading ? (
        <>
          <GlassCard className="sticker-test-hero" padding="lg">
            <SkeletonCard lines={3} />
          </GlassCard>
          <GlassCard>
            <SkeletonCard lines={4} />
          </GlassCard>
        </>
      ) : null}

      {settingsQuery.error ? (
        <GlassCard>
          <StatusState
            tone="danger"
            title="Не удалось загрузить настройки стикеров"
            description={settingsQuery.error instanceof Error ? settingsQuery.error.message : ''}
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
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && settingsQuery.data ? (
        <>
          <GlassCard className="sticker-test-hero" padding="lg">
            <div className="sticker-test-hero__top">
              <span className="sticker-test-hero__eyebrow">Тестовый раздел</span>
              <span
                className={`sticker-test-hero__status${
                  settingsQuery.data.stickerMessageCooldownEnabled ? ' is-active' : ''
                }`}
              >
                {stickerModeLabel}
              </span>
            </div>

            <div className="sticker-test-hero__main">
              <div className="sticker-test-hero__copy">
                <h1>Проверка сценария со стикерами</h1>
                <p>
                  Быстрый экран для ручной проверки ограничения частоты стикеров без поиска нужного
                  блока внутри общих настроек.
                </p>
              </div>
            </div>

            <div className="sticker-test-grid">
              <article className="sticker-test-card">
                <small>Текущий режим</small>
                <strong>{stickerModeLabel}</strong>
                <p>{stickerModeDescription}</p>
              </article>

              <article className="sticker-test-card">
                <small>Связь с фото</small>
                <strong>{photoModeLabel}</strong>
                <p>Стикеры считаются отдельно и не попадают в лимит фото.</p>
              </article>
            </div>
          </GlassCard>

          <GlassCard className="sticker-test-checklist">
            <div className="sticker-test-section-head">
              <h3>Что проверить</h3>
              <p>Минимальный чек для ручного прогона в чате.</p>
            </div>

            <ol className="sticker-test-steps">
              <li>Отправьте в чат один стикер от обычного пользователя.</li>
              <li>
                Повторите отправку ещё одного стикера в течение{' '}
                {settingsQuery.data.stickerMessageCooldownEnabled
                  ? `${settingsQuery.data.stickerMessageCooldownMinutes} мин`
                  : 'короткого интервала'}
                .
              </li>
              <li>Проверьте, что повтор попадает под модерацию только при включённом лимите.</li>
              <li>Отправьте фото и убедитесь, что оно не триггерит sticker-ограничение.</li>
            </ol>
          </GlassCard>
        </>
      ) : null}
    </div>
  );
}
