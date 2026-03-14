import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { bindMaxBackButton, maxImpact, setMaxBackButtonVisible } from '../lib/max-bridge';
import {
  buildManagedEntitiesRoute,
  normalizeEntityType,
  readLastEntityId,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
  type LastEntityType,
} from '../lib/last-chat';

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
  if (pathname.includes('/sticker-lab')) {
    return {
      title: 'Стикеры',
      subtitle: '',
    };
  }

  if (pathname.includes('/giveaways/')) {
    return {
      title: 'Розыгрыш',
      subtitle: chatLabel || 'Участие и итоги в одном экране.',
    };
  }

  if (pathname.includes('/channel/') && pathname.includes('/dialog/')) {
    const isSuggest = pathname.includes('/dialog/suggest');
    return {
      title: isSuggest ? 'Идея для поста' : 'Обсуждение',
      subtitle: chatLabel
        ? `Канал: ${chatLabel}`
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
      title: 'События',
      subtitle: chatLabel ? `Чат: ${chatLabel}` : 'Выберите чат, чтобы посмотреть события.',
    };
  }

  return {
    title: 'Ваши чаты',
    subtitle: 'Управляйте правилами и смотрите события в одном месте.',
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
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const isChatsRoute = location.pathname === '/';
  const selectedRootEntityType = useMemo(
    () =>
      normalizeEntityType(new URLSearchParams(location.search).get('view'), lastEntityType),
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
    if (!isChatsRoute) {
      return;
    }

    saveLastEntityType(selectedRootEntityType);
    setLastEntityType(selectedRootEntityType);
  }, [isChatsRoute, selectedRootEntityType]);

  const resolvedEntityType: LastEntityType = isChatsRoute ? selectedRootEntityType : routeEntityType;
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
  const isChatsListRoute = isChatsRoute && selectedRootEntityType === 'chat';
  const isChannelsListRoute = isChatsRoute && selectedRootEntityType === 'channel';
  const isGiveawayRoute = location.pathname.includes('/giveaways/');
  const isDialogRoute =
    location.pathname.includes('/channel/') && location.pathname.includes('/dialog/');
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
    !isGiveawayRoute;

  const screen = useMemo(
    () => resolveScreenInfo(location.pathname, resolvedChatTitle || resolvedChatId),
    [location.pathname, resolvedChatId, resolvedChatTitle],
  );

  useEffect(() => {
    const viewport = window.visualViewport;
    let baselineHeight = viewport?.height ?? window.innerHeight;
    const keyboardThreshold = 120;

    const hasEditableFocus = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      );
    };

    const updateKeyboardState = () => {
      const currentHeight = viewport?.height ?? window.innerHeight;
      const isOpened = hasEditableFocus() && baselineHeight - currentHeight > keyboardThreshold;

      if (!isOpened) {
        baselineHeight = currentHeight;
      }

      setIsKeyboardOpen(isOpened);
    };

    updateKeyboardState();

    viewport?.addEventListener('resize', updateKeyboardState);
    window.addEventListener('resize', updateKeyboardState);
    window.addEventListener('orientationchange', updateKeyboardState);
    window.addEventListener('focusin', updateKeyboardState);
    window.addEventListener('focusout', updateKeyboardState);

    return () => {
      viewport?.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('resize', updateKeyboardState);
      window.removeEventListener('orientationchange', updateKeyboardState);
      window.removeEventListener('focusin', updateKeyboardState);
      window.removeEventListener('focusout', updateKeyboardState);
    };
  }, []);

  useEffect(() => {
    const shouldShowNativeBack = !isChatsRoute;
    setMaxBackButtonVisible(shouldShowNativeBack);

    if (!shouldShowNativeBack) {
      return () => {
        setMaxBackButtonVisible(false);
      };
    }

    const cleanup = bindMaxBackButton(() => {
      maxImpact('light');
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
  }, [homeRoute, isChatsRoute, navigate]);

  return (
    <div
      className={cn(
        'app-shell',
        !hasTopbar && 'app-shell--no-topbar',
        (isDialogRoute || isGiveawayRoute) && 'app-shell--immersive',
      )}
    >
      {hasTopbar ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to={homeRoute} className="shell-brand">
              Майор Максимов
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

          {resolvedEntityType === 'channel' ? (
            <>
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
                  <span className="bottom-nav__label">Статистика</span>
                </NavLink>
              ) : (
                <span className="bottom-nav__item is-disabled" aria-disabled>
                  <span className="bottom-nav__icon" aria-hidden>
                    <BottomNavIcon name="events" />
                  </span>
                  <span className="bottom-nav__label">Статистика</span>
                </span>
              )}
            </>
          ) : (
            <>
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
                  <span className="bottom-nav__label">События</span>
                </NavLink>
              ) : (
                <span className="bottom-nav__item is-disabled" aria-disabled>
                  <span className="bottom-nav__icon" aria-hidden>
                    <BottomNavIcon name="events" />
                  </span>
                  <span className="bottom-nav__label">События</span>
                </span>
              )}
            </>
          )}
        </nav>
      ) : null}
    </div>
  );
}
