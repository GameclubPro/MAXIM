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
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5 6.2h8.6a3.1 3.1 0 0 1 3.1 3.1v2a3.1 3.1 0 0 1-3.1 3.1H9.3l-3.9 3v-3.5A3.1 3.1 0 0 1 2.8 11V9.3A3.1 3.1 0 0 1 5 6.2Z" />
        <path d="M15 8.5h3.6a2.6 2.6 0 0 1 2.6 2.6v1.4a2.6 2.6 0 0 1-2.6 2.6h-.8v2.1L15.6 15" />
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
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 9.1a2.9 2.9 0 1 0 0 5.8 2.9 2.9 0 0 0 0-5.8Z" />
        <path d="M12.2 2h-.4a2 2 0 0 0-1.9 1.5l-.3 1.2c-.6.2-1.1.5-1.6.9l-1.2-.7a2 2 0 0 0-2.5.3l-.3.3a2 2 0 0 0-.3 2.5l.7 1.2c-.4.5-.7 1-.9 1.6l-1.2.3A2 2 0 0 0 2 11.8v.4a2 2 0 0 0 1.5 1.9l1.2.3c.2.6.5 1.1.9 1.6l-.7 1.2a2 2 0 0 0 .3 2.5l.3.3a2 2 0 0 0 2.5.3l1.2-.7c.5.4 1 .7 1.6.9l.3 1.2a2 2 0 0 0 1.9 1.5h.4a2 2 0 0 0 1.9-1.5l.3-1.2c.6-.2 1.1-.5 1.6-.9l1.2.7a2 2 0 0 0 2.5-.3l.3-.3a2 2 0 0 0 .3-2.5l-.7-1.2c.4-.5.7-1 .9-1.6l1.2-.3a2 2 0 0 0 1.5-1.9v-.4a2 2 0 0 0-1.5-1.9l-1.2-.3c-.2-.6-.5-1.1-.9-1.6l.7-1.2a2 2 0 0 0-.3-2.5l-.3-.3a2 2 0 0 0-2.5-.3l-1.2.7c-.5-.4-1-.7-1.6-.9l-.3-1.2A2 2 0 0 0 12.2 2Z" />
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 24 24"
      className="bottom-nav__icon-svg"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3.2" />
      <path d="M8 8.5h7.5M8 12.2h7.8M8 15.9h4.8" />
      <circle cx="16.2" cy="16.1" r="2.6" />
      <path d="M16.2 14.9v1.4l1 0.6" />
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
  const hasTopbar = !isChatsRoute && !isSettingsRoute;

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
