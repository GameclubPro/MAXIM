import type { MembershipActivityFilter, MembershipActivityItem } from '@maxim/contracts';
import { type MouseEvent, useEffect, useMemo, useState } from 'react';
import {
  buildMembershipActivityGroups,
  MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT,
  MEMBERSHIP_ACTIVITY_RENDER_STEP,
  resolveNextMembershipActivityRenderLimit,
} from '../../lib/membership-activity-feed';
import { PersonAvatar } from '../ui/person-avatar';
import { SegmentedControl } from '../ui/segmented-control';
import { Spinner } from '../ui/spinner';
import './membership-activity-feed.css';
import './membership-activity-feed-theme.css';

type MembershipActivityFeedProps = {
  title?: string | null;
  subtitle?: string | null;
  resetKey?: string | null;
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
  onProfileActivate?: ((item: MembershipActivityItem) => void) | null;
};

const filterOptions: Array<{ value: MembershipActivityFilter; label: string }> = [
  { value: 'all', label: 'Все' },
  { value: 'joined', label: 'Вошли' },
  { value: 'left', label: 'Вышли' },
];
const ACTIVITY_TIME_FORMATTER = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

function formatActivityTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return '--:--';
  }

  return ACTIVITY_TIME_FORMATTER.format(parsed);
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

function handleProfileLinkClick(
  event: MouseEvent<HTMLAnchorElement>,
  item: MembershipActivityItem,
  onProfileActivate?: ((item: MembershipActivityItem) => void) | null,
): void {
  event.preventDefault();
  event.stopPropagation();
  onProfileActivate?.(item);
}

export function MembershipActivityFeed({
  title = null,
  subtitle = null,
  resetKey = null,
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
  onProfileActivate = null,
}: MembershipActivityFeedProps) {
  const [renderLimit, setRenderLimit] = useState(MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT);
  const { groups, visibleCount, hiddenCount } = useMemo(
    () => buildMembershipActivityGroups(items, renderLimit),
    [items, renderLimit],
  );
  const nextRevealCount = Math.min(hiddenCount, MEMBERSHIP_ACTIVITY_RENDER_STEP);

  useEffect(() => {
    setRenderLimit(MEMBERSHIP_ACTIVITY_INITIAL_RENDER_LIMIT);
  }, [filter, resetKey]);

  const revealLoadedItems = () => {
    setRenderLimit((current) => resolveNextMembershipActivityRenderLimit(current, items.length));
  };

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
          ariaLabel="Фильтр событий входа и выхода"
        />
        {isReloading ? (
          <span className="membership-feed__badge">
            <Spinner size="sm" label={null} />
          </span>
        ) : null}
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
          <Spinner size="lg" label="Загружаем активность участников" />
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
                  const profileHandoffUrl = item.profileHandoffUrl?.trim() ?? '';
                  const profileUrl = item.profileUrl?.trim() ?? '';
                  const canOpenProfile =
                    item.userId.trim().length > 0 && typeof onProfileActivate === 'function';

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
                        {canOpenProfile ? (
                          <a
                            href={profileHandoffUrl || profileUrl || '#'}
                            className="membership-feed__avatar-link"
                            aria-label={`Открыть профиль ${displayName} в MAX`}
                            onClick={(event) =>
                              handleProfileLinkClick(event, item, onProfileActivate)
                            }
                          >
                            <PersonAvatar
                              avatarUrl={avatarUrl}
                              fallback={resolveInitial(displayName)}
                              className="membership-feed__avatar"
                            />
                          </a>
                        ) : (
                          <PersonAvatar
                            avatarUrl={avatarUrl}
                            fallback={resolveInitial(displayName)}
                            className="membership-feed__avatar"
                          />
                        )}
                        <div className="membership-feed__content">
                          <div className="membership-feed__row">
                            {canOpenProfile ? (
                              <a
                                href={profileHandoffUrl || profileUrl || '#'}
                                className="membership-feed__name-link"
                                onClick={(event) =>
                                  handleProfileLinkClick(event, item, onProfileActivate)
                                }
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

      {hiddenCount > 0 ? (
        <button
          type="button"
          className="button button--ghost membership-feed__load-more"
          onClick={revealLoadedItems}
          disabled={isReloading}
        >
          {nextRevealCount > 0
            ? `Показать ещё ${nextRevealCount} из загруженных`
            : 'Показать ещё загруженные'}
        </button>
      ) : hasMore ? (
        <button
          type="button"
          className="button button--ghost membership-feed__load-more"
          onClick={onLoadMore}
          disabled={isLoadingMore || isReloading}
        >
          {isLoadingMore ? 'Загружаем...' : 'Показать ещё'}
        </button>
      ) : null}

      {items.length > visibleCount ? (
        <p className="membership-feed__render-status" aria-live="polite">
          {`Показано ${visibleCount} из ${items.length} загруженных`}
        </p>
      ) : null}
    </section>
  );
}
