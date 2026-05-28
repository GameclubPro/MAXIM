import type { VkParsingHealthSummary } from '@maxim/contracts';
import { formatDurationSeconds, formatPercent } from './format';

type HealthSummaryProps = {
  summary: VkParsingHealthSummary | null | undefined;
};

export function HealthSummary({ summary }: HealthSummaryProps) {
  if (!summary) {
    return null;
  }

  const items = [
    {
      label: 'API',
      value: `${summary.vkApiRps.toFixed(1)}/с`,
      title: 'Средние запросы VK API',
      tone: summary.vkApiErrorRate > 0.05 ? 'warning' : undefined,
    },
    {
      label: 'Ошибки',
      value: formatPercent(summary.vkApiErrorRate),
      title: 'Доля ошибок VK API',
      tone: summary.vkApiErrorRate > 0.05 ? 'danger' : undefined,
    },
    {
      label: 'Импорт',
      value: formatDurationSeconds(summary.importLagSeconds),
      title: 'Задержка импорта',
      tone: summary.staleSourceCount > 0 ? 'warning' : undefined,
    },
    {
      label: 'Публикация',
      value: formatDurationSeconds(summary.publishLagSeconds),
      title: 'Задержка публикации',
      tone: summary.publishBacklog > 0 ? 'warning' : undefined,
    },
    {
      label: 'Успех',
      value: formatPercent(summary.importSuccessRate),
      title: 'Успешность синхронизаций',
      tone: summary.importSuccessRate < 0.9 ? 'warning' : undefined,
    },
  ];

  return (
    <div className="vk-parsing-summary" aria-label="Состояние VK-парсинга">
      {items.map((item) => (
        <span
          key={item.label}
          className={item.tone ? `is-${item.tone}` : undefined}
          title={item.title}
        >
          <b>{item.value}</b>
          <small>{item.label}</small>
        </span>
      ))}
      {summary.staleSourceCount > 0 ? (
        <span className="is-warning" title="Источники, которые требуют внимания">
          <b>
            {summary.staleSourceCount}/{summary.sourceCount}
          </b>
          <small>Источники</small>
        </span>
      ) : null}
      {summary.p95SyncDurationMs ? (
        <span title="P95 длительности синхронизации">
          <b>{formatDurationSeconds(Math.ceil(summary.p95SyncDurationMs / 1_000))}</b>
          <small>P95</small>
        </span>
      ) : null}
      {summary.publishBacklog > 0 ? (
        <span className="is-warning" title="Посты ждут публикации">
          <b>{summary.publishBacklog}</b>
          <small>Backlog</small>
        </span>
      ) : null}
      {summary.circuitOpenSourceCount > 0 ? (
        <span className="is-danger" title="Источники остановлены circuit breaker">
          <b>{summary.circuitOpenSourceCount}</b>
          <small>Стоп</small>
        </span>
      ) : null}
      {summary.staleSyncLockCount > 0 ? (
        <span className="is-danger" title="Зависшие обновления источников">
          <b>{summary.staleSyncLockCount}</b>
          <small>Locks</small>
        </span>
      ) : null}
      {summary.mediaFailureRatio > 0 ? (
        <span className="is-warning" title="Доля ошибок медиа">
          <b>{formatPercent(summary.mediaFailureRatio)}</b>
          <small>Медиа</small>
        </span>
      ) : null}
    </div>
  );
}
