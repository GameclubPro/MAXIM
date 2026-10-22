import type { ManagedEntityType } from '@maxim/contracts';
import type {
  NetworkMetricCoverage,
  NetworkStatisticsResponse,
} from '@maxim/contracts/networks-stats';
import { AppIcon } from '../../components/ui/app-icon';
import { Spinner } from '../../components/ui/spinner';
import type { NetworkStatisticsRange, NetworkStatisticsState } from './network-statistics';
import './network-statistics-view.css';

const number = new Intl.NumberFormat('ru-RU');
const date = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  timeZone: 'Europe/Moscow',
});
const timestamp = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Moscow',
});
export function formatNetworkMetric(value: number | null, signed = false): string {
  return value == null ? '—' : `${signed && value > 0 ? '+' : ''}${number.format(value)}`;
}
function Coverage({ value, growth = false }: { value: NetworkMetricCoverage; growth?: boolean }) {
  return (
    <div className="network-metric-coverage">
      <span className={`network-coverage-badge is-${value.status}`}>
        {value.status === 'ready'
          ? 'Данные собраны'
          : value.status === 'partial'
            ? 'Частичные данные'
            : 'Нет наблюдений'}
        {' · '}
        {number.format(value.includedEntities)}/{number.format(value.totalEntities)}
      </span>
      <small>
        {growth ? 'Последние наблюдения' : 'Обновлено'}:{' '}
        {value.asOf ? `${timestamp.format(new Date(value.asOf))} МСК` : '—'}
      </small>
    </div>
  );
}
function Metric({
  label,
  metric,
  growth = false,
}: {
  label: string;
  metric: NetworkStatisticsResponse['audience'];
  growth?: boolean;
}) {
  return (
    <article className="network-detail-metric">
      <span>{label}</span>
      <strong
        className={
          growth && metric.value ? (metric.value > 0 ? 'is-positive' : 'is-negative') : undefined
        }
      >
        {formatNetworkMetric(metric.value, growth)}
      </strong>
      <Coverage value={metric.coverage} growth={growth} />
    </article>
  );
}
function GrowthChart({ series }: { series: NetworkStatisticsResponse['series'] }) {
  const max = Math.max(1, ...series.map((point) => Math.abs(point.netGrowth ?? 0)));
  const observed = series.some((point) => point.netGrowth != null);
  return (
    <section className="network-growth-panel" aria-labelledby="network-growth-title">
      <div className="network-panel-heading">
        <div>
          <h2 id="network-growth-title">Прирост по дням</h2>
        </div>
        <AppIcon icon="StatsUpSquare" />
      </div>
      {observed ? (
        <>
          <svg
            className="network-growth-bars"
            viewBox="0 0 600 170"
            preserveAspectRatio="none"
            role="img"
            aria-label="Дневной прирост. Пропуски означают отсутствие наблюдений; точные значения доступны в таблице ниже."
          >
            <line className="network-growth-baseline" x1="0" x2="600" y1="85" y2="85" />
            {series.map((point, index) => {
              const step = 600 / Math.max(series.length, 1);
              const height = Math.max(
                point.netGrowth === 0 ? 1 : 3,
                (Math.abs(point.netGrowth ?? 0) / max) * 76,
              );
              const label = `${date.format(new Date(point.at))}: ${formatNetworkMetric(point.netGrowth, true)}`;
              return (
                <g
                  key={point.at}
                  className={`network-growth-day ${point.netGrowth == null ? 'is-missing' : point.netGrowth < 0 ? 'is-negative' : 'is-positive'}`}
                >
                  <title>{label}</title>
                  {point.netGrowth != null ? (
                    <rect
                      x={index * step + 2}
                      y={point.netGrowth < 0 ? 85 : 85 - height}
                      width={Math.max(step - 4, 2)}
                      height={height}
                      rx="3"
                    />
                  ) : (
                    <circle cx={index * step + step / 2} cy="85" r="2" />
                  )}
                </g>
              );
            })}
          </svg>
          <div className="network-chart-dates">
            <span>{series[0] ? date.format(new Date(series[0].at)) : ''}</span>
            <span>Пропуск — нет данных</span>
            <span>{series.at(-1) ? date.format(new Date(series.at(-1)!.at)) : ''}</span>
          </div>
        </>
      ) : (
        <div className="network-chart-empty">
          <AppIcon icon="StatsUpSquare" />
          <strong>Пока нет наблюдений о приросте</strong>
          <span>Данные появятся по мере наблюдений за сообществами.</span>
        </div>
      )}
      <details className="network-daily-details">
        <summary>Значения по дням</summary>
        <div className="network-statistics-table-scroll">
          <table>
            <caption className="sr-only">Наблюдаемый дневной прирост</caption>
            <thead>
              <tr>
                <th scope="col">День</th>
                <th scope="col">Прирост</th>
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.at}>
                  <th scope="row">{date.format(new Date(point.at))}</th>
                  <td>{formatNetworkMetric(point.netGrowth, true)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
function Communities({
  data,
  entityType,
  onOpenCommunities,
  onOpenCommunity,
}: {
  data: NetworkStatisticsResponse;
  entityType: ManagedEntityType;
  onOpenCommunities?: () => void;
  onOpenCommunity?: (entityId: string) => void;
}) {
  const limit = 8;
  const items = [...data.items].sort(
    (a, b) =>
      (b.netGrowth ?? -Infinity) - (a.netGrowth ?? -Infinity) ||
      a.title.localeCompare(b.title, 'ru'),
  );
  return (
    <section className="network-stats-communities">
      <div className="network-panel-heading">
        <h2>По сообществам</h2>
        <span>{number.format(items.length)}</span>
      </div>
      <p className="network-statistics-caption">Сначала наибольший прирост за период</p>
      {items.length ? (
        <div className="network-statistics-table-scroll">
          <table>
            <caption className="sr-only">Статистика доступных сообществ сетки</caption>
            <thead>
              <tr>
                <th scope="col">{entityType === 'chat' ? 'Чат' : 'Канал'}</th>
                <th scope="col">{entityType === 'chat' ? 'Участники' : 'Подписчики'}</th>
                <th scope="col">Прирост</th>
                {entityType === 'channel' ? <th scope="col">Просмотры</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.slice(0, limit).map((item) => (
                <tr key={item.entityId}>
                  <th scope="row">
                    {onOpenCommunity ? (
                      <button
                        type="button"
                        className="networks-text-button"
                        onClick={() => onOpenCommunity(item.entityId)}
                      >
                        {item.title}
                      </button>
                    ) : (
                      <span>{item.title}</span>
                    )}
                    {item.audienceObservedAt ? (
                      <small>{timestamp.format(new Date(item.audienceObservedAt))} МСК</small>
                    ) : null}
                  </th>
                  <td>{formatNetworkMetric(item.audience)}</td>
                  <td>{formatNetworkMetric(item.netGrowth, true)}</td>
                  {entityType === 'channel' ? (
                    <td>{formatNetworkMetric(item.viewsGained)}</td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="network-statistics-caption">
          Нет сообществ с подтверждённым доступом к статистике.
        </p>
      )}
      <div className="network-statistics-actions">
        {limit < items.length ? (
          <span className="network-statistics-caption">
            Показаны {limit} из {number.format(items.length)}
          </span>
        ) : null}
        {onOpenCommunities ? (
          <button type="button" className="networks-secondary" onClick={onOpenCommunities}>
            <AppIcon icon="Group" />
            Все сообщества
          </button>
        ) : null}
      </div>
    </section>
  );
}

export interface NetworkStatisticsViewProps {
  state: NetworkStatisticsState;
  entityType: ManagedEntityType;
  range: NetworkStatisticsRange;
  onOpenCommunity?: (entityId: string) => void;
  onOpenCommunities?: () => void;
  className?: string;
}
export function NetworkStatisticsView({
  state,
  entityType,
  range,
  onOpenCommunities,
  onOpenCommunity,
  className,
}: NetworkStatisticsViewProps) {
  const { data } = state;
  if (!data)
    return (
      <div className="network-statistics-empty" role={state.phase === 'error' ? 'alert' : 'status'}>
        {state.phase === 'loading' || state.phase === 'checking' ? (
          <Spinner />
        ) : (
          <AppIcon icon="StatsUpSquare" />
        )}
        <strong>
          {state.phase === 'error'
            ? 'Не удалось загрузить статистику'
            : state.phase === 'stale'
              ? 'Состав сетки изменился'
              : 'Собираем общую картину'}
        </strong>
        <p>
          {state.phase === 'error' || state.phase === 'stale'
            ? 'Обновите данные, чтобы продолжить.'
            : 'Проверяем доступ к статистике сообществ.'}
        </p>
        {state.phase === 'error' || state.phase === 'stale' ? (
          <button type="button" className="networks-secondary" onClick={state.refresh}>
            Повторить
          </button>
        ) : null}
      </div>
    );
  return (
    <div
      className={`network-statistics-view ${className ?? ''}`}
      aria-busy={state.phase === 'checking'}
    >
      {state.phase === 'checking' ? (
        <div className="network-statistics-progress" role="status">
          <Spinner />
          <span>
            Проверяем доступ · {number.format(data.authorization.checked)} из{' '}
            {number.format(data.authorization.total)}
          </span>
        </div>
      ) : null}
      <div className={`network-detail-metrics ${entityType === 'channel' ? 'has-views' : ''}`}>
        <Metric
          label={entityType === 'chat' ? 'Участники сейчас' : 'Подписчики сейчас'}
          metric={data.audience}
        />
        <Metric
          label={`Прирост · ${range === '7d' ? 7 : 30} дней`}
          metric={data.netGrowth}
          growth
        />
        {entityType === 'channel' && data.viewsGained ? (
          <Metric label="Прирост просмотров" metric={data.viewsGained} growth />
        ) : null}
      </div>
      <p className="network-statistics-caption">
        Суммарная аудитория · участники разных сообществ могут повторяться
      </p>
      <GrowthChart series={data.series} />
      <details className="network-statistics-method network-daily-details">
        <summary>О данных</summary>
        <p>
          Период: {date.format(new Date(data.period.from))} —{' '}
          {timestamp.format(new Date(data.period.to))} МСК. Расчёт по текущему составу сетки.
        </p>
        <p>
          Прирост — наблюдаемые вступления минус выходы. Пропуски означают отсутствие данных.
          Текущий день ещё не завершён.
        </p>
        <p>
          Частичные данные охватывают только доступные наблюдения. Первые наблюдения об аудитории:{' '}
          {data.audience.coverage.observedFrom
            ? date.format(new Date(data.audience.coverage.observedFrom))
            : '—'}
          ; о приросте:{' '}
          {data.netGrowth.coverage.observedFrom
            ? date.format(new Date(data.netGrowth.coverage.observedFrom))
            : '—'}
          .
        </p>
        {entityType === 'channel' ? (
          <p>
            Просмотры — прирост за период, включая старые публикации. MAX возвращает периодические
            замеры: между ними точное время прироста неизвестно.
            {data.unallocatedViews > 0
              ? ` Нельзя распределить по дням: ${number.format(data.unallocatedViews)}.`
              : ''}
          </p>
        ) : null}
      </details>
      <Communities
        key={`${data.entityType}:${data.favoriteType}:${data.period.range}`}
        data={data}
        entityType={entityType}
        onOpenCommunities={onOpenCommunities}
        onOpenCommunity={onOpenCommunity}
      />
      <button
        type="button"
        className="networks-text-button network-statistics-refresh"
        onClick={state.refresh}
      >
        <AppIcon icon="RefreshDouble" />
        Обновить статистику
      </button>
    </div>
  );
}
