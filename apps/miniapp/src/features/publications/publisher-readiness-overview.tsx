import { CheckCircle, NavArrowRight, Post, Refresh, WarningCircle } from 'iconoir-react';
import type { PublisherEntitiesSummary } from '@maxim/contracts/publisher';
import { Link } from 'react-router';
import { formatRussianCountLabel } from '../../lib/broadcast-audience';
import { cn } from '../../lib/cn';
import type { PublicationTarget } from './publication-model';
import './publisher-readiness-overview.css';

function formatSummary(
  targets: readonly PublicationTarget[],
  serverSummary: PublisherEntitiesSummary | null,
  loading: boolean,
  error: boolean,
) {
  if (loading && targets.length === 0) {
    return 'Проверяю доступ';
  }
  if (error && targets.length === 0) {
    return 'Не удалось проверить';
  }
  const total = serverSummary?.total ?? targets.length;
  if (total === 0) {
    return 'Нет подключённых получателей';
  }

  const ready =
    serverSummary?.ready ??
    targets.filter((target) => target.readiness?.canPublish === true).length;
  const attention = serverSummary?.attention ?? targets.length - ready;
  if (attention === 0) {
    return formatRussianCountLabel(ready, 'готов', 'готовы', 'готовы');
  }
  return `${formatRussianCountLabel(ready, 'готов', 'готовы', 'готовы')} · ${formatRussianCountLabel(
    attention,
    'требует внимания',
    'требуют внимания',
    'требуют внимания',
  )}`;
}

export function PublisherReadinessOverview({
  targets,
  serverSummary,
  loading,
  fetching,
  error,
  onRefresh,
}: {
  targets: PublicationTarget[];
  serverSummary: PublisherEntitiesSummary | null;
  loading: boolean;
  fetching: boolean;
  error: boolean;
  onRefresh: () => void;
}) {
  const allReady = serverSummary
    ? serverSummary.total > 0 && serverSummary.attention === 0
    : targets.length > 0 && targets.every((target) => target.readiness?.canPublish === true);
  const summary = formatSummary(targets, serverSummary, loading, error);

  return (
    <section
      className={cn('publisher-readiness-overview', error && 'has-error')}
      aria-busy={loading || fetching}
      aria-label="Получатели Публика"
    >
      <span className="publisher-readiness-overview__mark" aria-hidden>
        {error ? <WarningCircle /> : allReady ? <CheckCircle /> : <Post />}
      </span>
      <span className="publisher-readiness-overview__copy">
        <strong>Получатели</strong>
        <small role="status" aria-live="polite">
          {summary}
        </small>
      </span>
      <Link to="/" className="publisher-readiness-overview__link">
        <span>Чаты и каналы</span>
        <NavArrowRight aria-hidden />
      </Link>
      <button
        type="button"
        className={cn('publisher-readiness-overview__refresh', fetching && 'is-refreshing')}
        aria-label="Обновить доступность получателей"
        title="Обновить"
        disabled={fetching}
        onClick={onRefresh}
      >
        <Refresh aria-hidden />
      </button>
    </section>
  );
}
