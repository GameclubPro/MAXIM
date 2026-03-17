import type { MembershipActivityFilter, MembershipActivityItem } from '@maxim/contracts';
import { GlassCard } from '../ui/glass-card';
import { SegmentedControl } from '../ui/segmented-control';

type MembershipActivityFeedProps = {
  title: string;
  subtitle?: string | null;
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

function formatActivityDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return 'Нет даты';
  }

  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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

export function MembershipActivityFeed({
  title,
  subtitle = null,
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
  return (
    <GlassCard className="membership-feed" padding="sm" elevated>
      <div className="membership-feed__head">
        <div className="membership-feed__title">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {isReloading ? <span className="membership-feed__badge">Обновляем</span> : null}
      </div>

      <SegmentedControl
        value={filter}
        options={filterOptions}
        onChange={onFilterChange}
        className="membership-feed__filters"
      />

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
        <div className="membership-feed__list">
          {items.map((item) => (
            <article
              key={item.id}
              className={`membership-feed__item membership-feed__item--${item.type}`}
            >
              <span className="membership-feed__avatar">{resolveInitial(item.userDisplayName)}</span>
              <div className="membership-feed__content">
                <div className="membership-feed__row">
                  <strong>{item.userDisplayName}</strong>
                  <span
                    className={`membership-feed__pill membership-feed__pill--${item.type}`}
                  >
                    {item.type === 'joined' ? 'Вошёл' : 'Вышел'}
                  </span>
                </div>
                <div className="membership-feed__meta-line">
                  <span>{resolveDescription(item, { joinedLabel, leftLabel })}</span>
                  <time dateTime={item.createdAt}>{formatActivityDate(item.createdAt)}</time>
                </div>
              </div>
            </article>
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
    </GlassCard>
  );
}
