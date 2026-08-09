import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { cn } from '../../lib/cn';
import { useManagedEntityNavigation } from '../../lib/managed-entity-navigation-context';
import { preserveManagedEntityRouteContext } from '../../lib/managed-entity-workspace';
import { SettingsGlyph, StatisticsGlyph } from './compact-icons';
import { EntityAvatar } from './entity-avatar';
import { CompactStickyHeader } from './compact-sticky-header';
import './managed-entity-workspace-header.css';

type ManagedEntityWorkspaceHeaderProps = {
  entityType: 'chat' | 'channel';
  screen: 'settings' | 'stats';
  title: string;
  avatarUrl?: string | null;
  authoritativeIdentity?: {
    title?: string | null;
    avatarUrl?: string | null;
  };
  backTo: string;
  counterpartTo: string;
  counterpartHidden?: boolean;
  compact?: boolean;
  busy?: boolean;
  status?: ReactNode;
  className?: string;
};

export function ManagedEntityWorkspaceHeader({
  entityType,
  screen,
  title,
  avatarUrl = null,
  authoritativeIdentity,
  backTo,
  counterpartTo,
  counterpartHidden = false,
  compact = false,
  busy = false,
  status = null,
  className,
}: ManagedEntityWorkspaceHeaderProps) {
  const location = useLocation();
  const { requestBack, requestNavigation } = useManagedEntityNavigation();
  const headerRef = useRef<HTMLElement | null>(null);
  const [counterpartNavigationPending, setCounterpartNavigationPending] = useState(false);
  const resolvedTitle = title.trim() || (entityType === 'channel' ? 'Канал' : 'Чат');
  const counterpartLabel = screen === 'settings' ? 'Открыть статистику' : 'Открыть настройки';
  const CounterpartIcon = screen === 'settings' ? StatisticsGlyph : SettingsGlyph;
  const routeState =
    typeof location.state === 'object' && location.state !== null
      ? (location.state as Record<string, unknown>)
      : null;
  const routeTitle =
    typeof routeState?.chatTitle === 'string' ? routeState.chatTitle.trim() : '';
  const routeAvatarUrl =
    typeof routeState?.avatarUrl === 'string' && routeState.avatarUrl.trim()
      ? routeState.avatarUrl.trim()
      : null;
  const hasRouteAvatar = Boolean(routeState && 'avatarUrl' in routeState);
  const authoritativeTitle = authoritativeIdentity?.title?.trim() ?? '';
  const authoritativeAvatarUrl =
    typeof authoritativeIdentity?.avatarUrl === 'string' && authoritativeIdentity.avatarUrl.trim()
      ? authoritativeIdentity.avatarUrl.trim()
      : null;
  const hasAuthoritativeIdentity = authoritativeIdentity !== undefined;
  const displayedAvatarUrl = typeof avatarUrl === 'string' && avatarUrl.trim() ? avatarUrl.trim() : null;
  const counterpartRouteState = {
    ...(routeState ?? {}),
    chatTitle: authoritativeTitle || routeTitle || resolvedTitle,
    avatarUrl: hasAuthoritativeIdentity
      ? authoritativeAvatarUrl
      : hasRouteAvatar
        ? routeAvatarUrl
      : displayedAvatarUrl,
  };
  const resolvedCounterpartRoute = preserveManagedEntityRouteContext(
    counterpartTo,
    location.search,
    location.hash,
  );

  useEffect(() => {
    if (
      !hasAuthoritativeIdentity ||
      ((!authoritativeTitle || authoritativeTitle === routeTitle) &&
        authoritativeAvatarUrl === routeAvatarUrl)
    ) {
      return;
    }

    requestNavigation(
      {
        pathname: location.pathname,
        search: location.search,
        hash: location.hash,
      },
      {
        replace: true,
        state: {
          ...(routeState ?? {}),
          ...(authoritativeTitle ? { chatTitle: authoritativeTitle } : {}),
          avatarUrl: authoritativeAvatarUrl,
        },
      },
    );
  }, [
    authoritativeAvatarUrl,
    authoritativeTitle,
    hasAuthoritativeIdentity,
    location.hash,
    location.pathname,
    location.search,
    location.state,
    requestNavigation,
    routeAvatarUrl,
    routeTitle,
  ]);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const workspace = header?.closest<HTMLElement>('[data-managed-entity-workspace]');
    if (!header || !workspace) {
      return undefined;
    }

    const measure = () => {
      const bottom = Math.max(0, header.getBoundingClientRect().bottom);
      workspace.style.setProperty('--managed-entity-workspace-header-bottom', `${bottom}px`);
    };
    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(header);
    measure();
    window.visualViewport?.addEventListener('resize', measure);

    return () => {
      resizeObserver.disconnect();
      window.visualViewport?.removeEventListener('resize', measure);
      workspace.style.removeProperty('--managed-entity-workspace-header-bottom');
    };
  }, [compact]);

  return (
    <CompactStickyHeader
      backTo={backTo}
      backLabel={entityType === 'channel' ? 'Назад к каналам' : 'Назад к чатам'}
      onBack={() => requestBack(backTo)}
      title={resolvedTitle}
      subtitle={screen === 'settings' ? 'Настройки' : 'Статистика'}
      avatar={
        <EntityAvatar
          title={resolvedTitle}
          entityType={entityType}
          avatarUrl={avatarUrl}
          className="compact-page-header__entity-avatar"
        />
      }
      compact={compact}
      className={cn('managed-entity-workspace-header', className)}
      headerRef={headerRef}
      aside={
        <div className="managed-entity-workspace-header__actions">
          {status}
          {busy || counterpartNavigationPending ? (
            <span
              className="managed-entity-workspace-header__busy"
              role="status"
              aria-label="Обновляем"
              title="Обновляем"
            />
          ) : null}
          {!counterpartHidden ? (
            <button
              type="button"
              className="managed-entity-workspace-header__counterpart"
              aria-label={counterpartLabel}
              title={counterpartLabel}
              disabled={counterpartNavigationPending}
              onClick={() => {
                const navigationStarted = requestNavigation(resolvedCounterpartRoute, {
                  replace: true,
                  state: counterpartRouteState,
                  flushSync: true,
                });
                if (navigationStarted) {
                  setCounterpartNavigationPending(true);
                }
              }}
            >
              <CounterpartIcon aria-hidden focusable="false" />
            </button>
          ) : null}
        </div>
      }
    />
  );
}
