import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import { getSystemDashboard, setSystemMode } from '../lib/api/system-client';
import type { ApiTransport } from '../lib/api/transport';
import '../styles/system-page.css';

type SystemModeSelection = 'auto' | 'normal' | 'degrade';

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

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCoverage(value: number): string {
  return `${Math.round(value * 100)}%`;
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

function webhookChipClass(status: 'healthy' | 'warning' | 'critical' | 'disabled') {
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

function webhookChipLabel(status: 'healthy' | 'warning' | 'critical' | 'disabled') {
  if (status === 'critical') {
    return 'Coverage broken';
  }

  if (status === 'warning') {
    return 'Coverage drift';
  }

  if (status === 'healthy') {
    return 'Coverage OK';
  }

  return 'Disabled';
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

export function SystemPage({ api }: { api: ApiTransport }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const dashboardQuery = useQuery({
    queryKey: ['system-dashboard'],
    queryFn: () => getSystemDashboard(api),
    staleTime: 5_000,
    refetchInterval: 5_000,
    retry: 1,
  });
  const modeMutation = useMutation({
    mutationFn: (mode: SystemModeSelection) => setSystemMode(api, mode),
    onSuccess: async (_, mode) => {
      await queryClient.invalidateQueries({ queryKey: ['system-dashboard'] });
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
    { label: 'Moderation total', queue: dashboard.queues.moderation },
  ];
  const webhookSubscription = dashboard.webhookSubscription;
  const ownership = dashboard.ownership;
  const recoverableOwnership =
    ownership.anomalies.recoverableLegacyOnly + ownership.anomalies.recoverableFromMemberships;
  const ownershipAnomalyChips = [
    ownership.anomalies.noPrimary > 0
      ? `без primary: ${ownership.anomalies.noPrimary}`
      : null,
    recoverableOwnership > 0 ? `recoverable: ${recoverableOwnership}` : null,
    ownership.anomalies.unbound > 0 ? `unbound: ${ownership.anomalies.unbound}` : null,
    ownership.anomalies.primaryBotUnknown > 0
      ? `unknown primary: ${ownership.anomalies.primaryBotUnknown}`
      : null,
    ownership.anomalies.legacyBotUnknown > 0
      ? `unknown legacy: ${ownership.anomalies.legacyBotUnknown}`
      : null,
    ownership.anomalies.activeMembershipBotUnknown > 0
      ? `unknown membership: ${ownership.anomalies.activeMembershipBotUnknown}`
      : null,
    ownership.anomalies.primaryWithoutActiveMembership > 0
      ? `primary без ACTIVE membership: ${ownership.anomalies.primaryWithoutActiveMembership}`
      : null,
    ownership.anomalies.sharedChats > 0 ? `shared chats: ${ownership.anomalies.sharedChats}` : null,
  ].filter((value): value is string => Boolean(value));

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
            onClick={() => dashboardQuery.refetch()}
            disabled={dashboardQuery.isFetching}
          >
            {dashboardQuery.isFetching ? 'Обновляем…' : 'Обновить'}
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

      <GlassCard className="system-panel" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Ownership foundation</h2>
            <p>Насколько данные уже готовы к безопасному dual-bot rollout.</p>
          </div>
          <span className="chip">
            coverage {formatCoverage(ownership.entities.total.coverageRatio)}
          </span>
        </div>
        <div className="system-ownership-grid">
          <article className="system-ownership-card">
            <span>Все сущности</span>
            <strong>
              {ownership.entities.total.withPrimary}/{ownership.entities.total.total}
            </strong>
            <small>valid primaryBotId coverage</small>
          </article>
          <article className="system-ownership-card">
            <span>Unbound</span>
            <strong>{ownership.anomalies.unbound}</strong>
            <small>без recoverable bot binding</small>
          </article>
          <article className="system-ownership-card">
            <span>Recoverable now</span>
            <strong>{recoverableOwnership}</strong>
            <small>legacy pointer or active memberships</small>
          </article>
          <article className="system-ownership-card">
            <span>Configured bots</span>
            <strong>{ownership.bots.configured}</strong>
            <small>
              active {ownership.bots.active}, dormant {ownership.bots.dormant}
            </small>
          </article>
        </div>
        <div className="system-ownership-breakdown">
          <article className="system-ownership-breakdown__card">
            <span>Чаты</span>
            <strong>
              {ownership.entities.chats.withPrimary}/{ownership.entities.chats.total}
            </strong>
            <small>{formatCoverage(ownership.entities.chats.coverageRatio)} coverage</small>
          </article>
          <article className="system-ownership-breakdown__card">
            <span>Каналы</span>
            <strong>
              {ownership.entities.channels.withPrimary}/{ownership.entities.channels.total}
            </strong>
            <small>{formatCoverage(ownership.entities.channels.coverageRatio)} coverage</small>
          </article>
          <article className="system-ownership-breakdown__card">
            <span>Repair</span>
            <strong>
              {ownership.repair.lastSuccessAt ? formatTime(ownership.repair.lastSuccessAt) : '—'}
            </strong>
            <small>
              {ownership.repair.activeOnThisRole
                ? `${ownership.repair.lastAppliedChanges} changes on last run`
                : 'snapshot mirrored from active admin role'}
            </small>
          </article>
        </div>
        <div className="system-chip-list">
          {ownershipAnomalyChips.length > 0 ? (
            ownershipAnomalyChips.map((chip) => (
              <span key={chip} className="chip chip--warning">
                {chip}
              </span>
            ))
          ) : (
            <span className="chip chip--success">ownership anomalies not detected</span>
          )}
        </div>
        {ownership.repair.lastError ? (
          <p className="system-subscription-error">
            Последняя ошибка ownership repair: {ownership.repair.lastError}
          </p>
        ) : (
          <p className="system-panel__hint">
            {ownership.repair.enabled
              ? ownership.repair.activeOnThisRole
                ? 'DB-first repair работает без MAX discovery: чинит только recoverable ownership gaps и не назначает бота по догадке.'
                : 'Этот экран читает ownership snapshot из общего Redis cache; сам repair выполняется только на admin/all role.'
              : 'Ownership repair отключён конфигом.'}
          </p>
        )}
      </GlassCard>

      <GlassCard className="system-panel" elevated>
        <div className="system-panel__head">
          <div>
            <h2>Webhook coverage</h2>
            <p>Серверный snapshot подписки без прямых live-check в MAX на каждый refresh.</p>
          </div>
          <span className={webhookChipClass(webhookSubscription.status)}>
            {webhookChipLabel(webhookSubscription.status)}
          </span>
        </div>
        <div className="system-subscription-grid">
          <article className="system-subscription-card">
            <span>Configured URL</span>
            <strong>{webhookSubscription.url ?? 'Не настроен'}</strong>
            <small>
              {webhookSubscription.checkedAt
                ? `Проверено ${formatTime(webhookSubscription.checkedAt)}`
                : 'Ожидаю первую проверку'}
            </small>
          </article>
          <article className="system-subscription-card">
            <span>Missing update types</span>
            <strong>{webhookSubscription.missingUpdateTypes.length}</strong>
            <small>
              {webhookSubscription.reconciledAt
                ? `Reconciled ${formatTime(webhookSubscription.reconciledAt)}`
                : 'Авто-reconcile ещё не выполнялся'}
            </small>
          </article>
          <article className="system-subscription-card">
            <span>Other subscriptions</span>
            <strong>{webhookSubscription.otherSubscriptionsCount}</strong>
            <small>
              {webhookSubscription.extraUpdateTypes.length > 0
                ? `${webhookSubscription.extraUpdateTypes.length} extra update types`
                : 'Лишних update types нет'}
            </small>
          </article>
        </div>
        <div className="system-subscription-meta">
          <div>
            <small>Required</small>
            <div className="system-chip-list">
              {webhookSubscription.requiredUpdateTypes.map((type) => (
                <span key={`required-${type}`} className="chip">
                  {type}
                </span>
              ))}
            </div>
          </div>
          <div>
            <small>Active</small>
            <div className="system-chip-list">
              {webhookSubscription.actualUpdateTypes.length > 0 ? (
                webhookSubscription.actualUpdateTypes.map((type) => (
                  <span key={`actual-${type}`} className="chip chip--success">
                    {type}
                  </span>
                ))
              ) : (
                <span className="chip">Нет данных</span>
              )}
            </div>
          </div>
          {webhookSubscription.missingUpdateTypes.length > 0 ? (
            <div>
              <small>Missing</small>
              <div className="system-chip-list">
                {webhookSubscription.missingUpdateTypes.map((type) => (
                  <span key={`missing-${type}`} className="chip chip--danger">
                    {type}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {webhookSubscription.extraUpdateTypes.length > 0 ? (
            <div>
              <small>Extra</small>
              <div className="system-chip-list">
                {webhookSubscription.extraUpdateTypes.map((type) => (
                  <span key={`extra-${type}`} className="chip chip--warning">
                    {type}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        {webhookSubscription.note ? (
          <p className="system-panel__hint">{webhookSubscription.note}</p>
        ) : null}
        {webhookSubscription.lastError ? (
          <p className="system-subscription-error">
            Последняя ошибка: {webhookSubscription.lastError}
          </p>
        ) : null}
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
