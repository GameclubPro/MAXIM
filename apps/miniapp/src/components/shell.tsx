import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { readLastChatId, saveLastChatId } from '../lib/last-chat';

type ScreenInfo = {
  title: string;
  subtitle: string;
};

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
    <div className="app-shell">
      {!isChatsRoute && !isSettingsRoute ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to="/" className="shell-brand">
              MAXIM
            </Link>
            <span className="shell-chip">Arctic Frost</span>
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
        className={cn('bottom-nav glass-card glass-card--sm', isKeyboardOpen && 'is-keyboard-open')}
        aria-label="Навигация miniapp"
      >
        <NavLink
          to="/"
          end
          className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
        >
          <span className="bottom-nav__icon" aria-hidden>
            ◉
          </span>
          <span className="bottom-nav__label">Чаты</span>
        </NavLink>

        {resolvedChatId ? (
          <NavLink
            to={`/chat/${resolvedChatId}/settings`}
            className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
          >
            <span className="bottom-nav__icon" aria-hidden>
              ⚙
            </span>
            <span className="bottom-nav__label">Настройки</span>
          </NavLink>
        ) : (
          <span className="bottom-nav__item is-disabled" aria-disabled>
            <span className="bottom-nav__icon" aria-hidden>
              ⚙
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
              ◷
            </span>
            <span className="bottom-nav__label">Логи</span>
          </NavLink>
        ) : (
          <span className="bottom-nav__item is-disabled" aria-disabled>
            <span className="bottom-nav__icon" aria-hidden>
              ◷
            </span>
            <span className="bottom-nav__label">Логи</span>
          </span>
        )}
      </nav>
    </div>
  );
}
