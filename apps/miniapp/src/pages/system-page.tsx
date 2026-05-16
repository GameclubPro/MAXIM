import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import { describeApiError } from '../lib/api-error';
import { getSystemDashboard, setSystemMode } from '../lib/api/system-client';
import type { ApiTransport } from '../lib/api/transport';
import { queryKeys } from '../lib/query-keys';
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
  const modeMutation = useMutation({
    mutationFn: (mode: SystemModeSelection) => setSystemMode(api, mode),
    onSuccess: async (_, mode) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.systemDashboard });
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
  const hotPathStages = dashboard.hotPath?.stages.slice(0, 6) ?? [];
  const hotChats = dashboard.hotChats?.items.slice(0, 6) ?? [];
  const backgroundSources = dashboard.backgroundBudget?.topSources.slice(0, 5) ?? [];
  const backgroundPauses = dashboard.backgroundBudget?.pauseReasons.slice(0, 5) ?? [];
  const membershipIssues = dashboard.membershipLookup?.issueSample.slice(0, 5) ?? [];
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
