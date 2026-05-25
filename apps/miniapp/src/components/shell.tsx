import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import {
  bindMaxBackButton,
  closeMaxMiniApp,
  maxImpact,
  setMaxBackButtonVisible,
} from '../lib/max-bridge';
import {
  buildManagedEntitiesRoute,
  hydrateLastEntityState,
  normalizeEntityType,
  readLastEntityId,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
  type LastEntityType,
} from '../lib/last-chat';
import { runNativeBackHandlers, useNativeBackHandlersAvailable } from '../lib/native-back';
import { useKeyboardOpen } from '../lib/use-keyboard-open';

type ScreenInfo = {
  title: string;
  subtitle: string;
};

type BottomNavIconName = 'chats' | 'channels' | 'settings' | 'events';

function BottomNavIcon({ name }: { name: BottomNavIconName }) {
  if (name === 'chats') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="bottom-nav__icon-svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 6.5h10A3.5 3.5 0 0 1 20.5 10v4a3.5 3.5 0 0 1-3.5 3.5h-4.8L8 21v-3.5H7A3.5 3.5 0 0 1 3.5 14v-4A3.5 3.5 0 0 1 7 6.5Z" />
        <path d="M9 11.2h6M9 14h4.1" />
      </svg>
    );
  }

  if (name === 'settings') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="bottom-nav__icon-svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M4.5 7h2.6M11.1 7h8.4" />
        <circle cx="9.1" cy="7" r="2" />
        <path d="M4.5 12h8.6M17.1 12h2.4" />
        <circle cx="15.1" cy="12" r="2" />
        <path d="M4.5 17h5M13.5 17h6" />
        <circle cx="11.5" cy="17" r="2" />
      </svg>
    );
  }

  if (name === 'channels') {
    return (
      <svg
        viewBox="0 0 24 24"
        className="bottom-nav__icon-svg"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.25 13.8V10.2C6.25 9.15 7.1 8.3 8.15 8.3H9.45C11.58 8.3 13.62 7.45 15.12 5.95L16.3 4.77C16.78 4.29 17.6 4.63 17.6 5.31V18.69C17.6 19.37 16.78 19.71 16.3 19.23L15.12 18.05C13.62 16.55 11.58 15.7 9.45 15.7H8.15C7.1 15.7 6.25 14.85 6.25 13.8Z" />
        <path d="M6.2 15.3L5.1 18.1C4.84 18.74 5.31 19.45 5.99 19.45H7.13" />
        <path d="M19.4 8.3C20.47 9.31 21.08 10.72 21.08 12.2C21.08 13.68 20.47 15.09 19.4 16.1" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="bottom-nav__icon-svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.85"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.2" />
      <path d="M8.8 8.7h6.4M8.8 12h6.4M8.8 15.3h4.1" />
      <circle cx="6.8" cy="8.7" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="6.8" cy="12" r="0.5" fill="currentColor" stroke="none" />
      <circle cx="6.8" cy="15.3" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function resolveScreenInfo(pathname: string, chatLabel: string): ScreenInfo {
  if (pathname === '/system') {
    return {
      title: 'Операционный центр',
      subtitle: 'Состояние webhook, очередей и MAX-лимитов в одном экране.',
    };
  }

  if (pathname.startsWith('/legal/')) {
    return {
      title: 'Правовые документы',
      subtitle: 'Условия использования и обработка данных MAXIM.',
    };
  }

  if (pathname.includes('/giveaways/')) {
    return {
      title: 'Розыгрыш',
      subtitle: chatLabel || 'Участие и итоги в одном экране.',
    };
  }

  if (
    pathname.includes('/dialog/') &&
    (pathname.includes('/channel/') || pathname.includes('/chat/'))
  ) {
    const isSuggest = pathname.includes('/dialog/suggest');
    const entityLabel = pathname.includes('/channel/') ? 'Канал' : 'Чат';
    return {
      title: isSuggest ? 'Идея для поста' : 'Обсуждение',
      subtitle: chatLabel
        ? `${entityLabel}: ${chatLabel}`
        : isSuggest
          ? 'Отправка идеи поста админу.'
          : 'Диалог обсуждения в приложении.',
    };
  }

  if (pathname.includes('/channel/') && pathname.includes('/settings')) {
    return {
      title: 'Настройки',
      subtitle: chatLabel ? `Канал: ${chatLabel}` : 'Выберите канал для настройки.',
    };
  }

  if (pathname.includes('/channel/') && pathname.includes('/stats')) {
    return {
      title: 'Статистика',
      subtitle: chatLabel ? `Канал: ${chatLabel}` : 'Выберите канал, чтобы посмотреть сводку.',
    };
  }

  if (pathname.includes('/settings')) {
    return {
      title: 'Настройки модерации',
      subtitle: chatLabel ? `Чат: ${chatLabel}` : 'Выберите чат, чтобы изменить правила.',
    };
  }

  if (pathname.includes('/events')) {
    return {
      title: 'Статистика',
      subtitle: chatLabel ? `Чат: ${chatLabel}` : 'Выберите чат, чтобы посмотреть статистику.',
    };
  }

  return {
    title: 'Ваши чаты',
    subtitle: 'Управляйте правилами и смотрите статистику в одном месте.',
  };
}

export function Shell() {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [lastEntityIds, setLastEntityIds] = useState<Record<LastEntityType, string>>(() => ({
    chat: readLastEntityId('chat'),
    channel: readLastEntityId('channel'),
  }));
  const [lastEntityType, setLastEntityType] = useState<LastEntityType>(() => readLastEntityType());
  const isKeyboardOpen = useKeyboardOpen();
  const hasNativeBackHandlers = useNativeBackHandlersAvailable();
  const isChatsRoute = location.pathname === '/';
  const selectedRootEntityType = useMemo(
    () => normalizeEntityType(new URLSearchParams(location.search).get('view'), lastEntityType),
    [lastEntityType, location.search],
  );
  const routeEntityType: LastEntityType = location.pathname.includes('/channel/')
    ? 'channel'
    : 'chat';
  const routeChatTitle =
    typeof location.state === 'object' &&
    location.state &&
    'chatTitle' in location.state &&
    typeof location.state.chatTitle === 'string'
      ? location.state.chatTitle.trim()
      : '';

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId(routeEntityType, chatId);
    setLastEntityType(routeEntityType);
    setLastEntityIds((current) =>
      current[routeEntityType] === chatId ? current : { ...current, [routeEntityType]: chatId },
    );

    if (!routeChatTitle) {
      return;
    }

    saveChatTitle(chatId, routeChatTitle);
  }, [chatId, routeChatTitle, routeEntityType]);

  useEffect(() => {
    let cancelled = false;

    void hydrateLastEntityState().then((state) => {
      if (cancelled) {
        return;
      }

      setLastEntityIds((current) => ({
        chat: current.chat || state.chatId,
        channel: current.channel || state.channelId,
      }));

      if (!chatId) {
        setLastEntityType(state.entityType);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!isChatsRoute) {
      return;
    }

    saveLastEntityType(selectedRootEntityType);
    setLastEntityType(selectedRootEntityType);
  }, [isChatsRoute, selectedRootEntityType]);

  const resolvedEntityType: LastEntityType = isChatsRoute
    ? selectedRootEntityType
    : routeEntityType;
  const resolvedChatId = chatId || lastEntityIds[resolvedEntityType];
  const homeRoute = buildManagedEntitiesRoute(resolvedEntityType);

  const resolvedChatTitle = useMemo(() => {
    if (!resolvedChatId) {
      return '';
    }

    if (chatId && routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(resolvedChatId);
  }, [chatId, resolvedChatId, routeChatTitle]);
  const settingsRoute = resolvedChatId
    ? resolvedEntityType === 'channel'
      ? `/channel/${resolvedChatId}/settings`
      : `/chat/${resolvedChatId}/settings`
    : '';
  const activityRoute = resolvedChatId
    ? resolvedEntityType === 'channel'
      ? `/channel/${resolvedChatId}/stats`
      : `/chat/${resolvedChatId}/events`
    : '';
  const activityNavLabel = 'Статистика';
  const isChatsListRoute = isChatsRoute && selectedRootEntityType === 'chat';
  const isChannelsListRoute = isChatsRoute && selectedRootEntityType === 'channel';
  const isGiveawayRoute = location.pathname.includes('/giveaways/');
  const isLegalRoute = location.pathname.startsWith('/legal/');
  const isDialogRoute =
    location.pathname.includes('/dialog/') &&
    (location.pathname.includes('/channel/') || location.pathname.includes('/chat/'));
  const isCommentsDialogRoute = isDialogRoute && location.pathname.includes('/dialog/comments');
  const shouldCloseDialogOnBack = isCommentsDialogRoute;
  const shouldCloseMiniAppOnBack = shouldCloseDialogOnBack || isGiveawayRoute;
  const isSettingsRoute = location.pathname.includes('/settings');
  const isEventsRoute = location.pathname.includes('/events');
  const isChannelStatsRoute =
    location.pathname.includes('/channel/') && location.pathname.includes('/stats');
  const hasTopbar =
    !isChatsRoute &&
    !isSettingsRoute &&
    !isEventsRoute &&
    !isDialogRoute &&
    !isChannelStatsRoute &&
    !isGiveawayRoute &&
    !isLegalRoute;

  const screen = useMemo(
    () => resolveScreenInfo(location.pathname, resolvedChatTitle || resolvedChatId),
    [location.pathname, resolvedChatId, resolvedChatTitle],
  );

  useEffect(() => {
    const shouldShowNativeBack = !isChatsRoute || hasNativeBackHandlers;
    setMaxBackButtonVisible(shouldShowNativeBack);

    if (!shouldShowNativeBack) {
      return () => {
        setMaxBackButtonVisible(false);
      };
    }

    const cleanup = bindMaxBackButton(() => {
      maxImpact('light');
      if (runNativeBackHandlers()) {
        return;
      }

      if (shouldCloseMiniAppOnBack) {
        closeMaxMiniApp(() => {
          navigate(homeRoute, { replace: true });
        });
        return;
      }

      if (window.history.length > 1) {
        navigate(-1);
        return;
      }

      navigate(homeRoute, { replace: true });
    });

    return () => {
      cleanup();
      setMaxBackButtonVisible(false);
    };
  }, [hasNativeBackHandlers, homeRoute, isChatsRoute, navigate, shouldCloseMiniAppOnBack]);

  return (
    <div
      className={cn(
        'app-shell',
        !hasTopbar && 'app-shell--no-topbar',
        (isDialogRoute || isGiveawayRoute) && 'app-shell--immersive',
        isCommentsDialogRoute && 'app-shell--comments-dialog',
      )}
    >
      {hasTopbar ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to={homeRoute} className="shell-brand">
              MAXIM
            </Link>
            <span className="shell-chip">Панель</span>
          </div>
          <div className="shell-topbar__content">
            <h2>{screen.title}</h2>
            {screen.subtitle ? <p>{screen.subtitle}</p> : null}
          </div>
        </header>
      ) : null}

      <main className="shell-content">
        <Outlet />
      </main>

      {!isDialogRoute && !isGiveawayRoute ? (
        <nav
          className={cn('bottom-nav glass-card', isKeyboardOpen && 'is-keyboard-open')}
          aria-label="Навигация приложения"
        >
          <Link
            to={buildManagedEntitiesRoute('chat')}
            className={cn('bottom-nav__item', isChatsListRoute && 'is-active')}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="chats" />
            </span>
            <span className="bottom-nav__label">Чаты</span>
          </Link>

          <Link
            to={buildManagedEntitiesRoute('channel')}
            className={cn('bottom-nav__item', isChannelsListRoute && 'is-active')}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="channels" />
            </span>
            <span className="bottom-nav__label">Каналы</span>
          </Link>

          {resolvedChatId ? (
            <NavLink
              to={settingsRoute}
              className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
            >
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="settings" />
              </span>
              <span className="bottom-nav__label">Настройки</span>
            </NavLink>
          ) : (
            <span className="bottom-nav__item is-disabled" aria-disabled>
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="settings" />
              </span>
              <span className="bottom-nav__label">Настройки</span>
            </span>
          )}

          {resolvedChatId ? (
            <NavLink
              to={activityRoute}
              className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
            >
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="events" />
              </span>
              <span className="bottom-nav__label">{activityNavLabel}</span>
            </NavLink>
          ) : (
            <span className="bottom-nav__item is-disabled" aria-disabled>
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="events" />
              </span>
              <span className="bottom-nav__label">{activityNavLabel}</span>
            </span>
          )}
        </nav>
      ) : null}
    </div>
  );
}
