import type { ChatParticipantItem } from '@maxim/contracts';
import { useEffect, useRef } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';

type ChatParticipantsRosterProps = {
  items: ChatParticipantItem[];
  search: string;
  hasMore: boolean;
  isReloading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onSearchChange: (value: string) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onParticipantActivate?: ((item: ChatParticipantItem) => void) | null;
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

function resolveViolationTone(count: number): 'low' | 'medium' | 'high' {
  if (count >= 4) {
    return 'high';
  }

  if (count >= 2) {
    return 'medium';
  }

  return 'low';
}

function formatViolationCount(count: number): string {
  if (count > 99) {
    return '99+';
  }

  return String(count);
}

function describeViolationCount(count: number): string {
  if (count === 1) {
    return '1 нарушение за выбранный период';
  }

  return `${count} нарушений за выбранный период`;
}

function formatImmunityValue(item: ChatParticipantItem): string | null {
  if (!item.immunity) {
    return null;
  }

  return `${item.immunity.remainingViolatingMessagesToday}/${item.immunity.dailyViolationLimit}`;
}

function describeImmunity(item: ChatParticipantItem): string | null {
  if (!item.immunity) {
    return null;
  }

  return `Иммунитет: ${item.immunity.remainingViolatingMessagesToday} из ${item.immunity.dailyViolationLimit} нарушающих сообщений осталось на сегодня`;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden focusable="false">
      <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M13.4 13.4 17 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ChatParticipantsRoster({
  items,
  hasMore,
  isReloading,
  isLoadingMore,
  error,
  search,
  onSearchChange,
  onLoadMore,
  onRetry,
  onParticipantActivate = null,
}: ChatParticipantsRosterProps) {
  const isSearching = search.trim().length > 0;
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

  const showSearch = items.length > 0 || isSearching || isReloading;
  const showEmptySearch = !error && !isReloading && isSearching && items.length === 0;
  const showEmptyRoster = !error && !isReloading && !isSearching && items.length === 0;

  return (
    <section className="participants-roster" aria-label="Список участников">
      {showSearch ? (
        <div className="participants-roster__toolbar">
          <label className="participants-roster__search">
            <span className="participants-roster__search-icon" aria-hidden="true">
              <SearchIcon />
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Поиск"
              aria-label="Поиск участника"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </div>
      ) : null}

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

      {showEmptyRoster ? (
        <div className="participants-roster__status">
          <p>Участников пока нет.</p>
        </div>
      ) : null}

      {showEmptySearch ? (
        <div className="participants-roster__status">
          <p>Ничего не найдено.</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="participants-roster__list">
          {items.map((item) => {
            const displayName = resolveDisplayName(item);
            const username = item.username?.replace(/^@+/u, '').trim() ?? '';
            const canOpenDetails =
              item.userId.trim().length > 0 && typeof onParticipantActivate === 'function';
            const roleTone = resolveRoleTone(item);
            const roleLabel = resolveRoleLabel(item);
            const violationCount = Number.isFinite(item.violationCount)
              ? Math.max(0, Math.trunc(item.violationCount))
              : 0;
            const violationTone = resolveViolationTone(violationCount);
            const immunityValue = formatImmunityValue(item);
            const immunityDescription = describeImmunity(item);
            const itemBody = (
              <>
                <div
                  className={`participants-roster__avatar-shell ${item.immunity ? 'participants-roster__avatar-shell--immune' : ''}`}
                >
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

                {item.immunity || violationCount > 0 || canOpenDetails ? (
                  <div className="participants-roster__aside">
                    {item.immunity && immunityValue ? (
                      <span
                        className="participants-roster__immunity"
                        role="img"
                        aria-label={immunityDescription ?? undefined}
                        title={immunityDescription ?? undefined}
                      >
                        <span className="participants-roster__immunity-shield" aria-hidden="true">
                          <svg viewBox="0 0 20 20" fill="none" focusable="false">
                            <path
                              d="M10 2.8 15.8 5v4.2c0 3.2-1.9 5.8-5.8 8-3.9-2.2-5.8-4.8-5.8-8V5L10 2.8Z"
                              stroke="currentColor"
                              strokeWidth="1.7"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                        <span aria-hidden="true">{immunityValue}</span>
                      </span>
                    ) : null}

                    {violationCount > 0 ? (
                      <span
                        className={`participants-roster__violations participants-roster__violations--${violationTone}`}
                        role="img"
                        aria-label={describeViolationCount(violationCount)}
                        title={describeViolationCount(violationCount)}
                      >
                        <span aria-hidden="true">{formatViolationCount(violationCount)}</span>
                      </span>
                    ) : null}

                    {canOpenDetails ? (
                      <span className="participants-roster__chevron" aria-hidden="true">
                        ›
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            );

            if (canOpenDetails) {
              return (
                <button
                  key={item.userId}
                  type="button"
                  className="participants-roster__item participants-roster__item--interactive"
                  onClick={() => onParticipantActivate?.(item)}
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
