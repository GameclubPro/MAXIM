import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import { getSystemBots, getSystemDashboard, setSystemMode } from '../lib/api/system-client';
import type { ApiTransport } from '../lib/api/transport';
import { queryKeys } from '../lib/query-keys';
import '../styles/system-page.css';

type SystemModeSelection = 'auto' | 'normal' | 'degrade';
type WebhookSubscriptionStatus = 'healthy' | 'warning' | 'critical' | 'disabled';

const SYSTEM_MODE_OPTIONS = [
  { value: 'auto', label: 'Auto' },
  { value: 'normal', label: 'Normal' },
  { value: 'degrade', label: 'Degrade' },
] as const;

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value === 0 ? 0 : value < 0.1 ? 2 : 1)}%`;
}

function formatLag(seconds: number): string {
  if (seconds < 1) {
    return `${Math.round(seconds * 1_000)} мс`;
  }

  if (seconds < 60) {
    return `${seconds.toFixed(seconds < 10 ? 1 : 0)} c`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes} мин ${remainder} c`;
}

function formatMs(value: number | null | undefined): string {
  if (typeof value !== 'number') {
    return 'n/a';
  }

  if (value < 1_000) {
    return `${Math.round(value)} мс`;
  }

  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} c`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatWindow(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} c`;
  }

  const minutes = Math.round(seconds / 60);
  return `${minutes} мин`;
}

function formatAuxiliaryQueueLabel(name: string): string {
  const labels: Record<string, string> = {
    'admin-managed-entities-refresh': 'Managed refresh',
    'vk-parsing-sync': 'VK sync',
    'vk-parsing-publish': 'VK publish',
    'night-mode-transitions': 'Night mode',
    'max-chat-admin-roster-sync': 'Roster sync',
    'admin-manual-fanout': 'Manual fanout',
    'admin-super-ban': 'Super ban',
    'admin-suggestion-delivery': 'Suggestion delivery',
  };

  return labels[name] ?? name;
}

function summaryTone(status: 'healthy' | 'warning' | 'critical') {
  if (status === 'critical') {
    return 'danger';
  }

  if (status === 'warning') {
    return 'warning';
  }

  return 'success';
}

function summaryChipClass(status: 'healthy' | 'warning' | 'critical') {
  if (status === 'critical') {
    return 'chip chip--danger';
  }

  if (status === 'warning') {
    return 'chip chip--warning';
  }

  return 'chip chip--success';
}

function summaryChipLabel(status: 'healthy' | 'warning' | 'critical') {
  if (status === 'critical') {
    return 'Critical';
  }

  if (status === 'warning') {
    return 'Warning';
  }

  return 'Healthy';
}

function alertCardClass(level: 'info' | 'warning' | 'critical') {
  if (level === 'critical') {
    return 'system-alert-card is-critical';
  }

  if (level === 'warning') {
    return 'system-alert-card is-warning';
  }

  return 'system-alert-card is-info';
}

function canaryChipStatus(status: string): 'healthy' | 'warning' | 'critical' {
  if (status === 'degraded') {
    return 'critical';
  }

  if (status === 'canary' || status === 'shadow') {
    return 'warning';
  }

  return 'healthy';
}

function rollbackChipStatus(status: string): 'healthy' | 'warning' | 'critical' {
  if (status === 'rollback-recommended') {
    return 'critical';
  }

  if (status === 'blocked') {
    return 'warning';
  }

  return 'healthy';
}

function webhookStatusChipClass(status: WebhookSubscriptionStatus | undefined): string {
  if (status === 'critical') {
    return 'chip chip--danger';
  }

  if (status === 'warning') {
    return 'chip chip--warning';
  }

  if (status === 'healthy') {
    return 'chip chip--success';
  }

  return 'chip';
}

function webhookStatusRank(status: WebhookSubscriptionStatus | undefined): number {
  if (status === 'critical') {
    return 3;
  }

  if (status === 'warning') {
    return 2;
  }

  if (status === 'disabled') {
    return 1;
  }

  return 0;
}

function sumNumericRecord(record: Record<string, number> | undefined): number {
  if (!record) {
    return 0;
  }

  return Object.values(record).reduce((sum, value) => sum + value, 0);
}

function formatBotIssue(code: string): string {
  const labels: Record<string, string> = {
    'no-active-memberships': 'нет active memberships',
    'no-incoming-webhooks': 'нет входящих webhook',
  };

  return labels[code] ?? code;
}

function formatBotProblemKind(kind: string): string {
  const labels: Record<string, string> = {
    'lost-access': 'access lost',
    'stale-access': 'stale access',
    'denied-access': 'access denied',
    'removed-after-loss': 'removed after loss',
  };

  return labels[kind] ?? kind;
}

export function SystemPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const dashboardQuery = useQuery({
    queryKey: queryKeys.systemDashboard,
    queryFn: () => getSystemDashboard(api),
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });
  const botsQuery = useQuery({
    queryKey: queryKeys.systemBots,
    queryFn: () => getSystemBots(api),
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });
  const modeMutation = useMutation({
    mutationFn: (mode: SystemModeSelection) => setSystemMode(api, mode),
    onSuccess: async (_, mode) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.systemDashboard });
      await queryClient.invalidateQueries({ queryKey: queryKeys.systemBots });
      pushToast({
        tone: 'success',
        title: 'Режим обновлён',
        description:
          mode === 'auto'
            ? 'Автоматическое управление снова активно.'
            : `Система переведена в ${mode} вручную.`,
      });
    },
    onError: (error: unknown) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить режим',
        description: describeApiError(error, 'Повторите попытку чуть позже.'),
      });
    },
  });

  if (dashboardQuery.isLoading) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="neutral"
            title="Подключаем операционный центр"
            description="Собираю live-сводку по webhook, очередям и MAX-лимитам."
          />
        </GlassCard>
      </div>
    );
  }

  if (dashboardQuery.error || !dashboardQuery.data) {
    return (
      <div className="page-stack page-enter">
        <GlassCard>
          <StatusState
            tone="danger"
            title="Операционный центр недоступен"
            description={describeApiError(
              dashboardQuery.error,
              'Не удалось получить сводку состояния системы.',
            )}
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => dashboardQuery.refetch()}
              >
                Повторить
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  const dashboard = dashboardQuery.data;
  const selectedMode: SystemModeSelection =
    dashboard.mode.source === 'manual'
      ? (dashboard.mode.manualMode ?? dashboard.mode.mode)
      : 'auto';
  const failedEvents = dashboard.queues.webhookEvents.failed.count;
  const queuedEvents = dashboard.queues.webhookEvents.queued.count;
  const receivedEvents = dashboard.queues.webhookEvents.received.count;
  const queueCount =
    dashboard.queues.webhookCritical.waiting +
    dashboard.queues.webhookDefault.waiting +
    dashboard.queues.webhookBackground.waiting +
    dashboard.queues.webhookLegacy.waiting;
  const queueLayers = [
    { label: 'Webhook critical', queue: dashboard.queues.webhookCritical },
    { label: 'Webhook default', queue: dashboard.queues.webhookDefault },
    { label: 'Webhook background', queue: dashboard.queues.webhookBackground },
    { label: 'Webhook legacy', queue: dashboard.queues.webhookLegacy },
    { label: 'Actions', queue: dashboard.queues.actions },
    { label: 'Spammer denorm', queue: dashboard.queues.globalSpammerDenorm },
    { label: 'Moderation total', queue: dashboard.queues.moderation },
  ];
  const auxiliaryQueueLayers = Object.entries(dashboard.queues.auxiliaryQueues ?? {})
    .map(([name, queue]) => ({
      name,
      label: formatAuxiliaryQueueLabel(name),
      queue,
      pressure: queue.waiting + queue.active + queue.failed,
    }))
    .sort((left, right) => {
      const pressureDiff = right.pressure - left.pressure;
      return pressureDiff !== 0 ? pressureDiff : left.label.localeCompare(right.label);
    });
  const hotPathStages = dashboard.hotPath?.stages.slice(0, 6) ?? [];
  const hotChats = dashboard.hotChats?.items.slice(0, 6) ?? [];
  const backgroundSources = dashboard.backgroundBudget?.topSources.slice(0, 5) ?? [];
  const backgroundPauses = dashboard.backgroundBudget?.pauseReasons.slice(0, 5) ?? [];
  const stackLoad = dashboard.backgroundBudget?.stackLoad;
  const topBotLoad = dashboard.backgroundBudget?.botLoad?.topBots[0] ?? null;
  const membershipIssues = dashboard.membershipLookup?.issueSample.slice(0, 5) ?? [];
  const slo = dashboard.slo ?? dashboard.webhookSlo;
  const queueGroups = dashboard.queueGroupHealth?.groups.slice(0, 16) ?? [];
  const spammerReadModel = dashboard.spammerReadModel;
  const spammerSurfaceTimings = dashboard.spammerSurfaces?.timings.slice(0, 6) ?? [];
  const ownershipAnomalyCount = Object.values(dashboard.ownership.anomalies).reduce(
    (sum, value) => sum + value,
    0,
  );
  const recoverableOwnershipCount =
    dashboard.ownership.anomalies.recoverableLegacyOnly +
    dashboard.ownership.anomalies.recoverableFromMemberships;
  const webhookOperationalDiagnostics = dashboard.webhookSubscription.operationalDiagnostics;
  const botFleet = botsQuery.data;
  const botRows = (botFleet
    ? botFleet.bots
    : Array.from(
        new Set([
          ...Object.keys(dashboard.webhookSubscription.bots),
          ...Object.keys(dashboard.queues.bots),
        ]),
      ).map((botId) => {
        const webhook = dashboard.webhookSubscription.bots[botId];
        const queue = dashboard.queues.bots[botId];
        const operationalDiagnostics = webhook?.operationalDiagnostics;

        return {
          botId,
          label: botId,
          characterName: botId,
          lifecycleState: operationalDiagnostics?.lifecycleState ?? 'unknown',
          adminVisible: true,
          isDefault: false,
          contactId: null,
          webhook,
          operationalDiagnostics,
          queue,
          maxApiLoad: null,
          entities: null,
          access: null,
          problemSamples: [],
        };
      })
  )
    .map((bot) => ({
      ...bot,
      issueCodes: bot.operationalDiagnostics?.issueCodes ?? [],
      queuedWork: sumNumericRecord(bot.queue?.queuedByQueue),
      failedEvents: bot.queue?.webhookEvents.failed.count ?? 0,
      receivedEvents: bot.queue?.webhookEvents.received.count ?? 0,
      effectiveLagSec: bot.queue?.effectiveLagSec ?? 0,
      accessProblemCount:
        (bot.access?.lost ?? 0) + (bot.access?.stale ?? 0) + (bot.access?.denied ?? 0),
    }))
    .sort((left, right) => {
      const statusDiff =
        webhookStatusRank(right.webhook?.status) - webhookStatusRank(left.webhook?.status);
      if (statusDiff !== 0) {
        return statusDiff;
      }

      const accessDiff = right.accessProblemCount - left.accessProblemCount;
      if (accessDiff !== 0) {
        return accessDiff;
      }

      const failedDiff = right.failedEvents - left.failedEvents;
      if (failedDiff !== 0) {
        return failedDiff;
      }

      const lagDiff = right.effectiveLagSec - left.effectiveLagSec;
      if (lagDiff !== 0) {
        return lagDiff;
      }

      return left.botId.localeCompare(right.botId);
    });
  return (
    <div className="page-stack page-enter">
      <GlassCard className="system-hero" elevated>
        <div className="system-hero__eyebrow">
          <span className="chip">Операционный центр</span>
          <span className={summaryChipClass(dashboard.summary.status)}>
            {summaryChipLabel(dashboard.summary.status)}
          </span>
          <button
            type="button"
            className="button button--ghost system-hero__refresh"
            onClick={() => {
              void dashboardQuery.refetch();
              void botsQuery.refetch();
            }}
            disabled={dashboardQuery.isFetching || botsQuery.isFetching}
          >
            {dashboardQuery.isFetching || botsQuery.isFetching ? 'Обновляем…' : 'Обновить'}
          </button>
        </div>
        <div className="system-hero__main">
          <div className="system-hero__copy">
            <h1>{dashboard.summary.title}</h1>
            <p>{dashboard.summary.detail}</p>
          </div>
          <div className="system-hero__stats">
            <div className="system-hero__stat">
              <span>Queue lag</span>
              <strong>{formatLag(dashboard.queues.effectiveLagSec)}</strong>
            </div>
            <div className="system-hero__stat">
              <span>Failed webhook</span>
              <strong>{failedEvents}</strong>
            </div>
            <div className="system-hero__stat">
              <span>Critical rate</span>
              <strong>{formatPercent(dashboard.mode.action.criticalRate)}</strong>
            </div>
          </div>
        </div>
        <div className="system-hero__footer">
          <span>Причина режима: {dashboard.mode.reason}</span>
          <span>Обновлено {formatTime(dashboard.summary.generatedAt)}</span>
        </div>
      </GlassCard>

      <section className="system-grid" aria-label="Ключевые панели">
        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Режим системы</h2>
              <p>Управление auto-mode без похода в консоль.</p>
            </div>
            <span className="chip">
              {dashboard.mode.source === 'manual' ? 'Manual override' : 'Auto policy'}
            </span>
          </div>
          <SegmentedControl<SystemModeSelection>
            value={selectedMode}
            options={[...SYSTEM_MODE_OPTIONS]}
            onChange={(nextMode) => {
              if (modeMutation.isPending || nextMode === selectedMode) {
                return;
              }
              modeMutation.mutate(nextMode);
            }}
            className="system-mode-control"
            ariaLabel="Режим системы"
          />
          <p className="system-panel__hint">
            {dashboard.summary.stabilizing
              ? 'Система уже ровнее, но защитное окно auto-mode ещё не завершилось.'
              : dashboard.mode.source === 'manual'
                ? 'Ручной режим активен. Верните auto после завершения инцидента.'
                : 'Auto-mode сам реагирует на lag и MAX critical rate.'}
          </p>
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Spammer surfaces</h2>
              <p>p95 по админским запросам базы спамеров и досье.</p>
            </div>
            <span className="chip">
              {dashboard.spammerSurfaces ? formatWindow(dashboard.spammerSurfaces.windowSec) : 'n/a'}
            </span>
          </div>
          {spammerSurfaceTimings.length > 0 ? (
            <div className="system-runtime-list">
              {spammerSurfaceTimings.map((timing) => (
                <article
                  key={`${timing.surface}:${timing.stage}`}
                  className="system-runtime-row"
                >
                  <div>
                    <strong>
                      {timing.surface} · {timing.stage}
                    </strong>
                    <span>
                      avg {formatMs(timing.avgMs)} · max {formatMs(timing.maxMs)}
                    </span>
                  </div>
                  <div className="system-runtime-row__meta">
                    <span className="chip">p95 {formatMs(timing.p95Ms)}</span>
                    <span className="chip">p99 {formatMs(timing.p99Ms)}</span>
                    <small>{timing.count} samples</small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="system-panel__hint">Spammer surface timings пока не попадали в окно.</p>
          )}
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Spammer read model</h2>
              <p>Runtime-срез кеша профилей, shadow parity и denorm freshness.</p>
            </div>
            <span className="chip">
              {spammerReadModel ? formatWindow(spammerReadModel.windowSec) : 'n/a'}
            </span>
          </div>
          {spammerReadModel ? (
            <>
              <div className="system-runtime-grid">
                <article className="system-runtime-card">
                  <span>Profile hit rate</span>
                  <strong>{formatPercent(spammerReadModel.profileReads.hitRate)}</strong>
                  <small>
                    {spammerReadModel.profileReads.hits} hit /{' '}
                    {spammerReadModel.profileReads.misses} miss /{' '}
                    {spammerReadModel.profileReads.stale} stale
                  </small>
                </article>
                <article className="system-runtime-card">
                  <span>Shadow mismatch</span>
                  <strong>{formatPercent(spammerReadModel.shadow.mismatchRate)}</strong>
                  <small>
                    {spammerReadModel.shadow.matched} matched /{' '}
                    {spammerReadModel.shadow.mismatched} mismatch;{' '}
                    {formatPercent(spammerReadModel.shadow.scoreDriftRate)} score drift
                  </small>
                </article>
                <article className="system-runtime-card">
                  <span>Denorm job age</span>
                  <strong>{formatMs(spammerReadModel.denormJobs.avgAgeMs)}</strong>
                  <small>
                    max {formatMs(spammerReadModel.denormJobs.maxAgeMs)} ·{' '}
                    {spammerReadModel.denormJobs.enqueued} queued /{' '}
                    {spammerReadModel.denormJobs.processed} ok /{' '}
                    {spammerReadModel.denormJobs.failed} fail
                  </small>
                </article>
              </div>
              <div className="system-chip-list">
                <span className="chip">
                  fallbacks {spammerReadModel.profileReads.fallbacks}
                </span>
                <span
                  className={
                    spammerReadModel.profileWrites.failure > 0 ? 'chip chip--warning' : 'chip'
                  }
                >
                  writes {spammerReadModel.profileWrites.success}/
                  {spammerReadModel.profileWrites.failure}
                </span>
                <span
                  className={
                    spammerReadModel.denormJobs.enqueueFailed > 0 ||
                    spammerReadModel.denormJobs.failed > 0
                      ? 'chip chip--warning'
                      : 'chip'
                  }
                >
                  enqueue fail {spammerReadModel.denormJobs.enqueueFailed}
                </span>
                <span
                  className={
                    spammerReadModel.denormJobs.fastPathFallbacks > 0 ||
                    spammerReadModel.denormJobs.fastPathReplayMissing > 0
                      ? 'chip chip--warning'
                      : 'chip'
                  }
                >
                  fast-path {spammerReadModel.denormJobs.fastPathEnqueued}/
                  {spammerReadModel.denormJobs.fastPathReplayed}
                </span>
                <span
                  className={
                    spammerReadModel.denormJobs.fastPathReplayMissing > 0
                      ? 'chip chip--warning'
                      : 'chip'
                  }
                >
                  replay miss {spammerReadModel.denormJobs.fastPathReplayMissing}
                </span>
                <span
                  className={
                    spammerReadModel.denormJobs.fastPathFallbacks > 0
                      ? 'chip chip--warning'
                      : 'chip'
                  }
                >
                  fallback {spammerReadModel.denormJobs.fastPathFallbacks}
                </span>
              </div>
              <p className="system-panel__hint">
                {spammerReadModel.denormJobs.lastSuccessAt
                  ? `Последний denorm ${formatDateTime(spammerReadModel.denormJobs.lastSuccessAt)}`
                  : 'Denorm jobs ещё не попадали в rolling window.'}
              </p>
            </>
          ) : (
            <p className="system-panel__hint">Spammer read-model diagnostics пока недоступны.</p>
          )}
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Ключевые метрики</h2>
              <p>То, что влияет на скорость реакции бота прямо сейчас.</p>
            </div>
            <span className="system-panel__timestamp">
              {dashboard.mode.updatedAt ? `Mode ${formatTime(dashboard.mode.updatedAt)}` : ''}
            </span>
          </div>
          <div className="system-metric-grid">
            <article className="system-metric-card">
              <span>Очередь в BullMQ</span>
              <strong>{queueCount}</strong>
              <small>waiting across critical/default/background</small>
            </article>
            <article className="system-metric-card">
              <span>RECEIVED</span>
              <strong>{receivedEvents}</strong>
              <small>
                oldest {formatLag(dashboard.queues.webhookEvents.received.oldestLagSec)}
              </small>
            </article>
            <article className="system-metric-card">
              <span>QUEUED</span>
              <strong>{queuedEvents}</strong>
              <small>oldest {formatLag(dashboard.queues.webhookEvents.queued.oldestLagSec)}</small>
            </article>
            <article className="system-metric-card">
              <span>Error rate</span>
              <strong>{formatPercent(dashboard.mode.action.errorRate)}</strong>
              <small>{dashboard.mode.action.failure} failures за 60 сек</small>
            </article>
          </div>
        </GlassCard>
      </section>

      <section className="system-grid" aria-label="Reliability gates">
        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>SLO и runtime profile</h2>
              <p>Квартальный reliability gate: p95 webhook-path должен оставаться ниже цели.</p>
            </div>
            {slo ? (
              <span className={summaryChipClass(slo.status)}>{slo.status}</span>
            ) : (
              <span className="chip">SLO n/a</span>
            )}
          </div>
          <div className="system-runtime-grid">
            <article className="system-runtime-card">
              <span>Webhook p95</span>
              <strong>{formatMs(slo?.p95ProcessingMs)}</strong>
              <small>
                target{' '}
                {formatMs(slo?.targetProcessingMs ?? dashboard.runtimeProfile?.targetWebhookP95Ms)}
              </small>
            </article>
            <article className="system-runtime-card">
              <span>Under target</span>
              <strong>
                {slo?.underTargetRatio === null || !slo
                  ? 'n/a'
                  : formatPercent(slo.underTargetRatio)}
              </strong>
              <small>
                {slo
                  ? `${slo.sampledProcessedEvents} sampled / ${formatWindow(slo.windowSec)}`
                  : 'no SLO sample'}
              </small>
            </article>
            <article className="system-runtime-card">
              <span>Runtime profile</span>
              <strong>
                {dashboard.runtimeProfile?.serviceName ??
                  dashboard.runtimeProfile?.appRole ??
                  'n/a'}
              </strong>
              <small>
                {dashboard.runtimeProfile
                  ? `${dashboard.runtimeProfile.queuePriority ?? dashboard.runtimeProfile.queueProfile ?? 'role'} · queues ${dashboard.runtimeProfile.enabledQueues.length} · leases ${dashboard.runtimeProfile.dynamicLeasesMode}`
                  : 'runtime profile unavailable'}
              </small>
            </article>
          </div>
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Canary и rollback</h2>
              <p>Решение: расширять canary, держать окно или откатывать runtime-пакет.</p>
            </div>
            {dashboard.canaryState ? (
              <span className={summaryChipClass(canaryChipStatus(dashboard.canaryState.status))}>
                {dashboard.canaryState.recommendation}
              </span>
            ) : null}
          </div>
          <div className="system-runtime-grid">
            <article className="system-runtime-card">
              <span>Canary state</span>
              <strong>{dashboard.canaryState?.status ?? 'n/a'}</strong>
              <small>{dashboard.canaryState?.workerGroup ?? 'worker group n/a'}</small>
            </article>
            <article className="system-runtime-card">
              <span>Rollback</span>
              <strong>{dashboard.rollbackReadiness?.status ?? 'n/a'}</strong>
              <small>
                {dashboard.rollbackReadiness?.canRollbackRuntime
                  ? 'runtime rollback command ready'
                  : 'rollback metadata unavailable'}
              </small>
            </article>
            <article className="system-runtime-card">
              <span>Queue groups</span>
              <strong>{dashboard.queueGroupHealth?.status ?? 'n/a'}</strong>
              <small>
                {dashboard.queueGroupHealth
                  ? `${dashboard.queueGroupHealth.groups.length} groups tracked`
                  : 'group health unavailable'}
              </small>
            </article>
          </div>
          {dashboard.canaryState ? (
            <p className="system-panel__hint">{dashboard.canaryState.reason}</p>
          ) : null}
          {dashboard.rollbackReadiness?.reasons.length ? (
            <div className="system-chip-list">
              {dashboard.rollbackReadiness.reasons.slice(0, 3).map((reason) => (
                <span key={reason} className="chip chip--warning">
                  {reason}
                </span>
              ))}
            </div>
          ) : (
            <span
              className={summaryChipClass(
                rollbackChipStatus(dashboard.rollbackReadiness?.status ?? 'ready'),
              )}
            >
              rollback gate clear
            </span>
          )}
        </GlassCard>
      </section>

      <GlassCard className="system-panel" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Боты</h2>
            <p>Операционный срез по multi-bot ownership, webhook и per-bot очередям.</p>
          </div>
          <span className={webhookStatusChipClass(dashboard.webhookSubscription.status)}>
            {botFleet?.summary.total ?? dashboard.webhookSubscription.botCount} bots
          </span>
        </div>
        {botsQuery.error ? (
          <p className="system-panel__hint">
            Fleet snapshot временно недоступен; показан fallback из dashboard.
          </p>
        ) : null}
        <div className="system-bot-overview-grid">
          <article className="system-runtime-card">
            <span>Lifecycle</span>
            <strong>
              {botFleet?.summary.active ?? dashboard.ownership.bots.active}/
              {botFleet?.summary.total ?? dashboard.ownership.bots.configured} active
            </strong>
            <small>
              visible {botFleet?.summary.adminVisible ?? dashboard.ownership.bots.adminVisible} ·
              draining {botFleet?.summary.draining ?? dashboard.ownership.bots.draining} · dormant{' '}
              {botFleet?.summary.dormant ?? dashboard.ownership.bots.dormant} · disabled{' '}
              {botFleet?.summary.disabled ?? dashboard.ownership.bots.disabled}
            </small>
          </article>
          <article className="system-runtime-card">
            <span>Primary ownership</span>
            <strong>
              {botFleet
                ? botFleet.summary.primaryEntities.total
                : dashboard.ownership.entities.total.withPrimary}
            </strong>
            <small>
              {botFleet
                ? `${botFleet.summary.primaryEntities.chats} chats · ${botFleet.summary.primaryEntities.channels} channels`
                : `${formatPercent(dashboard.ownership.entities.total.coverageRatio)} coverage · ${dashboard.ownership.entities.total.withoutPrimary} without primary`}
            </small>
          </article>
          <article className="system-runtime-card">
            <span>Standby / assist</span>
            <strong>
              {botFleet
                ? `${botFleet.summary.standbyEntities.total}/${botFleet.summary.assistEntities.total}`
                : ownershipAnomalyCount}
            </strong>
            <small>
              {botFleet
                ? `${botFleet.summary.standbyEntities.chats} chat standby · ${botFleet.summary.assistEntities.channels} channel assist`
                : `recoverable ${recoverableOwnershipCount} · shared chats ${dashboard.ownership.anomalies.sharedChats}`}
            </small>
          </article>
          <article className="system-runtime-card">
            <span>Warnings</span>
            <strong>
              {botFleet
                ? botFleet.summary.problemBotCount
                : (webhookOperationalDiagnostics?.warningBotCount ?? 0)}
            </strong>
            <small>
              {botFleet
                ? `lost ${botFleet.summary.lostAccess} · stale ${botFleet.summary.staleAccess} · denied ${botFleet.summary.deniedAccess}`
                : `no memberships ${webhookOperationalDiagnostics?.noActiveMembershipBotIds.length ?? 0} · no incoming ${webhookOperationalDiagnostics?.noIncomingWebhookBotIds.length ?? 0}`}
            </small>
          </article>
        </div>
        {botRows.length > 0 ? (
          <div className="system-bot-list">
            {botRows.map((row) => (
              <article key={row.botId} className="system-bot-card">
                <div className="system-bot-card__head">
                  <div>
                    <strong>{row.label}</strong>
                    <small>
                      {row.botId} · {row.lifecycleState}
                      {row.isDefault ? ' · default' : ''}
                      {row.operationalDiagnostics
                        ? ` · memberships ${row.operationalDiagnostics.activeMemberships}`
                        : ''}
                    </small>
                  </div>
                  <span className={webhookStatusChipClass(row.webhook?.status)}>
                    {row.webhook?.status ?? 'unknown'}
                  </span>
                </div>
                <div className="system-bot-card__metrics">
                  <span>
                    primary {row.entities?.primary.total ?? 'n/a'} · standby{' '}
                    {row.entities?.standby.total ?? 'n/a'}
                  </span>
                  <span>
                    assist {row.entities?.assist.total ?? 'n/a'} · access{' '}
                    {row.accessProblemCount}
                  </span>
                  <span>
                    MAX {row.maxApiLoad ? formatPercent(row.maxApiLoad.smoothedLoad) : 'n/a'} ·{' '}
                    {row.maxApiLoad?.totalRequests ?? 0} req
                  </span>
                  <span>
                    {row.queuedWork} queued · {formatLag(row.effectiveLagSec)} lag
                  </span>
                </div>
                {row.issueCodes.length > 0 ||
                row.webhook?.lastError ||
                row.problemSamples.length > 0 ? (
                  <div className="system-chip-list system-chip-list--compact">
                    {row.issueCodes.map((issue) => (
                      <span key={`${row.botId}:${issue}`} className="chip chip--warning">
                        {formatBotIssue(issue)}
                      </span>
                    ))}
                    {row.problemSamples.slice(0, 3).map((sample) => (
                      <span
                        key={`${row.botId}:${sample.chatId}:${sample.kind}`}
                        className="chip chip--warning"
                      >
                        {formatBotProblemKind(sample.kind)} · {sample.title}
                      </span>
                    ))}
                    {row.webhook?.lastError ? (
                      <span className="chip chip--danger">{row.webhook.lastError}</span>
                    ) : null}
                  </div>
                ) : (
                  <p className="system-panel__hint">
                    Последний webhook{' '}
                    {row.operationalDiagnostics?.lastIncomingWebhookAt
                      ? formatDateTime(row.operationalDiagnostics.lastIncomingWebhookAt)
                      : 'n/a'}
                  </p>
                )}
              </article>
            ))}
          </div>
        ) : (
          <p className="system-panel__hint">
            Snapshot пока не содержит per-bot webhook rows; смотрите общий статус подписки выше.
          </p>
        )}
      </GlassCard>

      <GlassCard className="system-panel" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Сигналы и рекомендации</h2>
            <p>Приоритетные штуки, которые стоит проверить оператору.</p>
          </div>
          <span className="chip">{dashboard.alerts.length || 0} active</span>
        </div>
        {dashboard.alerts.length > 0 ? (
          <div className="system-alert-list">
            {dashboard.alerts.map((alert) => (
              <article key={alert.code} className={alertCardClass(alert.level)}>
                <div className="system-alert-card__head">
                  <span
                    className={summaryChipClass(alert.level === 'info' ? 'healthy' : alert.level)}
                  >
                    {alert.level}
                  </span>
                  <h3>{alert.title}</h3>
                </div>
                <p>{alert.detail}</p>
                <small>{alert.recommendedAction}</small>
              </article>
            ))}
          </div>
        ) : (
          <StatusState
            tone="success"
            title="Сильных сигналов нет"
            description="Очереди чистые, критичные MAX-ошибки не растут, бот отвечает в штатном режиме."
          />
        )}
      </GlassCard>

      <section className="system-grid" aria-label="Runtime diagnostics">
        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Burst и hot path</h2>
              <p>
                Короткий срез по burst episodes и стадиям, которые реально съедают tail latency.
              </p>
            </div>
            {dashboard.burst ? (
              <span className={dashboard.burst.active ? 'chip chip--danger' : 'chip'}>
                {dashboard.burst.active ? 'Burst active' : 'Burst quiet'}
              </span>
            ) : null}
          </div>
          {dashboard.burst ? (
            <div className="system-runtime-grid">
              <article className="system-runtime-card">
                <span>Peak lag</span>
                <strong>{formatLag(dashboard.burst.peakLagSec)}</strong>
                <small>
                  {dashboard.burst.startedAt
                    ? `старт ${formatDateTime(dashboard.burst.startedAt)}`
                    : 'эпизод ещё не зафиксирован'}
                </small>
              </article>
              <article className="system-runtime-card">
                <span>Affected bot</span>
                <strong>{dashboard.burst.peakBotId ?? 'n/a'}</strong>
                <small>{dashboard.burst.sampleAgeMs} мс age</small>
              </article>
              <article className="system-runtime-card">
                <span>Fail-open</span>
                <strong>{dashboard.hotPath?.failOpenCount ?? 0}</strong>
                <small>
                  окно {dashboard.hotPath ? formatWindow(dashboard.hotPath.windowSec) : 'n/a'}
                </small>
              </article>
            </div>
          ) : null}
          {hotPathStages.length > 0 ? (
            <div className="system-data-list">
              {hotPathStages.map((stage) => (
                <article key={stage.stage} className="system-data-list__item">
                  <div>
                    <strong>{stage.stage}</strong>
                    <small>
                      avg {Math.round(stage.avgElapsedMs)} мс, max {stage.maxElapsedMs} мс
                    </small>
                  </div>
                  <div className="system-data-list__meta">
                    <span>slow {stage.slowCount}</span>
                    <span>timeout {stage.timeoutCount}</span>
                    <span>skip {stage.skipCount}</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="system-panel__hint">Новых hot-path diagnostics пока нет.</p>
          )}
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Hot chats</h2>
              <p>Чаты, которые сейчас дают наибольшую плотность `message_created` и shared load.</p>
            </div>
            <span className="chip">
              {dashboard.hotChats ? formatWindow(dashboard.hotChats.windowSec) : 'n/a'}
            </span>
          </div>
          {hotChats.length > 0 ? (
            <div className="system-data-list">
              {hotChats.map((chat) => (
                <article key={chat.chatId} className="system-data-list__item">
                  <div>
                    <strong>{chat.chatId}</strong>
                    <small>last seen {formatDateTime(chat.lastSeenAt)}</small>
                  </div>
                  <div className="system-data-list__meta">
                    <span>{chat.messageCreatedCount} msgs</span>
                    <span>{chat.botsSeen} bots</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="system-panel__hint">Сейчас выраженных hot chats нет.</p>
          )}
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Background budget</h2>
              <p>
                Фоновые MAX source tags и причины, по которым governor начинает их душить раньше
                hard degrade.
              </p>
            </div>
            {dashboard.backgroundBudget ? (
              <span className="chip">
                bg share {formatPercent(dashboard.backgroundBudget.backgroundShare)}
              </span>
            ) : null}
          </div>
          {dashboard.backgroundBudget ? (
            <div className="system-runtime-grid">
              <article className="system-runtime-card">
                <span>Stack load</span>
                <strong>{stackLoad ? formatPercent(stackLoad.smoothedLoad) : 'n/a'}</strong>
                <small>
                  peak {stackLoad ? formatPercent(stackLoad.peakLoad) : 'n/a'} / slow{' '}
                  {stackLoad ? formatPercent(stackLoad.slowThreshold) : 'n/a'}
                </small>
              </article>
              <article className="system-runtime-card">
                <span>Top bot</span>
                <strong>{topBotLoad ? formatPercent(topBotLoad.smoothedLoad) : 'n/a'}</strong>
                <small>{topBotLoad?.botId ?? 'no bot pressure'}</small>
              </article>
              <article className="system-runtime-card">
                <span>Stack window</span>
                <strong>{stackLoad ? formatWindow(stackLoad.windowSec) : 'n/a'}</strong>
                <small>limiter sample</small>
              </article>
            </div>
          ) : null}
          {backgroundSources.length > 0 ? (
            <div className="system-data-list">
              {backgroundSources.map((source) => (
                <article key={source.sourceTag} className="system-data-list__item">
                  <div>
                    <strong>{source.sourceTag}</strong>
                    <small>
                      avg {source.avgRps.toFixed(2)} rps, peak {source.peakRps} rps
                    </small>
                  </div>
                  <div className="system-data-list__meta">
                    <span>{source.totalRequests} req</span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="system-panel__hint">
              Нет выраженного background source-share за текущее окно.
            </p>
          )}
          {backgroundPauses.length > 0 ? (
            <div className="system-chip-list">
              {backgroundPauses.map((item) => (
                <span key={`${item.component}-${item.sourceTag}-${item.reason}`} className="chip">
                  {item.component}: {item.action} x{item.count}
                </span>
              ))}
            </div>
          ) : null}
        </GlassCard>

        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Membership lookup</h2>
              <p>Сводка по hot channels, backoff и transient/terminal проблемам membership path.</p>
            </div>
            {dashboard.membershipLookup ? (
              <span className="chip">
                {dashboard.membershipLookup.hotChannels} hot /{' '}
                {dashboard.membershipLookup.backoffActiveChats} backoff
              </span>
            ) : null}
          </div>
          {dashboard.membershipLookup ? (
            <div className="system-runtime-grid">
              <article className="system-runtime-card">
                <span>Transient</span>
                <strong>{dashboard.membershipLookup.transientIssues}</strong>
                <small>issues in window</small>
              </article>
              <article className="system-runtime-card">
                <span>Terminal</span>
                <strong>{dashboard.membershipLookup.terminalIssues}</strong>
                <small>issues in window</small>
              </article>
              <article className="system-runtime-card">
                <span>Window</span>
                <strong>{formatWindow(dashboard.membershipLookup.windowSec)}</strong>
                <small>rolling Redis-backed snapshot</small>
              </article>
            </div>
          ) : null}
          {membershipIssues.length > 0 ? (
            <div className="system-data-list">
              {membershipIssues.map((item) => (
                <article
                  key={`${item.kind}-${item.chatId}-${item.policyName}`}
                  className="system-data-list__item"
                >
                  <div>
                    <strong>
                      {item.policyName} / {item.chatId}
                    </strong>
                    <small>{formatDateTime(item.lastObservedAt)}</small>
                  </div>
                  <div className="system-data-list__meta">
                    <span>{item.kind}</span>
                    <span>
                      {item.retryAfterMs === null ? 'retry n/a' : `${item.retryAfterMs} мс`}
                    </span>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="system-panel__hint">Активных membership issues сейчас не видно.</p>
          )}
        </GlassCard>
      </section>

      <GlassCard className="system-panel" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Очереди по слоям</h2>
            <p>Помогает быстро понять, где именно копится нагрузка.</p>
          </div>
          <span className="chip">{summaryChipLabel(dashboard.summary.status)}</span>
        </div>
        <div className="system-queue-grid">
          {queueLayers.map(({ label, queue }) => (
            <article key={label} className="system-queue-card">
              <div className="system-queue-card__head">
                <h3>{label}</h3>
                <span>{queue.waiting} waiting</span>
              </div>
              <dl className="system-queue-card__stats">
                <div>
                  <dt>active</dt>
                  <dd>{queue.active}</dd>
                </div>
                <div>
                  <dt>delayed</dt>
                  <dd>{queue.delayed}</dd>
                </div>
                <div>
                  <dt>failed</dt>
                  <dd>{queue.failed}</dd>
                </div>
                <div>
                  <dt>completed</dt>
                  <dd>{queue.completed}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </GlassCard>

      {auxiliaryQueueLayers.length > 0 ? (
        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Вспомогательные очереди</h2>
              <p>Фоновые refresh, VK, night mode и roster sync задачи.</p>
            </div>
            <span className="chip">{auxiliaryQueueLayers.length} queues</span>
          </div>
          <div className="system-queue-grid">
            {auxiliaryQueueLayers.map(({ name, label, queue }) => (
              <article key={name} className="system-queue-card">
                <div className="system-queue-card__head">
                  <h3>{label}</h3>
                  <span>{queue.waiting} waiting</span>
                </div>
                <dl className="system-queue-card__stats">
                  <div>
                    <dt>active</dt>
                    <dd>{queue.active}</dd>
                  </div>
                  <div>
                    <dt>delayed</dt>
                    <dd>{queue.delayed}</dd>
                  </div>
                  <div>
                    <dt>failed</dt>
                    <dd>{queue.failed}</dd>
                  </div>
                  <div>
                    <dt>done</dt>
                    <dd>{queue.completed}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        </GlassCard>
      ) : null}

      {queueGroups.length > 0 ? (
        <GlassCard className="system-panel" elevated>
          <div className="system-panel__head">
            <div>
              <h2>Queue group health</h2>
              <p>Worker-group разрез для canary и default-shard leases.</p>
            </div>
            <span className={summaryChipClass(dashboard.queueGroupHealth?.status ?? 'healthy')}>
              {dashboard.queueGroupHealth?.status ?? 'healthy'}
            </span>
          </div>
          <div className="system-data-list">
            {queueGroups.map((group) => (
              <article key={group.name} className="system-data-list__item">
                <div>
                  <strong>{group.name}</strong>
                  <small>{group.queues.join(', ') || 'no queues assigned'}</small>
                </div>
                <div className="system-data-list__meta">
                  <span className={summaryChipClass(group.status)}>{group.status}</span>
                  <span>
                    wait {group.waiting}, active {group.active}, failed {group.failed}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </GlassCard>
      ) : null}

      <GlassCard className="system-panel system-panel--compact" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Путь webhook событий</h2>
            <p>Быстрый разрез по жизненному циклу входящих событий.</p>
          </div>
        </div>
        <div className="system-lifecycle-grid">
          <article className="system-lifecycle-card">
            <span>RECEIVED</span>
            <strong>{receivedEvents}</strong>
            <small>{formatLag(dashboard.queues.oldestReceivedLagSec)} oldest</small>
          </article>
          <article className="system-lifecycle-card">
            <span>QUEUED</span>
            <strong>{queuedEvents}</strong>
            <small>{formatLag(dashboard.queues.oldestQueuedLagSec)} oldest</small>
          </article>
          <article className="system-lifecycle-card">
            <span>FAILED</span>
            <strong>{failedEvents}</strong>
            <small>
              action critical {formatPercent(dashboard.queues.actionHealth.criticalRate)}
            </small>
          </article>
        </div>
      </GlassCard>

      {modeMutation.isPending ? (
        <GlassCard>
          <StatusState
            tone={summaryTone(dashboard.summary.status)}
            title="Обновляю режим"
            description="Секунду, сохраняю override и синхронизирую свежую сводку."
          />
        </GlassCard>
      ) : null}
    </div>
  );
}
