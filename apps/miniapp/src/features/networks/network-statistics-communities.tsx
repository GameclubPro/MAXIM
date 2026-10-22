import { useEffect, useMemo, useState } from 'react';
import type { NetworkStatisticsResponse } from '@maxim/contracts/networks-stats';
import { EntityAvatar } from '../../components/ui/entity-avatar';

type Item = NetworkStatisticsResponse['items'][number];
type View = {
  expanded: boolean;
  search: string;
  sort: 'audience' | 'netGrowth' | 'viewsGained';
  missing: boolean;
  limit: number;
};
const views = new Map<string, View>();
const number = new Intl.NumberFormat('ru-RU');
const stamp = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});
const metric = (value: number | null, signed = false) =>
  value === null ? 'Нет данных' : `${signed && value > 0 ? '+' : ''}${number.format(value)}`;
function CommunityIdentity({
  item,
  entityType,
  onOpen,
}: {
  item: Item;
  entityType: NetworkStatisticsResponse['entityType'];
  onOpen?: () => void;
}) {
  const identity = (
    <>
      <EntityAvatar title={item.title} entityId={item.entityId} entityType={entityType} />
      <span>{item.title}</span>
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="network-metrics-row__identity"
      aria-label={`Открыть статистику: ${item.title}`}
      onClick={onOpen}
    >
      {identity}
    </button>
  ) : (
    <div className="network-metrics-row__identity">{identity}</div>
  );
}
export function selectNetworkStatisticsItems(
  items: readonly Item[],
  view: Pick<View, 'search' | 'sort' | 'missing'>,
): Item[] {
  const query = view.search.trim().toLocaleLowerCase('ru-RU');
  return items
    .filter(
      (item) =>
        item.title.toLocaleLowerCase('ru-RU').includes(query) &&
        (!view.missing || item[view.sort] === null),
    )
    .sort((a, b) => {
      const left = a[view.sort],
        right = b[view.sort];
      return (
        (left === null ? (right === null ? 0 : 1) : right === null ? -1 : right - left) ||
        a.title.localeCompare(b.title, 'ru') ||
        a.entityId.localeCompare(b.entityId)
      );
    });
}
export function NetworkStatisticsCommunities({
  data,
  viewKey,
  onOpenCommunity,
}: {
  data: NetworkStatisticsResponse;
  viewKey: string;
  onOpenCommunity?: (entityId: string) => void;
}) {
  const [view, setView] = useState<View>(
    () =>
      views.get(viewKey) ?? {
        expanded: false,
        search: '',
        sort: 'netGrowth',
        missing: false,
        limit: 50,
      },
  );
  useEffect(() => {
    views.delete(viewKey);
    views.set(viewKey, view);
    if (views.size > 48) views.delete(views.keys().next().value!);
  }, [view, viewKey]);
  const update = (value: Partial<View>) => setView((old) => ({ ...old, ...value, limit: 50 }));
  const items = useMemo(() => selectNetworkStatisticsItems(data.items, view), [data.items, view]);
  const limit = view.expanded ? view.limit : 3;
  return (
    <section className="network-stats-communities">
      <div className="network-panel-heading">
        <h2>{view.expanded ? 'Все показатели' : 'По сообществам'}</h2>
        <span>{number.format(data.items.length)}</span>
      </div>
      {view.expanded ? (
        <div className="network-metrics-filters">
          <label className="networks-search">
            <input
              type="search"
              aria-label="Поиск по показателям"
              placeholder="Найти сообщество"
              value={view.search}
              onChange={(event) => update({ search: event.target.value })}
            />
          </label>
          <label>
            Сначала по{' '}
            <select
              aria-label="Сортировка показателей"
              value={view.sort}
              onChange={(event) => update({ sort: event.target.value as View['sort'] })}
            >
              <option value="netGrowth">приросту</option>
              <option value="audience">аудитории</option>
              {data.entityType === 'channel' ? (
                <option value="viewsGained">просмотрам</option>
              ) : null}
            </select>
          </label>
          <label className="network-metrics-missing">
            <input
              type="checkbox"
              checked={view.missing}
              onChange={(event) => update({ missing: event.target.checked })}
            />
            Без данных по выбранному показателю
          </label>
        </div>
      ) : null}
      <div className="network-metrics-list">
        {items.slice(0, limit).map((item) => (
          <article
            className="network-metrics-row"
            key={item.entityId}
            data-network-entity-id={item.entityId}
          >
            <CommunityIdentity
              item={item}
              entityType={data.entityType}
              onOpen={onOpenCommunity ? () => onOpenCommunity(item.entityId) : undefined}
            />
            <div className="network-metrics-row__body">
              <div className="network-metrics-row__values">
                <span>
                  {data.entityType === 'chat' ? 'Участники' : 'Подписчики'}{' '}
                  <b>{metric(item.audience)}</b>
                </span>
                <span>
                  Прирост{' '}
                  <b
                    className={
                      (item.netGrowth ?? 0) < 0
                        ? 'is-negative'
                        : (item.netGrowth ?? 0) > 0
                          ? 'is-positive'
                          : undefined
                    }
                  >
                    {metric(item.netGrowth, true)}
                  </b>
                </span>
                {data.entityType === 'channel' ? (
                  <span>
                    Просмотры <b>{metric(item.viewsGained)}</b>
                    {item.viewsCoverage?.status === 'partial' ? <small>Есть пропуски</small> : null}
                  </span>
                ) : null}
              </div>
              {item.audienceObservedAt ? (
                <small>Аудитория: {stamp.format(new Date(item.audienceObservedAt))} МСК</small>
              ) : null}
            </div>
          </article>
        ))}
        {!items.length ? (
          <p className="network-statistics-caption">
            {view.search || view.missing
              ? 'Сообщества не найдены'
              : 'Нет сообществ с доступной статистикой'}
          </p>
        ) : null}
      </div>
      <div className="network-statistics-actions">
        {view.expanded && limit < items.length ? (
          <button
            type="button"
            className="networks-secondary"
            onClick={() => setView((old) => ({ ...old, limit: old.limit + 50 }))}
          >
            Показать ещё · {items.length - limit}
          </button>
        ) : null}
        {data.items.length > 3 ? (
          <button
            type="button"
            className="networks-secondary"
            onClick={() => update({ expanded: !view.expanded, search: '', missing: false })}
          >
            {view.expanded
              ? 'Свернуть список'
              : `Все показатели · ${number.format(data.items.length)}`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
