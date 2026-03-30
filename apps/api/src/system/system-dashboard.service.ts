import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemDashboardStatus,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts';
import { QueueMetricsService } from './queue-metrics.service';
import { SystemModeService } from './system-mode.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';

const QUEUE_LAG_WARNING_SEC = 5;
const FAILED_EVENTS_CRITICAL_COUNT = 100;
const ACTION_RATE_WARNING_THRESHOLD = 0.02;
const ACTION_RATE_CRITICAL_THRESHOLD = 0.05;
const ACTION_ERROR_MIN_TOTAL = 100;
const DEFAULT_WORKER_SKEW_WARNING_PRESSURE = 4;
const DEFAULT_WORKER_SKEW_WARNING_RATIO = 0.7;
const DEFAULT_WORKER_SKEW_CRITICAL_PRESSURE = 8;
const DEFAULT_WORKER_SKEW_CRITICAL_RATIO = 0.85;

@Injectable()
export class SystemDashboardService {
  private readonly queueLagCriticalThresholdSec: number;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
    @Optional()
    private readonly webhookSubscriptionStatusService?: WebhookSubscriptionStatusService,
  ) {
    this.queueLagCriticalThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
  }

  async getSnapshot(): Promise<SystemDashboardResponse> {
    const webhookSubscriptionPromise = this.webhookSubscriptionStatusService
      ? this.webhookSubscriptionStatusService.getSnapshot()
      : Promise.resolve(this.buildFallbackWebhookSubscriptionSnapshot());
    const [queues, mode, webhookSubscription] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
      webhookSubscriptionPromise,
    ]);
    const alerts: SystemDashboardAlert[] = [];
    const queueLagSec = queues.effectiveLagSec;
    const failedCount = queues.webhookEvents.failed.count;
    const criticalRate = mode.action.criticalRate;
    const errorRate = mode.action.errorRate;
    const stabilizing = this.isStabilizing(mode, queueLagSec);

    if (mode.source === 'manual') {
      alerts.push({
        code: 'manual-mode',
        level: 'info',
        title: 'Включён ручной режим',
        detail:
          mode.manualMode === 'degrade'
            ? 'Система удерживается в degrade вручную, даже если очереди уже выровнялись.'
            : 'Система зафиксирована в normal вручную. Автоматическое переключение временно отключено.',
        recommendedAction: 'Проверьте инцидент и верните режим в auto после стабилизации.',
      });
    }

    if (queueLagSec > QUEUE_LAG_WARNING_SEC) {
      const critical = queueLagSec > this.queueLagCriticalThresholdSec;
      alerts.push({
        code: 'queue-lag',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'Очередь начала отставать' : 'Есть задержка в очереди',
        detail: `Старейшее событие ждёт обработки ${queueLagSec.toFixed(1)} сек.`,
        recommendedAction:
          'Проверьте backlog webhook events и rate limit MAX API. Если lag растёт, снижайте background-нагрузку.',
      });
    }

    if (failedCount > 0) {
      const critical = failedCount >= FAILED_EVENTS_CRITICAL_COUNT;
      alerts.push({
        code: 'failed-webhooks',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'Есть заметный хвост failed webhook' : 'Появились failed webhook',
        detail: `В статусе FAILED сейчас ${failedCount} событий.`,
        recommendedAction:
          'Посмотрите последние ошибки доставки/обработки и очистите только подтверждённо мёртвые записи.',
      });
    }

    if (criticalRate > ACTION_RATE_WARNING_THRESHOLD) {
      const critical = criticalRate >= ACTION_RATE_CRITICAL_THRESHOLD;
      alerts.push({
        code: 'critical-rate',
        level: critical ? 'critical' : 'warning',
        title: critical ? 'MAX critical rate выше нормы' : 'MAX critical rate растёт',
        detail: `Критичные ошибки MAX API за окно: ${(criticalRate * 100).toFixed(2)}%.`,
        recommendedAction:
          'Защитите critical-трафик: режьте interactive/background запросы и проверяйте route split.',
      });
    }

    if (mode.action.total >= ACTION_ERROR_MIN_TOTAL && errorRate > ACTION_RATE_WARNING_THRESHOLD) {
      alerts.push({
        code: 'action-error-rate',
        level: 'warning',
        title: 'Растёт доля ошибок action-path',
        detail: `Общий error rate за окно: ${(errorRate * 100).toFixed(2)}%.`,
        recommendedAction:
          'Проверьте timeout и retries на MAX API, затем сопоставьте со всплесками UI или moderation-трафика.',
      });
    }

    if (stabilizing) {
      alerts.push({
        code: 'stabilizing',
        level: 'info',
        title: 'Система в окне стабилизации',
        detail:
          'Основные метрики уже выровнялись, но auto-mode ещё держит degrade до завершения защитного окна.',
        recommendedAction:
          'Наблюдайте за lag и critical rate. Если они остаются низкими, система вернётся в normal автоматически.',
      });
    }

    const webhookSubscriptionAlert = this.buildWebhookSubscriptionAlert(webhookSubscription);
    if (webhookSubscriptionAlert) {
      alerts.push(webhookSubscriptionAlert);
    }

    const defaultWorkerSkewAlert = this.buildDefaultWorkerSkewAlert(
      (
        queues as {
          webhookDefaultWorkerGroups?: Awaited<
            ReturnType<QueueMetricsService['getSnapshot']>
          >['webhookDefaultWorkerGroups'];
        }
      ).webhookDefaultWorkerGroups,
    );
    if (defaultWorkerSkewAlert) {
      alerts.push(defaultWorkerSkewAlert);
    }

    const dynamicLeaseAlert = this.buildDynamicLeaseAlert(
      (
        queues as {
          webhookDynamicLeases?: Awaited<
            ReturnType<QueueMetricsService['getSnapshot']>
          >['webhookDynamicLeases'];
        }
      ).webhookDynamicLeases,
    );
    if (dynamicLeaseAlert) {
      alerts.push(dynamicLeaseAlert);
    }

    const status = this.resolveStatus({
      mode: mode.mode,
      queueLagSec,
      failedCount,
      criticalRate,
      errorRate,
      webhookSubscriptionStatus: webhookSubscription.status,
    });

    return {
      summary: {
        status,
        title: this.buildSummaryTitle(status, stabilizing),
        detail: this.buildSummaryDetail(status, mode.reason, queueLagSec, failedCount, stabilizing),
        generatedAt: new Date().toISOString(),
        stabilizing,
      },
      alerts,
      queues,
      mode,
      webhookSubscription,
    };
  }

  private resolveStatus(input: {
    mode: 'normal' | 'degrade';
    queueLagSec: number;
    failedCount: number;
    criticalRate: number;
    errorRate: number;
    webhookSubscriptionStatus: WebhookSubscriptionSnapshot['status'];
  }): SystemDashboardStatus {
    if (
      input.mode === 'degrade' ||
      input.queueLagSec > this.queueLagCriticalThresholdSec ||
      input.failedCount >= FAILED_EVENTS_CRITICAL_COUNT ||
      input.criticalRate >= ACTION_RATE_CRITICAL_THRESHOLD ||
      input.webhookSubscriptionStatus === 'critical'
    ) {
      return 'critical';
    }

    if (
      input.queueLagSec > QUEUE_LAG_WARNING_SEC ||
      input.failedCount > 0 ||
      input.criticalRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.errorRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.webhookSubscriptionStatus === 'warning'
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private buildSummaryTitle(status: SystemDashboardStatus, stabilizing: boolean): string {
    if (status === 'critical') {
      return stabilizing ? 'Система стабилизируется после инцидента' : 'Нужна реакция оператора';
    }

    if (status === 'warning') {
      return 'Система под нагрузкой, но управляемая';
    }

    return 'Бот работает ровно';
  }

  private buildSummaryDetail(
    status: SystemDashboardStatus,
    reason: string,
    queueLagSec: number,
    failedCount: number,
    stabilizing: boolean,
  ): string {
    if (status === 'healthy') {
      return 'Webhook-path чистый, backlog не копится, critical MAX budget не съедается UI-нагрузкой.';
    }

    if (stabilizing) {
      return `Auto-mode ещё держит защитный degrade (${reason}), но backlog уже не растёт. Lag ${queueLagSec.toFixed(1)} сек, failed ${failedCount}.`;
    }

    return `Причина текущего режима: ${reason}. Lag ${queueLagSec.toFixed(1)} сек, failed ${failedCount}.`;
  }

  private isStabilizing(
    mode: Awaited<ReturnType<SystemModeService['getEffectiveSnapshot']>>,
    queueLagSec: number,
  ): boolean {
    return (
      mode.mode === 'degrade' &&
      mode.source === 'auto' &&
      queueLagSec <= QUEUE_LAG_WARNING_SEC &&
      mode.action.errorRate <= ACTION_RATE_WARNING_THRESHOLD &&
      mode.action.criticalRate <= ACTION_RATE_WARNING_THRESHOLD
    );
  }

  private buildWebhookSubscriptionAlert(
    snapshot: WebhookSubscriptionSnapshot,
  ): SystemDashboardAlert | null {
    if (snapshot.status === 'healthy') {
      return null;
    }

    if (snapshot.status === 'disabled') {
      return {
        code: 'webhook-subscription-disabled',
        level: 'info',
        title: 'Webhook reconcile отключён',
        detail: snapshot.note ?? 'Фоновая проверка webhook subscription сейчас не активна.',
        recommendedAction:
          'Для production это не норма. Проверьте app role и конфигурацию webhook URL/secret.',
      };
    }

    if (snapshot.status === 'critical') {
      const detail = !snapshot.configured
        ? 'Webhook URL не сконфигурирован, бот не сможет держать подписку в актуальном состоянии.'
        : snapshot.missingUpdateTypes.length > 0
          ? `У текущей subscription не хватает update types: ${snapshot.missingUpdateTypes.join(', ')}.`
          : 'Текущая webhook subscription для сконфигурированного URL не найдена.';
      return {
        code: 'webhook-subscription-critical',
        level: 'critical',
        title: 'Webhook coverage требует вмешательства',
        detail,
        recommendedAction:
          'Проверьте reconcile и текущие subscriptions. Не выполняйте ручную чистку чужих URL без подтверждения.',
      };
    }

    const warningDetails: string[] = [];
    if (snapshot.extraUpdateTypes.length > 0) {
      warningDetails.push(`лишние update types: ${snapshot.extraUpdateTypes.join(', ')}`);
    }
    if (snapshot.otherSubscriptionsCount > 0) {
      warningDetails.push(`дополнительных subscriptions: ${snapshot.otherSubscriptionsCount}`);
    }
    if (snapshot.lastError) {
      warningDetails.push(`последняя ошибка: ${snapshot.lastError}`);
    }

    return {
      code: 'webhook-subscription-warning',
      level: 'warning',
      title: 'Webhook subscription под наблюдением',
      detail:
        warningDetails.length > 0
          ? `Есть drift или ошибка reconcile: ${warningDetails.join('; ')}.`
          : (snapshot.note ?? 'Состояние webhook subscription требует внимания.'),
      recommendedAction:
        'Следите за drift и reconcile errors. MAX UI не должен делать прямой live-check в фоне на каждый refresh.',
    };
  }

  private buildFallbackWebhookSubscriptionSnapshot(): WebhookSubscriptionSnapshot {
    return {
      status: 'warning',
      configured: false,
      url: null,
      checkedAt: null,
      reconciledAt: null,
      requiredUpdateTypes: [],
      actualUpdateTypes: [],
      missingUpdateTypes: [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note: 'Webhook subscription snapshot пока недоступен.',
      botCount: 0,
      bots: {},
    };
  }

  private buildDefaultWorkerSkewAlert(
    workerGroups?: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookDefaultWorkerGroups'],
  ): SystemDashboardAlert | null {
    if (!workerGroups) {
      return null;
    }

    const groupLoads = Object.entries(workerGroups)
      .map(([groupName, metrics]) => ({
        groupName,
        queues: metrics.queues,
        pressure: metrics.counters.waiting + metrics.counters.active,
      }))
      .filter((entry) => entry.pressure > 0)
      .sort((left, right) => right.pressure - left.pressure);

    const primary = groupLoads[0];
    if (!primary) {
      return null;
    }

    const totalPressure = groupLoads.reduce((sum, entry) => sum + entry.pressure, 0);
    if (totalPressure < DEFAULT_WORKER_SKEW_WARNING_PRESSURE) {
      return null;
    }

    const share = primary.pressure / totalPressure;
    if (share < DEFAULT_WORKER_SKEW_WARNING_RATIO) {
      return null;
    }

    const critical =
      primary.pressure >= DEFAULT_WORKER_SKEW_CRITICAL_PRESSURE &&
      share >= DEFAULT_WORKER_SKEW_CRITICAL_RATIO;

    return {
      code: 'default-worker-skew',
      level: critical ? 'critical' : 'warning',
      title: critical
        ? 'Один realtime worker забирает почти весь default burst'
        : 'Нагрузка default shard’ов перекошена по worker groups',
      detail: `${primary.groupName} сейчас держит ${primary.pressure} из ${totalPressure} active+waiting по default webhook (${primary.queues.join(', ')}).`,
      recommendedAction:
        'Если перекос держится дольше пары минут, проверьте hot chats и текущую shard ownership map перед ростом concurrency.',
    };
  }

  private buildDynamicLeaseAlert(
    leaseSnapshot?: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookDynamicLeases'],
  ): SystemDashboardAlert | null {
    if (!leaseSnapshot) {
      return null;
    }

    const queueEntries = Object.values(leaseSnapshot.queues);
    const recommendedMoves = queueEntries.filter(
      (entry) => entry.eligibleForDynamicLeases && entry.actualOwner !== entry.desiredOwner,
    ).length;
    const pendingHandoffs = queueEntries.filter((entry) => entry.handoffPending).length;
    const totalExpectedWorkerGroups = 4;
    const degradedWorkerPool =
      leaseSnapshot.liveWorkerGroups.length > 0 &&
      leaseSnapshot.liveWorkerGroups.length < totalExpectedWorkerGroups;

    if (leaseSnapshot.mode === 'shadow' && recommendedMoves > 0) {
      return {
        code: 'dynamic-lease-shadow',
        level: 'info',
        title: 'Dynamic leases работают в shadow-режиме',
        detail: `Планировщик уже рекомендовал ${recommendedMoves} перенос(а/ов) default shard’ов, но handoff ещё не включён.`,
        recommendedAction:
          'Проверьте suggested ownership и latency перед переходом к canary для небольшой группы shard’ов.',
      };
    }

    if ((leaseSnapshot.mode === 'canary' || leaseSnapshot.mode === 'on') && pendingHandoffs > 0) {
      return {
        code: 'dynamic-lease-handoff',
        level: 'info',
        title: 'Dynamic leases выполняют handoff shard’ов',
        detail: `Сейчас в handoff pending находится ${pendingHandoffs} shard’ов.`,
        recommendedAction:
          'Следите, чтобы handoff быстро сходился и не приводил к росту queue lag или duplicate processing.',
      };
    }

    if (degradedWorkerPool) {
      return {
        code: 'dynamic-lease-worker-pool',
        level: 'warning',
        title: 'Часть realtime worker group не видна в lease heartbeat',
        detail: `Lease runtime видит только ${leaseSnapshot.liveWorkerGroups.length} worker group(s).`,
        recommendedAction:
          'Проверьте health default moderation containers перед расширением canary или полным включением leases.',
      };
    }

    return null;
  }
}
