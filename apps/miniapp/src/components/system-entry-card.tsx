import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { describeApiError } from '../lib/api-error';
import { getSystemDashboard } from '../lib/api/system-client';
import type { ApiTransport } from '../lib/api/transport';
import { queryKeys } from '../lib/query-keys';
import { preloadSystemPage } from '../pages/page-preloads';
import { GlassCard } from './ui/glass-card';

export function SystemEntryCard({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const systemPreviewQuery = useQuery({
    queryKey: queryKeys.systemDashboard,
    queryFn: () => getSystemDashboard(api),
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: 0,
  });

  const systemStatus = systemPreviewQuery.data?.summary.status ?? 'healthy';
  const systemChipClassName =
    systemStatus === 'critical'
      ? 'chip chip--danger'
      : systemStatus === 'warning'
        ? 'chip chip--warning'
        : 'chip chip--success';
  const systemChipLabel =
    systemStatus === 'critical'
      ? 'Нужна реакция'
      : systemStatus === 'warning'
        ? 'Под наблюдением'
        : 'В норме';

  function prefetchSystemCenter() {
    preloadSystemPage();
    void queryClient
      .prefetchQuery({
        queryKey: queryKeys.systemDashboard,
        queryFn: () => getSystemDashboard(api),
      })
      .catch(() => undefined);
  }

  return (
    <Link
      to="/system"
      className="system-root-card-link"
      onPointerEnter={prefetchSystemCenter}
      onTouchStart={prefetchSystemCenter}
      aria-label={`Система: ${systemChipLabel}`}
    >
      <GlassCard className="system-root-card" elevated>
        <div className="system-root-card__eyebrow">
          <span className="chip">Система</span>
          <span className={systemChipClassName}>{systemChipLabel}</span>
        </div>
        <div className="system-root-card__content">
          <div className="system-root-card__stats" aria-label="Ключевые метрики">
            <div className="system-root-card__stat">
              <span>Задержка</span>
              <strong>
                {systemPreviewQuery.data
                  ? `${systemPreviewQuery.data.queues.effectiveLagSec.toFixed(1)}с`
                  : '...'}
              </strong>
            </div>
            <div className="system-root-card__stat">
              <span>Ошибки</span>
              <strong>{systemPreviewQuery.data?.queues.webhookEvents.failed.count ?? '...'}</strong>
            </div>
            <div className="system-root-card__stat">
              <span>Критично</span>
              <strong>
                {systemPreviewQuery.data
                  ? `${(systemPreviewQuery.data.mode.action.criticalRate * 100).toFixed(1)}%`
                  : '...'}
              </strong>
            </div>
          </div>
        </div>
        {systemPreviewQuery.error ? (
          <p className="system-root-card__error">
            {describeApiError(systemPreviewQuery.error, 'Операционный центр временно недоступен.')}
          </p>
        ) : null}
      </GlassCard>
    </Link>
  );
}
