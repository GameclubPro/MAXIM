import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useMemo, useRef } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';

type ChatParticipantsRosterProps = {
  items: ChatParticipantItem[];
  totalCount: number | null;
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

function resolveRoleLabel(item: ChatParticipantItem): string {
  if (item.role === 'owner') {
    return 'Владелец';
  }

  if (item.role === 'admin') {
    return 'Админ';
  }

  return 'Участник';
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
  totalCount,
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
  const loadedCount = items.length;
  const avatarsCount = useMemo(
    () => items.filter((item) => Boolean(item.avatarUrl?.trim())).length,
    [items],
  );
  const profileReadyCount = useMemo(
    () =>
      items.filter((item) =>
        Boolean(item.profileHandoffUrl?.trim() || item.profileUrl?.trim()),
      ).length,
    [items],
  );

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
      <div className="participants-roster__head">
        <div className="participants-roster__copy">
          <div className="participants-roster__eyebrow">Roster</div>
          <h2>Участники чата</h2>
          <p>Актуальный состав чата из MAX с аватарками, ролями и быстрым переходом в профиль.</p>
        </div>

        <div className="participants-roster__metrics">
          <article className="participants-roster__metric participants-roster__metric--primary">
            <small>Всего</small>
            <strong>{totalCount ?? loadedCount}</strong>
            <span>
              {hasMore && totalCount !== null
                ? `Загружено ${loadedCount} из ${totalCount}`
                : 'Список синхронизирован'}
            </span>
          </article>
          <article className="participants-roster__metric">
            <small>Аватары</small>
            <strong>{avatarsCount}</strong>
            <span>Карточек с фото</span>
          </article>
          <article className="participants-roster__metric">
            <small>Профили</small>
            <strong>{profileReadyCount}</strong>
            <span>Можно открыть в MAX</span>
          </article>
        </div>
      </div>

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
          <Spinner size="lg" label="Загружаем состав участников" />
        </div>
      ) : null}

      {!error && !isReloading && items.length === 0 ? (
        <div className="participants-roster__status">
          <p>Участники пока не найдены. Попробуйте обновить список.</p>
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

                  <div className="participants-roster__meta">
                    <span
                      className={`participants-roster__pill participants-roster__pill--${roleTone}`}
                    >
                      {resolveRoleLabel(item)}
                    </span>
                    {item.isBot ? (
                      <span className="participants-roster__pill participants-roster__pill--bot">
                        Бот
                      </span>
                    ) : null}
                  </div>
                </div>

                <span className="participants-roster__chevron" aria-hidden="true">
                  ↗
                </span>
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
          {isLoadingMore ? 'Загружаем ещё участников...' : 'Показать ещё'}
        </button>
      ) : items.length > 0 ? (
        <p className="participants-roster__footnote">Показаны все доступные участники чата.</p>
      ) : null}
    </section>
  );
}
