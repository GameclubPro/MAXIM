import type { ChatParticipantItem } from '@maxim/contracts';
import { UserXmark as IconUserXmark } from 'iconoir-react';
import { useEffect, useRef } from 'react';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';
import './chat-participants-roster.css';

type ImmunityMode = 'limited' | 'always';
type ChatParticipantImmunityView = Omit<
  NonNullable<ChatParticipantItem['immunity']>,
  'dailyViolationLimit' | 'remainingViolatingMessagesToday'
> & {
  mode?: ImmunityMode | null;
  dailyViolationLimit?: number | null;
  remainingViolatingMessagesToday?: number | null;
};

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
  onCleanupUnavailable?: (() => void) | null;
  isCleanupUnavailableBusy?: boolean;
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

  return String(Math.max(0, Math.trunc(count)));
}

function describeViolationCount(count: number): string {
  if (count === 1) {
    return '1 нарушение за выбранный период';
  }

  return `${count} нарушений за выбранный период`;
}

function resolveImmunity(item: ChatParticipantItem): ChatParticipantImmunityView | null {
  return item.immunity ? (item.immunity as ChatParticipantImmunityView) : null;
}

function isAlwaysImmunity(immunity: ChatParticipantImmunityView | null): boolean {
  return immunity?.mode === 'always';
}

function parsePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.trunc(value));
}

function parseNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
}

function formatImmunityValue(immunity: ChatParticipantImmunityView | null): string | null {
  if (!immunity) {
    return null;
  }

  if (isAlwaysImmunity(immunity)) {
    return '∞';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `${formatViolationCount(remaining)}/${formatViolationCount(limit)}`;
  }

  if (limit !== null) {
    return `${formatViolationCount(limit)}/д`;
  }

  return 'Лимит';
}

function describeImmunity(immunity: ChatParticipantImmunityView | null): string | null {
  if (!immunity) {
    return null;
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Защита всегда: без срока и дневного лимита';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `Защита: ${remaining} из ${limit} нарушающих сообщений осталось на сегодня`;
  }

  if (limit !== null) {
    return `Защита: лимит ${limit} нарушающих сообщений в день`;
  }

  return 'Защита с дневным лимитом';
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
  onCleanupUnavailable = null,
  isCleanupUnavailableBusy = false,
}: ChatParticipantsRosterProps) {
  const isSearching = search.trim().length > 0;
  const isSearchBusy = isSearching && (isReloading || isLoadingMore);
  const showSearchScanning =
    !error && isSearching && items.length === 0 && (isReloading || isLoadingMore || hasMore);
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
  const showEmptySearch =
    !error && !isReloading && !isLoadingMore && !hasMore && isSearching && items.length === 0;
  const showEmptyRoster = !error && !isReloading && !isSearching && items.length === 0;

  return (
    <section className="participants-roster" aria-label="Список участников">
      {showSearch ? (
        <div className="participants-roster__toolbar">
          <label className={`participants-roster__search ${isSearchBusy ? 'is-busy' : ''}`}>
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
            {isSearchBusy ? (
              <span className="participants-roster__search-progress" aria-hidden="true" />
            ) : null}
          </label>
          {onCleanupUnavailable ? (
            <button
              type="button"
              className="participants-roster__cleanup-button"
              onClick={onCleanupUnavailable}
              disabled={isCleanupUnavailableBusy || isReloading || isLoadingMore}
              aria-label="Удалить заблокированные MAX аккаунты"
              title="Удалить заблокированные MAX аккаунты"
            >
              <IconUserXmark width={17} height={17} strokeWidth={2.05} aria-hidden />
              <span>{isCleanupUnavailableBusy ? 'Ищем...' : 'Удалить заблок.'}</span>
            </button>
          ) : null}
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

      {!error && isReloading && items.length === 0 && !isSearching ? (
        <div className="participants-roster__status">
          <Spinner size="lg" label="Загружаем участников" />
        </div>
      ) : null}

      {showSearchScanning ? (
        <div className="participants-roster__status participants-roster__status--search">
          <span className="participants-roster__search-status-spinner" aria-hidden="true" />
          <p>Ищем по участникам...</p>
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
            const immunity = resolveImmunity(item);
            const immunityValue = formatImmunityValue(immunity);
            const immunityDescription = describeImmunity(immunity);
            const hasAlwaysImmunity = isAlwaysImmunity(immunity);
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
                        className={`participants-roster__immunity ${
                          hasAlwaysImmunity ? 'participants-roster__immunity--always' : ''
                        }`}
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

      {hasMore && !showSearchScanning ? (
        <button
          type="button"
          className="button button--ghost participants-roster__load-more"
          onClick={onLoadMore}
          disabled={isLoadingMore || isReloading}
        >
          {isLoadingMore ? (isSearching ? 'Ищем...' : 'Загружаем...') : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
