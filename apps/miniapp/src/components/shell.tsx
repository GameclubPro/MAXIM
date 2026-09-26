import { AppIcon } from './ui/app-icon';
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
import { openPublikBot, PUBLIK_BOT_URL } from '../lib/publik-bot';
import '../styles/moderation-workspace.css';
import '../styles/publisher-workspace.css';

type ScreenInfo = {
  title: string;
  subtitle?: string;
};

type BottomNavIconName = 'chats' | 'channels' | 'publications' | 'settings' | 'events';

const BOTTOM_NAV_ICONS = {
  chats: 'ChatLines',
  channels: 'Megaphone',
  publications: 'SendDiagonal',
  settings: 'Settings',
  events: 'Reports',
} as const;

function BottomNavIcon({ name }: { name: BottomNavIconName }) {
  return <AppIcon icon={BOTTOM_NAV_ICONS[name]} className="bottom-nav__icon-svg" />;
}

function resolveScreenInfo(
  pathname: string,
  chatLabel: string,
  profile: MiniappProfile,
): ScreenInfo {
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
      title: profile === 'publisher' ? 'Посты' : 'Расписания',
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
  useEffect(() => {
    document.body.dataset.miniappProfile = profile;
    return () => {
      delete document.body.dataset.miniappProfile;
    };
  }, [profile]);
  const { chatId = '', entityId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const managedEntityNavigation = useOptionalManagedEntityNavigation();
  const [lastEntityType, setLastEntityType] = useState<LastEntityType>(() => readLastEntityType());
  const isKeyboardOpen = useKeyboardOpen();
  const hasNativeBackHandlers = useNativeBackHandlersAvailable();
  const isChatsRoute = location.pathname === '/';
  const isPublicationsRoute =
    location.pathname === '/publications' || location.pathname === '/autoposts';
  const isProfileHomeRoute = isChatsRoute;
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
  const isPublisherAutoRepliesRoute =
    profile === 'publisher' &&
    /^\/publisher\/chat\/[^/]+\/auto-replies\/?$/u.test(location.pathname);
  const isManagedEntityRoute = isManagedEntityWorkspacePath(location.pathname);
  const isManagedEntityWorkspaceRoute = isManagedEntityRoute || isPublisherAutoRepliesRoute;
  const routeEntityId = chatId || (isPublisherAutoRepliesRoute ? entityId : '');

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
    : isManagedEntityWorkspaceRoute
      ? routeEntityType
      : lastEntityType;
  const resolvedChatId = routeEntityId;
  const homeRoute = profile === 'publisher' ? '/' : buildManagedEntitiesRoute(resolvedEntityType);
  const managedEntityBackRoute = isPublisherAutoRepliesRoute
    ? `/publisher/chat/${encodeURIComponent(entityId)}`
    : homeRoute;

  const resolvedChatTitle = useMemo(() => {
    if (!resolvedChatId) {
      return '';
    }

    if (routeEntityId && routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(resolvedChatId);
  }, [resolvedChatId, routeChatTitle, routeEntityId]);
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
  const isPublisherEntityModulesRoute =
    profile === 'publisher' && /^\/publisher\/(?:chat|channel)\/[^/]+\/?$/u.test(location.pathname);
  const shouldShowBottomNav = isChatsRoute || isPublicationsRoute;
  const hasTopbar =
    !isChatsRoute &&
    !isPublicationsRoute &&
    !isSettingsRoute &&
    !isEventsRoute &&
    !isDialogRoute &&
    !isChannelStatsRoute &&
    !isPublisherEntityModulesRoute &&
    !isPublisherAutoRepliesRoute &&
    !isGiveawayRoute &&
    !isLegalRoute;

  const screen = useMemo(
    () => resolveScreenInfo(location.pathname, resolvedChatTitle || resolvedChatId, profile),
    [location.pathname, profile, resolvedChatId, resolvedChatTitle],
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

      if (isPublisherAutoRepliesRoute) {
        if (managedEntityNavigation) {
          managedEntityNavigation.requestBack(managedEntityBackRoute);
        } else {
          navigate(managedEntityBackRoute, { replace: true });
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
    isPublisherAutoRepliesRoute,
    managedEntityNavigation,
    managedEntityBackRoute,
    navigate,
    shouldCloseMiniAppOnBack,
  ]);

  return (
    <div
      className={cn(
        'app-shell',
        !hasTopbar && 'app-shell--no-topbar',
        profile === 'publisher' && isChatsRoute && 'app-shell--publisher-catalog',
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
            <span className="shell-chip">{profile === 'publisher' ? 'Кабинет' : 'Панель'}</span>
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
          aria-label={profile === 'publisher' ? 'Навигация Публика' : 'Навигация Майора'}
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

          {profile === 'publisher' ? (
            <NavLink
              to="/publications"
              className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
            >
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="publications" />
              </span>
              <span className="bottom-nav__label">Посты</span>
            </NavLink>
          ) : (
            <a
              className="bottom-nav__item"
              href={PUBLIK_BOT_URL}
              onClick={openPublikBot}
              aria-label="Открыть бота Публик"
              title="Открыть бота Публик"
            >
              <span className="bottom-nav__icon" aria-hidden>
                <BottomNavIcon name="publications" />
              </span>
              <span className="bottom-nav__label">Публик</span>
            </a>
          )}
        </nav>
      ) : null}
    </div>
  );
}
