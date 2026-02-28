import { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useParams } from 'react-router-dom';
import { cn } from '../lib/cn';
import { readLastChatId, saveLastChatId } from '../lib/last-chat';

type ScreenInfo = {
  title: string;
  subtitle: string;
};

function resolveScreenInfo(pathname: string, chatId: string): ScreenInfo {
  if (pathname.includes('/settings')) {
    return {
      title: 'Настройки модерации',
      subtitle: chatId ? `Чат: ${chatId}` : 'Выберите чат, чтобы изменить правила.',
    };
  }

  if (pathname.includes('/events')) {
    return {
      title: 'Журнал модерации',
      subtitle: chatId ? `Чат: ${chatId}` : 'Выберите чат, чтобы посмотреть события.',
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

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastChatId(chatId);
    setLastChatId(chatId);
  }, [chatId]);

  const resolvedChatId = chatId || lastChatId;

  const screen = useMemo(
    () => resolveScreenInfo(location.pathname, resolvedChatId),
    [location.pathname, resolvedChatId],
  );

  return (
    <div className="app-shell">
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

      <main className="shell-content">
        <Outlet />
      </main>

      <nav className="bottom-nav glass-card glass-card--sm" aria-label="Навигация miniapp">
        <NavLink to="/" end className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}>
          <span aria-hidden>◉</span>
          <span>Чаты</span>
        </NavLink>

        {resolvedChatId ? (
          <NavLink
            to={`/chat/${resolvedChatId}/settings`}
            className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
          >
            <span aria-hidden>⚙</span>
            <span>Настройки</span>
          </NavLink>
        ) : (
          <span className="bottom-nav__item is-disabled" aria-disabled>
            <span aria-hidden>⚙</span>
            <span>Настройки</span>
          </span>
        )}

        {resolvedChatId ? (
          <NavLink
            to={`/chat/${resolvedChatId}/events`}
            className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
          >
            <span aria-hidden>◷</span>
            <span>Логи</span>
          </NavLink>
        ) : (
          <span className="bottom-nav__item is-disabled" aria-disabled>
            <span aria-hidden>◷</span>
            <span>Логи</span>
          </span>
        )}
      </nav>
    </div>
  );
}
