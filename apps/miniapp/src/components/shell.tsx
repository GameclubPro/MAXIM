import { Link, NavLink, Outlet, useParams } from 'react-router-dom';

export function Shell() {
  const { chatId } = useParams();

  return (
    <div className="layout">
      <header className="topbar">
        <Link to="/" className="brand">
          MAXIM Moderator
        </Link>
        {chatId ? (
          <nav className="tabs">
            <NavLink to={`/chat/${chatId}/settings`}>Настройки</NavLink>
            <NavLink to={`/chat/${chatId}/events`}>Логи</NavLink>
          </nav>
        ) : null}
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
