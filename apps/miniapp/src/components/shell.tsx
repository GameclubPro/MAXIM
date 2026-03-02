import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { readLastChatId, saveLastChatId } from '../lib/last-chat';

type ScreenInfo = {
  title: string;
  subtitle: string;
};

type BottomNavIconName = 'chats' | 'settings' | 'events';

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
  if (pathname.includes('/settings')) {
    return {
      title: 'Настройки модерации',
      subtitle: chatLabel ? `Чат: ${chatLabel}` : 'Выберите чат, чтобы изменить правила.',
    };
  }

  if (pathname.includes('/events')) {
    return {
      title: 'Журнал модерации',
      subtitle: chatLabel ? `Чат: ${chatLabel}` : 'Выберите чат, чтобы посмотреть события.',
    };
  }

  return {
    title: 'Ваши чаты',
    subtitle: 'Управляйте правилами и смотрите логи в одном месте.',
  };
}

export function Shell() {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const [lastChatId, setLastChatId] = useState<string>(() => readLastChatId());
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
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

    saveLastChatId(chatId);
    setLastChatId(chatId);

    if (!routeChatTitle) {
      return;
    }

    saveChatTitle(chatId, routeChatTitle);
  }, [chatId, routeChatTitle]);

  const resolvedChatId = chatId || lastChatId;

  const resolvedChatTitle = useMemo(() => {
    if (!resolvedChatId) {
      return '';
    }

    if (chatId && routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(resolvedChatId);
  }, [chatId, resolvedChatId, routeChatTitle]);
  const isChatsRoute = location.pathname === '/';
  const isSettingsRoute = location.pathname.includes('/settings');
  const isEventsRoute = location.pathname.includes('/events');
  const hasTopbar = !isChatsRoute && !isSettingsRoute && !isEventsRoute;

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

  return (
    <div className={cn('app-shell', !hasTopbar && 'app-shell--no-topbar')}>
      {hasTopbar ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to="/" className="shell-brand">
              MAXIM
            </Link>
            <span className="shell-chip">Панель</span>
          </div>
          <div className="shell-topbar__content">
            <h2>{screen.title}</h2>
            <p>{screen.subtitle}</p>
          </div>
        </header>
      ) : null}

      <main className="shell-content">
        <Outlet />
      </main>

      <nav
        className={cn('bottom-nav glass-card', isKeyboardOpen && 'is-keyboard-open')}
        aria-label="Навигация miniapp"
      >
        <NavLink
          to="/"
          end
          className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
        >
          <span className="bottom-nav__icon" aria-hidden>
            <BottomNavIcon name="chats" />
          </span>
          <span className="bottom-nav__label">Чаты</span>
        </NavLink>

        {resolvedChatId ? (
          <NavLink
            to={`/chat/${resolvedChatId}/settings`}
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
            to={`/chat/${resolvedChatId}/events`}
            className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="events" />
            </span>
            <span className="bottom-nav__label">Логи</span>
          </NavLink>
        ) : (
          <span className="bottom-nav__item is-disabled" aria-disabled>
            <span className="bottom-nav__icon" aria-hidden>
              <BottomNavIcon name="events" />
            </span>
            <span className="bottom-nav__label">Логи</span>
          </span>
        )}
      </nav>
    </div>
  );
}
