import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
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
  isManagedEntityWorkspacePath,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
  type LastEntityType,
} from '../lib/last-chat';
import { useOptionalManagedEntityNavigation } from '../lib/managed-entity-navigation-context';
import { runNativeBackHandlers, useNativeBackHandlersAvailable } from '../lib/native-back';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import type { MiniappProfile } from '@maxim/contracts/publisher';

type ScreenInfo = {
  title: string;
  subtitle?: string;
};

type BottomNavIconName = 'chats' | 'channels' | 'publications' | 'settings' | 'events';

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

  if (name === 'publications') {
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
        <path d="M4.2 5.2 20 12 4.2 18.8 6.4 12 4.2 5.2Z" />
        <path d="M6.4 12H20" />
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
  if (pathname.startsWith('/legal/')) {
    return {
      title: 'Правовые документы',
      subtitle: 'Условия использования и обработка данных ботов.',
    };
  }

  if (pathname.includes('/giveaways/')) {
    return {
      title: 'Розыгрыш',
      subtitle: chatLabel || 'Участие и итоги в одном экране.',
    };
  }

  if (pathname === '/publications' || pathname === '/autoposts') {
    return {
      title: 'Посты',
    };
  }

  if (
    pathname.includes('/dialog/') &&
    (pathname.includes('/channel/') || pathname.includes('/chat/'))
  ) {
    const isSuggest = pathname.includes('/dialog/suggest');
    const entityLabel = pathname.includes('/channel/') ? 'Канал' : 'Чат';
    return {
      title: isSuggest ? 'Идея для поста' : 'Комментарии в приложении',
      subtitle: chatLabel
        ? `${entityLabel}: ${chatLabel}`
        : isSuggest
          ? 'Отправка идеи поста админу.'
          : 'Комментарии к публикации в приложении.',
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
    title: 'Панель',
  };
}

export function Shell({ profile = 'moderation' }: { profile?: MiniappProfile }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const managedEntityNavigation = useOptionalManagedEntityNavigation();
  const [lastEntityType, setLastEntityType] = useState<LastEntityType>(() => readLastEntityType());
  const isKeyboardOpen = useKeyboardOpen();
  const hasNativeBackHandlers = useNativeBackHandlersAvailable();
  const isChatsRoute = location.pathname === '/';
  const isPublicationsRoute =
    location.pathname === '/publications' || location.pathname === '/autoposts';
  const isProfileHomeRoute = profile === 'publisher' ? isPublicationsRoute : isChatsRoute;
  const selectedRootEntityType = useMemo(
    () =>
      normalizeEntityType(
        new URLSearchParams(location.search).get('view'),
        profile === 'publisher' ? 'chat' : lastEntityType,
      ),
    [lastEntityType, location.search, profile],
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
  const isManagedEntityRoute = isManagedEntityWorkspacePath(location.pathname);

  useEffect(() => {
    if (!chatId || !isManagedEntityRoute) {
      return;
    }

    saveLastEntityId(routeEntityType, chatId);
    setLastEntityType(routeEntityType);

    if (!routeChatTitle) {
      return;
    }

    saveChatTitle(chatId, routeChatTitle);
  }, [chatId, isManagedEntityRoute, routeChatTitle, routeEntityType]);

  useEffect(() => {
    let cancelled = false;

    void hydrateLastEntityState().then((state) => {
      if (cancelled) {
        return;
      }

      if (!chatId) {
        setLastEntityType(state.entityType);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!isChatsRoute || profile !== 'moderation') {
      return;
    }

    saveLastEntityType(selectedRootEntityType);
    setLastEntityType(selectedRootEntityType);
  }, [isChatsRoute, profile, selectedRootEntityType]);

  const resolvedEntityType: LastEntityType = isChatsRoute
    ? selectedRootEntityType
    : isManagedEntityRoute
      ? routeEntityType
      : lastEntityType;
  const resolvedChatId = chatId;
  const homeRoute =
    profile === 'publisher' ? '/publications' : buildManagedEntitiesRoute(resolvedEntityType);

  const resolvedChatTitle = useMemo(() => {
    if (!resolvedChatId) {
      return '';
    }

    if (chatId && routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(resolvedChatId);
  }, [chatId, resolvedChatId, routeChatTitle]);
  const isGiveawayRoute = location.pathname.includes('/giveaways/');
  const isLegalRoute = location.pathname.startsWith('/legal/');
  const isDialogRoute =
    location.pathname.includes('/dialog/') &&
    (location.pathname.includes('/channel/') || location.pathname.includes('/chat/'));
  const isCommentsDialogRoute = isDialogRoute && location.pathname.includes('/dialog/comments');
  const isSuggestDialogRoute = isDialogRoute && location.pathname.includes('/dialog/suggest');
  const shouldCloseDialogOnBack = isDialogRoute;
  const shouldCloseMiniAppOnBack = shouldCloseDialogOnBack || isGiveawayRoute;
  const isSettingsRoute = location.pathname.includes('/settings');
  const isEventsRoute = location.pathname.includes('/events');
  const isChannelStatsRoute =
    location.pathname.includes('/channel/') && location.pathname.includes('/stats');
  const shouldShowBottomNav =
    profile === 'moderation' && (isChatsRoute || isPublicationsRoute);
  const hasTopbar =
    !isChatsRoute &&
    !isPublicationsRoute &&
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
    const shouldShowNativeBack = !isProfileHomeRoute || hasNativeBackHandlers;
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

      if (isManagedEntityRoute) {
        if (managedEntityNavigation) {
          managedEntityNavigation.requestBack(homeRoute);
        } else {
          navigate(homeRoute, { replace: true });
        }
        return;
      }

      navigate(homeRoute, { replace: true });
    });

    return () => {
      cleanup();
      setMaxBackButtonVisible(false);
    };
  }, [
    hasNativeBackHandlers,
    homeRoute,
    isProfileHomeRoute,
    isManagedEntityRoute,
    managedEntityNavigation,
    navigate,
    shouldCloseMiniAppOnBack,
  ]);

  return (
    <div
      className={cn(
        'app-shell',
        !hasTopbar && 'app-shell--no-topbar',
        (isDialogRoute || isGiveawayRoute) && 'app-shell--immersive',
        isCommentsDialogRoute && 'app-shell--comments-dialog',
        isSuggestDialogRoute && 'app-shell--suggest-dialog',
      )}
      style={
        shouldShowBottomNav
          ? undefined
          : ({ '--bottom-nav-height': '0px', '--bottom-nav-offset': '0px' } as CSSProperties)
      }
    >
      {hasTopbar ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to={homeRoute} className="shell-brand">
              {profile === 'publisher' ? 'Публик' : 'Панель'}
            </Link>
            <span className="shell-chip">{profile === 'publisher' ? 'Посты' : 'Панель'}</span>
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

      {shouldShowBottomNav ? (
        <nav
          className={cn(
            'bottom-nav bottom-nav--primary glass-card',
            isKeyboardOpen && 'is-keyboard-open',
          )}
          aria-label="Навигация приложения"
        >
          <Link
            to={buildManagedEntitiesRoute('chat')}
            className={cn(
              'bottom-nav__item',
              isChatsRoute && selectedRootEntityType === 'chat' && 'is-active',
            )}
            aria-current={isChatsRoute && selectedRootEntityType === 'chat' ? 'page' : undefined}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="chats" />
            </span>
            <span className="bottom-nav__label">Чаты</span>
          </Link>

          <Link
            to={buildManagedEntitiesRoute('channel')}
            className={cn(
              'bottom-nav__item',
              isChatsRoute && selectedRootEntityType === 'channel' && 'is-active',
            )}
            aria-current={isChatsRoute && selectedRootEntityType === 'channel' ? 'page' : undefined}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="channels" />
            </span>
            <span className="bottom-nav__label">Каналы</span>
          </Link>

          <NavLink
            to="/publications"
            className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="publications" />
            </span>
            <span className="bottom-nav__label">Посты</span>
          </NavLink>
        </nav>
      ) : null}
    </div>
  );
}
