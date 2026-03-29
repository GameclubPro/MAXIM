import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { describeApiError } from '../lib/api-error';
import { getSystemDashboard } from '../lib/api/system-client';
import type { ApiTransport } from '../lib/api/transport';
import { preloadSystemPage } from '../pages/lazy-pages';
import { GlassCard } from './ui/glass-card';

export function SystemEntryCard({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const systemPreviewQuery = useQuery({
    queryKey: ['system-dashboard'],
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
        queryKey: ['system-dashboard'],
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
    >
      <GlassCard className="system-root-card" elevated>
        <div className="system-root-card__eyebrow">
          <span className="chip">Operations</span>
          <span className={systemChipClassName}>{systemChipLabel}</span>
        </div>
        <div className="system-root-card__content">
          <div className="system-root-card__copy">
            <h2>{systemPreviewQuery.data?.summary.title ?? 'Операционный центр'}</h2>
            <p>
              {systemPreviewQuery.data?.summary.detail ??
                'Подтягиваю live-сводку по webhook, очередям и MAX-лимитам.'}
            </p>
          </div>
          <div className="system-root-card__stats" aria-label="Ключевые метрики">
            <div className="system-root-card__stat">
              <span>Lag</span>
              <strong>
                {systemPreviewQuery.data
                  ? `${systemPreviewQuery.data.queues.effectiveLagSec.toFixed(1)}с`
                  : '...'}
              </strong>
            </div>
            <div className="system-root-card__stat">
              <span>Failed</span>
              <strong>{systemPreviewQuery.data?.queues.webhookEvents.failed.count ?? '...'}</strong>
            </div>
            <div className="system-root-card__stat">
              <span>Critical</span>
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
