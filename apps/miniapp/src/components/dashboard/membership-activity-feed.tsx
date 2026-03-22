import type { MembershipActivityFilter, MembershipActivityItem } from '@maxim/contracts';
import { type MouseEvent, useMemo } from 'react';
import { openMaxBotLink } from '../../lib/max-bridge';
import { SegmentedControl } from '../ui/segmented-control';

type MembershipActivityFeedProps = {
  title?: string | null;
  subtitle?: string | null;
  variant?: 'default' | 'immersive';
  joinedLabel: string;
  leftLabel: string;
  filter: MembershipActivityFilter;
  onFilterChange: (value: MembershipActivityFilter) => void;
  items: MembershipActivityItem[];
  hasMore: boolean;
  isReloading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  onLoadMore: () => void;
  onRetry: () => void;
};

const filterOptions: Array<{ value: MembershipActivityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'joined', label: 'Вошли' },
  { value: 'left', label: 'Вышли' },
];

function formatActivityTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '--:--';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function resolveDayLabel(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Без даты';
  }

  const today = startOfDay(new Date());
  const target = startOfDay(parsed);
  const diff = Math.round((today - target) / (24 * 60 * 60 * 1000));

  if (diff === 0) {
    return 'Сегодня';
  }

  if (diff === 1) {
    return 'Вчера';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(parsed.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
  }).format(parsed);
}

function resolveInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/u);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveDescription(
  item: MembershipActivityItem,
  labels: { joinedLabel: string; leftLabel: string },
): string {
  return item.type === 'joined'
    ? `присоединился к ${labels.joinedLabel}`
    : `покинул ${labels.leftLabel}`;
}

function resolveDisplayName(name: string): string {
  const trimmed = name.trim();
  return trimmed || 'Участник';
}

function resolveAvatarUrl(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}

function handleProfileLinkClick(event: MouseEvent<HTMLAnchorElement>, profileUrl: string): void {
  event.preventDefault();
  openMaxBotLink(profileUrl);
}

export function MembershipActivityFeed({
  title = null,
  subtitle = null,
  variant = 'default',
  joinedLabel,
  leftLabel,
  filter,
  onFilterChange,
  items,
  hasMore,
  isReloading,
  isLoadingMore,
  error,
  onLoadMore,
  onRetry,
}: MembershipActivityFeedProps) {
  const groups = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      items: MembershipActivityItem[];
      joinedCount: number;
      leftCount: number;
    }> = [];
    const bucket = new Map<
      string,
      {
        label: string;
        items: MembershipActivityItem[];
        joinedCount: number;
        leftCount: number;
      }
    >();

    items.forEach((item) => {
      const parsed = new Date(item.createdAt);
      const key = Number.isFinite(parsed.getTime())
        ? `${parsed.getFullYear()}-${parsed.getMonth() + 1}-${parsed.getDate()}`
        : `unknown-${item.id}`;
      const existing = bucket.get(key);

      if (existing) {
        existing.items.push(item);
        if (item.type === 'joined') {
          existing.joinedCount += 1;
        } else {
          existing.leftCount += 1;
        }
        return;
      }

      const entry = {
        label: resolveDayLabel(item.createdAt),
        items: [item],
        joinedCount: item.type === 'joined' ? 1 : 0,
        leftCount: item.type === 'left' ? 1 : 0,
      };
      bucket.set(key, entry);
      result.push({ key, ...entry });
    });

    return result;
  }, [items]);

  return (
    <section
      className={`membership-feed membership-feed--${variant}`}
      aria-label="История входов и выходов"
    >
      {title || subtitle ? (
        <div className="membership-feed__head">
          <div className="membership-feed__title">
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
        </div>
      ) : null}

      <div className="membership-feed__toolbar">
        <SegmentedControl
          value={filter}
          options={filterOptions}
          onChange={onFilterChange}
          className="membership-feed__filters"
        />
        {isReloading ? <span className="membership-feed__badge">Обновляем</span> : null}
      </div>

      {error ? (
        <div className="membership-feed__status">
          <p>{error}</p>
          <button type="button" className="button button--ghost" onClick={onRetry}>
            Повторить
          </button>
        </div>
      ) : null}

      {!error && isReloading && items.length === 0 ? (
        <div className="membership-feed__status">
          <p>Загружаем активность участников...</p>
        </div>
      ) : null}

      {!error && !isReloading && items.length === 0 ? (
        <div className="membership-feed__status">
          <p>За выбранный период активности по этому фильтру нет.</p>
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="membership-feed__timeline">
          {groups.map((group) => (
            <section key={group.key} className="membership-feed__group">
              <div className="membership-feed__day">
                <div className="membership-feed__day-copy">
                  <span className="membership-feed__day-label">{group.label}</span>
                  <small>{`${group.items.length} событий`}</small>
                </div>
                <div className="membership-feed__day-stats" aria-hidden="true">
                  {group.joinedCount > 0 ? (
                    <span className="membership-feed__day-pill membership-feed__day-pill--joined">
                      +{group.joinedCount}
                    </span>
                  ) : null}
                  {group.leftCount > 0 ? (
                    <span className="membership-feed__day-pill membership-feed__day-pill--left">
                      -{group.leftCount}
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="membership-feed__group-list">
                {group.items.map((item, index) => {
                  const displayName = resolveDisplayName(item.userDisplayName);
                  const avatarUrl = resolveAvatarUrl(item.avatarUrl);
                  const profileUrl = item.profileUrl?.trim() ?? '';

                  return (
                    <article
                      key={item.id}
                      className={`membership-feed__item membership-feed__item--${item.type}`}
                    >
                      <div
                        className={`membership-feed__rail ${
                          index === group.items.length - 1 ? 'is-last' : ''
                        }`}
                      >
                        <time className="membership-feed__time" dateTime={item.createdAt}>
                          {formatActivityTime(item.createdAt)}
                        </time>
                        <span className="membership-feed__dot" aria-hidden="true" />
                      </div>

                      <div className="membership-feed__card">
                        <span
                          className={`membership-feed__avatar ${
                            avatarUrl ? 'membership-feed__avatar--image' : ''
                          }`}
                        >
                          {avatarUrl ? (
                            <img src={avatarUrl} alt="" loading="lazy" />
                          ) : (
                            resolveInitial(displayName)
                          )}
                        </span>
                        <div className="membership-feed__content">
                          <div className="membership-feed__row">
                            {profileUrl ? (
                              <a
                                href={profileUrl}
                                className="membership-feed__name-link"
                                onClick={(event) => handleProfileLinkClick(event, profileUrl)}
                              >
                                {displayName}
                              </a>
                            ) : (
                              <strong>{displayName}</strong>
                            )}
                            <span
                              className={`membership-feed__pill membership-feed__pill--${item.type}`}
                            >
                              {item.type === 'joined' ? 'Вошёл' : 'Вышел'}
                            </span>
                          </div>
                          <p className="membership-feed__description">
                            {resolveDescription(item, { joinedLabel, leftLabel })}
                          </p>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          className="button button--ghost membership-feed__load-more"
          onClick={onLoadMore}
          disabled={isLoadingMore || isReloading}
        >
          {isLoadingMore ? 'Загружаем...' : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
