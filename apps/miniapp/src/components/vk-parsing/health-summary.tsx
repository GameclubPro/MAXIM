import type { VkParsingHealthSummary } from '@maxim/contracts';
import { formatDurationSeconds, formatPercent } from './format';

type HealthSummaryProps = {
  summary: VkParsingHealthSummary | null | undefined;
};

export function HealthSummary({ summary }: HealthSummaryProps) {
  if (!summary) {
    return null;
  }

  return (
    <div className="vk-parsing-summary" aria-label="Состояние VK-парсинга">
      <span title="Средние запросы VK API за последние минуты">
        VK {summary.vkApiRps.toFixed(1)}/с
      </span>
      <span title="Доля ошибок VK API">{formatPercent(summary.vkApiErrorRate)}</span>
      <span title="Источники, которые требуют внимания">
        {summary.staleSourceCount}/{summary.sourceCount}
      </span>
      <span title="Задержка импорта">{formatDurationSeconds(summary.importLagSeconds)}</span>
      <span title="Задержка публикации">{formatDurationSeconds(summary.publishLagSeconds)}</span>
      <span title="Успешность последних синхронизаций">
        {formatPercent(summary.importSuccessRate)}
      </span>
      {summary.p95SyncDurationMs ? (
        <span title="P95 длительности синхронизации">
          {formatDurationSeconds(Math.ceil(summary.p95SyncDurationMs / 1_000))}
        </span>
      ) : null}
      {summary.publishBacklog > 0 ? (
        <span title="Посты ждут публикации">{summary.publishBacklog}</span>
      ) : null}
      {summary.circuitOpenSourceCount > 0 ? (
        <span title="Источники остановлены circuit breaker">
          {summary.circuitOpenSourceCount}
        </span>
      ) : null}
      {summary.staleSyncLockCount > 0 ? (
        <span title="Зависшие обновления источников">{summary.staleSyncLockCount}</span>
      ) : null}
      {summary.mediaFailureRatio > 0 ? (
        <span title="Доля ошибок медиа">{formatPercent(summary.mediaFailureRatio)}</span>
      ) : null}
    </div>
  );
}
