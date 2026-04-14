import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useRef } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';

type ChatParticipantsRosterProps = {
  items: ChatParticipantItem[];
  hasMore: boolean;
  isReloading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
  onProfileActivate?: ((item: ChatParticipantItem) => void) | null;
};

function resolveDisplayName(item: ChatParticipantItem): string {
  const name = item.userDisplayName.trim();
  if (name) {
    return name;
  }

  const username = item.username?.trim() ?? '';
  if (username) {
    return `@${username.replace(/^@+/u, '')}`;
  }

  return item.isBot ? 'Бот MAX' : 'Участник';
}

function resolveInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/u);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveRoleLabel(item: ChatParticipantItem): string | null {
  if (item.role === 'owner') {
    return 'Владелец';
  }

  if (item.role === 'admin') {
    return 'Админ';
  }

  return null;
}

function resolveRoleTone(item: ChatParticipantItem): 'owner' | 'admin' | 'member' {
  if (item.role === 'owner') {
    return 'owner';
  }

  if (item.role === 'admin') {
    return 'admin';
  }

  return 'member';
}

export function ChatParticipantsRoster({
  items,
  hasMore,
  isReloading,
  isLoadingMore,
  error,
  onLoadMore,
  onRetry,
  onProfileActivate = null,
}: ChatParticipantsRosterProps) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadLockRef = useRef(false);

  useEffect(() => {
    if (!isLoadingMore) {
      autoLoadLockRef.current = false;
    }
  }, [isLoadingMore]);

  useEffect(() => {
    if (!hasMore || isLoadingMore || isReloading || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const node = sentinelRef.current;
    if (!node) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          return;
        }

        if (autoLoadLockRef.current) {
          return;
        }

        autoLoadLockRef.current = true;
        onLoadMore();
      },
      {
        rootMargin: '320px 0px 320px 0px',
      },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, isReloading, onLoadMore]);

  return (
    <section className="participants-roster" aria-label="Список участников">
      {error ? (
        <div className="participants-roster__status">
          <p>{error}</p>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Повторить
          </button>
        </div>
      ) : null}

      {!error && isReloading && items.length === 0 ? (
        <div className="participants-roster__status">
          <Spinner size="lg" label="Загружаем участников" />
        </div>
      ) : null}

      {!error && !isReloading && items.length === 0 ? (
        <div className="participants-roster__status">
          <p>Участников пока нет.</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="participants-roster__list">
          {items.map((item) => {
            const displayName = resolveDisplayName(item);
            const username = item.username?.replace(/^@+/u, '').trim() ?? '';
            const canOpenProfile =
              item.userId.trim().length > 0 && typeof onProfileActivate === 'function';
            const roleTone = resolveRoleTone(item);
            const roleLabel = resolveRoleLabel(item);
            const itemBody = (
              <>
                <div className="participants-roster__avatar-shell">
                  <PersonAvatar
                    avatarUrl={item.avatarUrl?.trim() || null}
                    fallback={resolveInitial(displayName)}
                    className="participants-roster__avatar"
                  />
                </div>

                <div className="participants-roster__content">
                  <div className="participants-roster__identity">
                    <strong>{displayName}</strong>
                    {username ? <span>@{username}</span> : null}
                  </div>

                  {roleLabel || item.isBot ? (
                    <div className="participants-roster__meta">
                      {roleLabel ? (
                        <span
                          className={`participants-roster__pill participants-roster__pill--${roleTone}`}
                        >
                          {roleLabel}
                        </span>
                      ) : null}
                      {item.isBot ? (
                        <span className="participants-roster__pill participants-roster__pill--bot">
                          Бот
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                {canOpenProfile ? (
                  <span className="participants-roster__chevron" aria-hidden="true">
                    ↗
                  </span>
                ) : null}
              </>
            );

            if (canOpenProfile) {
              return (
                <button
                  key={item.userId}
                  type="button"
                  className="participants-roster__item participants-roster__item--interactive"
                  onClick={() => onProfileActivate?.(item)}
                >
                  {itemBody}
                </button>
              );
            }

            return (
              <article key={item.userId} className="participants-roster__item">
                {itemBody}
              </article>
            );
          })}
        </div>
      ) : null}

      <div ref={sentinelRef} className="participants-roster__sentinel" aria-hidden="true" />

      {hasMore ? (
        <button
          type="button"
          className="button button--ghost participants-roster__load-more"
          onClick={onLoadMore}
          disabled={isLoadingMore || isReloading}
        >
          {isLoadingMore ? 'Загружаем...' : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
