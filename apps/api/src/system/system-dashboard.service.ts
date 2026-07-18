import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  BotOwnershipFoundationSnapshot,
  SystemDashboardAlert,
  SystemDashboardResponse,
  SystemDashboardStatus,
  WebhookSubscriptionSnapshot,
} from '@maxim/contracts/system';
import { MaxBotOwnershipFoundationService } from '../max/max-bot-ownership-foundation.service';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
} from '../max/max-action.queue';
import {
  DEFAULT_WEBHOOK_P95_TARGET_MS,
  buildSystemCanaryState,
  buildSystemQueueGroupHealth,
  buildSystemRollbackReadiness,
  buildSystemRuntimeProfile,
} from '../runtime/runtime-reliability-profile';
import { BackgroundRuntimeGovernorService } from './background-runtime-governor.service';
import { QueueMetricsService } from './queue-metrics.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { SystemModeService } from './system-mode.service';
import { WebhookSloService, type WebhookSloSnapshot } from './webhook-slo.service';
import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';
import { PrismaService } from '../prisma/prisma.service';

const QUEUE_LAG_WARNING_SEC = 5;
const FAILED_EVENTS_CRITICAL_COUNT = 100;
const ACTION_RATE_WARNING_THRESHOLD = 0.02;
const ACTION_RATE_CRITICAL_THRESHOLD = 0.05;
const ACTION_ERROR_MIN_TOTAL = 100;
const DEFAULT_WORKER_SKEW_WARNING_PRESSURE = 4;
const DEFAULT_WORKER_SKEW_WARNING_RATIO = 0.7;
const DEFAULT_WORKER_SKEW_CRITICAL_PRESSURE = 8;
const DEFAULT_WORKER_SKEW_CRITICAL_RATIO = 0.85;
const JOIN_BURST_WARNING_PRESSURE = 6;
const JOIN_BURST_CRITICAL_PRESSURE = 16;
const VK_PARSING_HEALTH_WINDOW_MIN = 30;
const VK_PARSING_SOURCE_FAILURE_WARNING_COUNT = 3;
const VK_PARSING_MEDIA_FAILURE_WARNING_RATIO = 0.2;
const VK_PARSING_PUBLISH_BACKLOG_WARNING_SEC = 10 * 60;
const DELIVERY_LEDGER_STALE_ACTION_MS = 15 * 60_000;
const DELIVERY_LEDGER_STALE_BROADCAST_SENDING_MS = 5 * 60_000;
const DELIVERY_LEDGER_STALE_SUGGESTION_SENDING_MS = 2 * 60_000;
const HOT_PATH_SLOW_WARNING_COUNT = 3;
const HOT_PATH_SLOW_WARNING_MAX_MS = 5_000;

type VkParsingGuardSnapshot = {
  checkedAt: string;
  windowMin: number;
  activeSources: number;
  sourceFailureCount: number;
  circuitOpenSources: number;
  recentMediaChecks: number;
  recentMediaFailures: number;
  recentMediaFailureRatio: number;
  publishBacklog: number;
  oldestPublishBacklogAgeSec: number;
};

type DeliveryLedgerRiskSnapshot = {
  checkedAt: string;
  actionAmbiguous: number;
  actionStaleInProgress: number;
  actionStaleRetryable: number;
  actionOldestRiskAgeSec: number;
  broadcastAmbiguous: number;
  broadcastStaleSending: number;
  broadcastRiskBroadcasts: number;
  broadcastOldestRiskAgeSec: number;
  suggestionAmbiguous: number;
  suggestionTerminalFailed: number;
  suggestionStaleSending: number;
  suggestionRiskSuggestions: number;
  suggestionOldestRiskAgeSec: number;
};

@Injectable()
export class SystemDashboardService {
  private readonly queueLagCriticalThresholdSec: number;
  private readonly webhookSloTargetMs: number;
  private readonly actionCriticalBacklogThreshold: number;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    configService: ConfigService,
    @Optional()
    private readonly webhookSubscriptionStatusService?: WebhookSubscriptionStatusService,
    @Optional()
    private readonly ownershipFoundationService?: MaxBotOwnershipFoundationService,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly webhookSloService?: WebhookSloService,
    @Optional()
    private readonly prisma?: PrismaService,
  ) {
    this.queueLagCriticalThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
    this.webhookSloTargetMs = configService.get<number>(
      'SYSTEM_WEBHOOK_SLO_TARGET_MS',
      DEFAULT_WEBHOOK_P95_TARGET_MS,
    );
    this.actionCriticalBacklogThreshold =
      Math.max(1, configService.get<number>('MAX_ACTION_CRITICAL_CONCURRENCY', 3)) * 2;
  }

  async getSnapshot(): Promise<SystemDashboardResponse> {
    const webhookSubscriptionPromise = this.webhookSubscriptionStatusService
      ? this.webhookSubscriptionStatusService.getSnapshot()
      : Promise.resolve(this.buildFallbackWebhookSubscriptionSnapshot());
    const ownershipPromise = this.ownershipFoundationService
      ? this.ownershipFoundationService.getSnapshot()
      : Promise.resolve(this.buildFallbackOwnershipSnapshot());
    const [queues, mode, webhookSubscription, ownership] = await Promise.all([
      this.queueMetricsService.getSnapshot(),
      this.systemModeService.getEffectiveSnapshot(),
      webhookSubscriptionPromise,
      ownershipPromise,
    ]);
    await this.runtimeDiagnosticsService?.recordQueueLagSnapshot({
      queues,
      mode,
    });
    const [runtimeDiagnostics, backgroundBudget, webhookSlo] = await Promise.all([
      this.runtimeDiagnosticsService?.getDashboardSnapshot(),
      this.backgroundRuntimeGovernorService?.getDashboardBudgetSummary(),
      this.webhookSloService?.getSnapshot(),
    ]);
    const [vkParsingGuard, deliveryLedgerRisk] = await Promise.all([
      this.loadVkParsingGuardSnapshot(),
      this.loadDeliveryLedgerRiskSnapshot(),
    ]);
    const alerts: SystemDashboardAlert[] = [];
    const queueLagSec = queues.userFacingEffectiveLagSec ?? queues.effectiveLagSec;
    const failedCount = this.readActiveFailedCount(queues.webhookEvents.failed);
    const staleFailedCount = this.readStaleFailedCount(queues.webhookEvents.failed, failedCount);
    const failedWindowSec = queues.webhookEvents.failed.activeWindowSec ?? null;
    const criticalRate = mode.action.criticalRate;
    const errorRate = mode.action.errorRate;
    const stabilizing = this.isStabilizing(mode, queueLagSec);
    const hotPathTimeoutCount =
      runtimeDiagnostics?.hotPath.stages.reduce((sum, stage) => sum + stage.timeoutCount, 0) ?? 0;
    const hotPathSlowWarning = this.hasHotPathSlowWarning(runtimeDiagnostics?.hotPath);

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
        detail: this.buildFailedWebhookAlertDetail(failedCount, staleFailedCount, failedWindowSec),
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

    const joinBurstAlert = this.buildJoinBurstAlert(
      (
        queues as {
          webhookJoin?: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookJoin'];
        }
      ).webhookJoin,
      queueLagSec,
    );
    if (joinBurstAlert) {
      alerts.push(joinBurstAlert);
    }

    const ownershipRepairAlert = this.buildOwnershipRepairAlert(ownership);
    if (ownershipRepairAlert) {
      alerts.push(ownershipRepairAlert);
    }

    const ownershipRebalanceAlert = this.buildOwnershipRebalanceAlert(ownership);
    if (ownershipRebalanceAlert) {
      alerts.push(ownershipRebalanceAlert);
    }

    const ownershipCoverageAlert = this.buildOwnershipCoverageAlert(ownership);
    if (ownershipCoverageAlert) {
      alerts.push(ownershipCoverageAlert);
    }

    const problemChatsAlert = this.buildProblemChatsAlert(runtimeDiagnostics?.problemChats);
    if (problemChatsAlert) {
      alerts.push(problemChatsAlert);
    }

    const hotPathAlert = this.buildHotPathAlert(runtimeDiagnostics?.hotPath);
    if (hotPathAlert) {
      alerts.push(hotPathAlert);
    }

    const webhookSloAlert = this.buildWebhookSloAlert(webhookSlo);
    if (webhookSloAlert) {
      alerts.push(webhookSloAlert);
    }

    const vkParsingAlert = this.buildVkParsingHealthAlert(vkParsingGuard);
    if (vkParsingAlert) {
      alerts.push(vkParsingAlert);
    }

    const actionQueueLaneAlert = this.buildActionQueueLaneAlert(queues.actionQueues);
    if (actionQueueLaneAlert) {
      alerts.push(actionQueueLaneAlert);
    }

    const actionLedgerWatchdogAlert = this.buildActionLedgerWatchdogAlert(
      queues.actionLedgerWatchdog,
    );
    if (actionLedgerWatchdogAlert) {
      alerts.push(actionLedgerWatchdogAlert);
    }

    const deliveryLedgerAlert = this.buildDeliveryLedgerRiskAlert(deliveryLedgerRisk);
    if (deliveryLedgerAlert) {
      alerts.push(deliveryLedgerAlert);
    }

    const status = this.resolveStatus({
      mode: mode.mode,
      queueLagSec,
      failedCount,
      criticalRate,
      errorRate,
      webhookSubscriptionStatus: webhookSubscription.status,
      problemChatsCritical:
        runtimeDiagnostics?.problemChats?.items.some((item) => item.severity === 'critical') ??
        false,
      problemChatsWarning:
        runtimeDiagnostics?.problemChats?.items.some((item) => item.severity === 'warning') ??
        false,
      hotPathTimeoutCritical: hotPathTimeoutCount >= 10,
      hotPathTimeoutWarning: hotPathTimeoutCount > 0,
      hotPathSlowWarning,
      webhookSloStatus: webhookSlo?.status ?? null,
      vkParsingWarning: vkParsingAlert !== null,
      actionQueueLaneCritical: actionQueueLaneAlert?.level === 'critical',
      actionQueueLaneWarning: actionQueueLaneAlert?.level === 'warning',
      actionLedgerWatchdogCritical: actionLedgerWatchdogAlert?.level === 'critical',
      actionLedgerWatchdogWarning: actionLedgerWatchdogAlert?.level === 'warning',
      deliveryLedgerWarning: deliveryLedgerAlert !== null,
    });
    const queueGroupHealth = buildSystemQueueGroupHealth(queues);
    const runtimeProfile = buildSystemRuntimeProfile(
      webhookSlo?.targetProcessingMs ?? this.webhookSloTargetMs,
    );
    const canaryState = buildSystemCanaryState({
      queues,
      dashboardStatus: status,
      queueLagSec,
      queueLagCriticalThresholdSec: this.queueLagCriticalThresholdSec,
      activeFailedWebhooks: failedCount,
      webhookSlo: webhookSlo ?? null,
    });
    const rollbackReadiness = buildSystemRollbackReadiness({
      queues,
      dashboardStatus: status,
      queueLagSec,
      queueLagCriticalThresholdSec: this.queueLagCriticalThresholdSec,
      activeFailedWebhooks: failedCount,
      webhookSlo: webhookSlo ?? null,
    });

    return {
      summary: {
        status,
        title: this.buildSummaryTitle(status, stabilizing),
        detail: this.buildSummaryDetail(
          status,
          mode.reason,
          queueLagSec,
          failedCount,
          staleFailedCount,
          failedWindowSec,
          stabilizing,
        ),
        generatedAt: new Date().toISOString(),
        stabilizing,
      },
      alerts,
      queues,
      mode,
      webhookSubscription,
      ownership,
      runtimeProfile,
      canaryState,
      rollbackReadiness,
      queueGroupHealth,
      ...(runtimeDiagnostics
        ? {
            burst: runtimeDiagnostics.burst,
            hotPath: runtimeDiagnostics.hotPath,
            hotChats: runtimeDiagnostics.hotChats,
            membershipLookup: runtimeDiagnostics.membershipLookup,
            spammerSurfaces: runtimeDiagnostics.spammerSurfaces,
            spammerReadModel: runtimeDiagnostics.spammerReadModel,
            ...(runtimeDiagnostics.problemChats
              ? { problemChats: runtimeDiagnostics.problemChats }
              : {}),
          }
        : {}),
      ...(backgroundBudget ? { backgroundBudget } : {}),
      ...(webhookSlo ? { webhookSlo, slo: webhookSlo } : {}),
    };
  }

  private resolveStatus(input: {
    mode: 'normal' | 'degrade';
    queueLagSec: number;
    failedCount: number;
    criticalRate: number;
    errorRate: number;
    webhookSubscriptionStatus: WebhookSubscriptionSnapshot['status'];
    problemChatsCritical?: boolean;
    problemChatsWarning?: boolean;
    hotPathTimeoutCritical?: boolean;
    hotPathTimeoutWarning?: boolean;
    hotPathSlowWarning?: boolean;
    webhookSloStatus?: WebhookSloSnapshot['status'] | null;
    vkParsingWarning?: boolean;
    actionQueueLaneCritical?: boolean;
    actionQueueLaneWarning?: boolean;
    actionLedgerWatchdogCritical?: boolean;
    actionLedgerWatchdogWarning?: boolean;
    deliveryLedgerWarning?: boolean;
  }): SystemDashboardStatus {
    if (
      input.mode === 'degrade' ||
      input.queueLagSec > this.queueLagCriticalThresholdSec ||
      input.failedCount >= FAILED_EVENTS_CRITICAL_COUNT ||
      input.criticalRate >= ACTION_RATE_CRITICAL_THRESHOLD ||
      input.webhookSubscriptionStatus === 'critical' ||
      input.problemChatsCritical === true ||
      input.hotPathTimeoutCritical === true ||
      input.actionQueueLaneCritical === true ||
      input.actionLedgerWatchdogCritical === true ||
      input.webhookSloStatus === 'critical'
    ) {
      return 'critical';
    }

    if (
      input.queueLagSec > QUEUE_LAG_WARNING_SEC ||
      input.failedCount > 0 ||
      input.criticalRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.errorRate > ACTION_RATE_WARNING_THRESHOLD ||
      input.webhookSubscriptionStatus === 'warning' ||
      input.problemChatsWarning === true ||
      input.hotPathTimeoutWarning === true ||
      input.hotPathSlowWarning === true ||
      input.webhookSloStatus === 'warning' ||
      input.vkParsingWarning === true ||
      input.actionQueueLaneWarning === true ||
      input.actionLedgerWatchdogWarning === true ||
      input.deliveryLedgerWarning === true
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
    staleFailedCount: number,
    failedWindowSec: number | null,
    stabilizing: boolean,
  ): string {
    if (status === 'healthy') {
      return 'Webhook-path чистый, backlog не копится, critical MAX budget не съедается UI-нагрузкой.';
    }

    const failedSummary = this.buildFailedSummary(failedCount, staleFailedCount, failedWindowSec);
    if (stabilizing) {
      return `Auto-mode ещё держит защитный degrade (${reason}), но backlog уже не растёт. Lag ${queueLagSec.toFixed(1)} сек, ${failedSummary}.`;
    }

    return `Причина текущего режима: ${reason}. Lag ${queueLagSec.toFixed(1)} сек, ${failedSummary}.`;
  }

  private readActiveFailedCount(metrics: { count: number; activeCount?: number }): number {
    return metrics.activeCount ?? metrics.count;
  }

  private readStaleFailedCount(
    metrics: { count: number; staleCount?: number },
    activeFailedCount: number,
  ): number {
    return metrics.staleCount ?? Math.max(0, metrics.count - activeFailedCount);
  }

  private buildFailedWebhookAlertDetail(
    activeFailedCount: number,
    staleFailedCount: number,
    windowSec: number | null,
  ): string {
    if (!windowSec || windowSec <= 0) {
      return `В статусе FAILED сейчас ${activeFailedCount} событий.`;
    }

    const windowLabel = this.formatShortTimeWindow(windowSec);
    if (staleFailedCount > 0) {
      return `За ${windowLabel} в статусе FAILED ${activeFailedCount} событий; ещё ${staleFailedCount} старых остаются хвостом.`;
    }

    return `За ${windowLabel} в статусе FAILED ${activeFailedCount} событий.`;
  }

  private buildFailedSummary(
    activeFailedCount: number,
    staleFailedCount: number,
    windowSec: number | null,
  ): string {
    if (!windowSec || windowSec <= 0) {
      return `failed ${activeFailedCount}`;
    }

    const windowLabel = this.formatShortTimeWindow(windowSec);
    if (staleFailedCount > 0) {
      return `failed ${activeFailedCount} за ${windowLabel} (+${staleFailedCount} stale)`;
    }

    return `failed ${activeFailedCount} за ${windowLabel}`;
  }

  private formatShortTimeWindow(windowSec: number): string {
    if (windowSec % 3_600 === 0) {
      return `${windowSec / 3_600} ч.`;
    }

    if (windowSec % 60 === 0) {
      return `${windowSec / 60} мин.`;
    }

    return `${windowSec} сек.`;
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
    const operationalDiagnostics = snapshot.operationalDiagnostics;
    if (
      snapshot.status === 'healthy' &&
      (!operationalDiagnostics || operationalDiagnostics.warningBotCount === 0)
    ) {
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

    if (operationalDiagnostics && operationalDiagnostics.warningBotCount > 0) {
      const details: string[] = [`боты: ${operationalDiagnostics.warningBotIds.join(', ')}`];
      if (operationalDiagnostics.noActiveMembershipBotIds.length > 0) {
        details.push(
          `без active memberships: ${operationalDiagnostics.noActiveMembershipBotIds.join(', ')}`,
        );
      }
      if (operationalDiagnostics.noIncomingWebhookBotIds.length > 0) {
        details.push(
          `без входящих webhook: ${operationalDiagnostics.noIncomingWebhookBotIds.join(', ')}`,
        );
      }
      if (snapshot.otherSubscriptionsCount > 0) {
        details.push(`дополнительных subscriptions: ${snapshot.otherSubscriptionsCount}`);
      }
      if (snapshot.extraUpdateTypes.length > 0) {
        details.push(`лишние update types: ${snapshot.extraUpdateTypes.join(', ')}`);
      }
      if (snapshot.lastError) {
        details.push(`последняя ошибка: ${snapshot.lastError}`);
      }

      return {
        code: 'webhook-operational-bot-idle',
        level: 'warning',
        title: 'Active bot с подпиской не участвует в runtime',
        detail: details.join('; '),
        recommendedAction:
          'Проверьте, должен ли бот быть active: подключите его к managed chats/channels или переведите в dormant/disabled. Subscriptions не удаляйте без подтверждения владельца.',
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

  private buildProblemChatsAlert(
    problemChats:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['problemChats']
      | undefined,
  ): SystemDashboardAlert | null {
    const items = problemChats?.items ?? [];
    if (items.length === 0) {
      return null;
    }

    const criticalCount = items.filter((item) => item.severity === 'critical').length;
    const top = items[0];
    return {
      code: 'problem-chats',
      level: criticalCount > 0 ? 'critical' : 'warning',
      title:
        criticalCount > 0 ? 'Есть чаты с критичными runtime-проблемами' : 'Есть проблемные чаты',
      detail: `${items.length} чатов/сценариев за окно ${problemChats?.windowSec ?? 0} сек. Топ: ${top.chatId}, ${top.category}, ${top.reason}.`,
      recommendedAction:
        'Откройте system dashboard/problemChats или логи по chatId: чаще всего нужно восстановить права бота или снизить фоновые MAX-запросы.',
    };
  }

  private buildHotPathAlert(
    hotPath:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['hotPath']
      | undefined,
  ): SystemDashboardAlert | null {
    const stages = hotPath?.stages ?? [];
    const topTimeout = stages.find((stage) => stage.timeoutCount > 0);
    const totalTimeouts = stages.reduce((sum, stage) => sum + stage.timeoutCount, 0);
    if (topTimeout) {
      return {
        code: 'webhook-hot-path-timeouts',
        level: totalTimeouts >= 10 ? 'critical' : 'warning',
        title:
          totalTimeouts >= 10
            ? 'Webhook hot path регулярно упирается в watchdog'
            : 'Есть timeout в webhook hot path',
        detail: `${totalTimeouts} timeout за окно ${hotPath?.windowSec ?? 0} сек. Топ-стадия: ${topTimeout.stage}, max ${topTimeout.maxElapsedMs} мс.`,
        recommendedAction:
          'Уберите синхронный MAX API или тяжёлую работу из этой стадии; для group/admin actions используйте очередь.',
      };
    }

    const topSlow = stages.find(
      (stage) =>
        stage.slowCount >= HOT_PATH_SLOW_WARNING_COUNT ||
        stage.maxElapsedMs >= HOT_PATH_SLOW_WARNING_MAX_MS,
    );
    if (!topSlow) {
      return null;
    }

    const totalSlow = stages.reduce((sum, stage) => sum + stage.slowCount, 0);
    return {
      code: 'webhook-hot-path-slow',
      level: 'warning',
      title: 'Webhook hot path близко к watchdog',
      detail: `${totalSlow} slow completions за окно ${hotPath?.windowSec ?? 0} сек. Топ-стадия: ${topSlow.stage}, max ${topSlow.maxElapsedMs} мс.`,
      recommendedAction:
        'Перенесите синхронную работу из user-facing webhook path в очереди или сократите MAX/API ожидания до появления timeout.',
    };
  }

  private hasHotPathSlowWarning(
    hotPath:
      | Awaited<ReturnType<RuntimeDiagnosticsService['getDashboardSnapshot']>>['hotPath']
      | undefined,
  ): boolean {
    return (hotPath?.stages ?? []).some(
      (stage) =>
        stage.slowCount >= HOT_PATH_SLOW_WARNING_COUNT ||
        stage.maxElapsedMs >= HOT_PATH_SLOW_WARNING_MAX_MS,
    );
  }

  private buildWebhookSloAlert(
    snapshot: WebhookSloSnapshot | undefined,
  ): SystemDashboardAlert | null {
    if (!snapshot || snapshot.status === 'healthy') {
      return null;
    }

    const underTarget =
      snapshot.underTargetRatio === null
        ? 'n/a'
        : `${(snapshot.underTargetRatio * 100).toFixed(1)}%`;
    const enqueueUnderTarget =
      snapshot.enqueue?.underTargetRatio === null ||
      snapshot.enqueue?.underTargetRatio === undefined
        ? 'n/a'
        : `${(snapshot.enqueue.underTargetRatio * 100).toFixed(1)}%`;
    const ingressUnderTarget =
      snapshot.ingress.underTargetRatio === null
        ? 'n/a'
        : `${(snapshot.ingress.underTargetRatio * 100).toFixed(1)}%`;
    const claimsPerReceipt =
      snapshot.canonicalExecution.claimsPerReceiptRatio === null
        ? 'n/a'
        : snapshot.canonicalExecution.claimsPerReceiptRatio.toFixed(3);
    return {
      code: 'webhook-slo',
      level: snapshot.status === 'critical' ? 'critical' : 'warning',
      title:
        snapshot.status === 'critical'
          ? 'Webhook SLO просел критично'
          : 'Webhook SLO требует внимания',
      detail: `ingress ${snapshot.ingress.available ? 'available' : 'unavailable'}, p95 ${snapshot.ingress.p95LatencyMs ?? 0} мс, p99 ${snapshot.ingress.p99LatencyMs ?? 0} мс, under target ${ingressUnderTarget}, persistence failures ${snapshot.ingress.failedReceipts}; processing p95 ${snapshot.p95ProcessingMs ?? 0} мс, p99 ${snapshot.p99ProcessingMs ?? 0} мс, under target ${underTarget}, failed ${snapshot.failedEvents}, oldest unprocessed ${snapshot.oldestUnprocessedLagSec.toFixed(1)} сек; enqueue p95 ${snapshot.enqueue?.p95LatencyMs ?? 0} мс, enqueue under target ${enqueueUnderTarget}, oldest pending enqueue ${snapshot.enqueue?.oldestPendingLagSec.toFixed(1) ?? '0.0'} сек; receipts/EXECUTION claims ${snapshot.canonicalExecution.receipts}/${snapshot.canonicalExecution.executionClaims}, claims per receipt ${claimsPerReceipt}.`,
      recommendedAction:
        'Проверьте PostgreSQL receipt latency/failures, canonical claim preparation, backlog и MAX API rate limit до расширения фоновых задач.',
    };
  }

  private async loadVkParsingGuardSnapshot(): Promise<VkParsingGuardSnapshot | null> {
    if (!this.prisma) {
      return null;
    }

    const checkedAt = new Date();
    const windowMin = VK_PARSING_HEALTH_WINDOW_MIN;
    const since = new Date(checkedAt.getTime() - windowMin * 60_000);
    try {
      const [sourceRows, mediaRows, publishRows] = await Promise.all([
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'ACTIVE')::int as "activeSources",
            count(*) filter (
              where status = 'ACTIVE'
                and updated_at >= ${since}
                and (sync_status in ('BACKOFF', 'ERROR') or last_error_code is not null)
            )::int as "sourceFailureCount",
            count(*) filter (
              where status = 'ACTIVE'
                and circuit_opened_at is not null
            )::int as "circuitOpenSources"
          from vk_parsing_sources
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (
              where coalesce(last_checked_at, updated_at) >= ${since}
            )::int as "recentMediaChecks",
            count(*) filter (
              where status = 'FAILED'
                and coalesce(last_checked_at, updated_at) >= ${since}
            )::int as "recentMediaFailures"
          from vk_parsing_media_cache
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where publish_queued_at is not null)::int as "publishBacklog",
            extract(epoch from (now() - min(publish_queued_at)))::int
              as "oldestPublishBacklogAgeSec"
          from vk_parsing_posts
          where publish_queued_at is not null
        `,
      ]);
      const sources = sourceRows[0] ?? {};
      const media = mediaRows[0] ?? {};
      const publish = publishRows[0] ?? {};
      const recentMediaChecks = this.readNumber(media.recentMediaChecks);
      const recentMediaFailures = this.readNumber(media.recentMediaFailures);
      return {
        checkedAt: checkedAt.toISOString(),
        windowMin,
        activeSources: this.readNumber(sources.activeSources),
        sourceFailureCount: this.readNumber(sources.sourceFailureCount),
        circuitOpenSources: this.readNumber(sources.circuitOpenSources),
        recentMediaChecks,
        recentMediaFailures,
        recentMediaFailureRatio:
          recentMediaChecks > 0 ? Math.min(1, recentMediaFailures / recentMediaChecks) : 0,
        publishBacklog: this.readNumber(publish.publishBacklog),
        oldestPublishBacklogAgeSec: this.readNumber(publish.oldestPublishBacklogAgeSec),
      };
    } catch {
      return null;
    }
  }

  private buildVkParsingHealthAlert(
    snapshot: VkParsingGuardSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot || snapshot.activeSources === 0) {
      return null;
    }

    const sourceFailuresHigh =
      snapshot.sourceFailureCount >= VK_PARSING_SOURCE_FAILURE_WARNING_COUNT;
    const mediaFailuresHigh =
      snapshot.recentMediaChecks > 0 &&
      snapshot.recentMediaFailureRatio >= VK_PARSING_MEDIA_FAILURE_WARNING_RATIO;
    const publishBacklogOld =
      snapshot.oldestPublishBacklogAgeSec >= VK_PARSING_PUBLISH_BACKLOG_WARNING_SEC;

    if (
      snapshot.circuitOpenSources === 0 &&
      !sourceFailuresHigh &&
      !mediaFailuresHigh &&
      !publishBacklogOld
    ) {
      return null;
    }

    const details = [
      snapshot.circuitOpenSources > 0 ? `circuit open: ${snapshot.circuitOpenSources}` : null,
      sourceFailuresHigh
        ? `source failures за ${snapshot.windowMin} мин: ${snapshot.sourceFailureCount}`
        : null,
      mediaFailuresHigh
        ? `media failures: ${(snapshot.recentMediaFailureRatio * 100).toFixed(1)}%`
        : null,
      publishBacklogOld
        ? `oldest publish backlog: ${snapshot.oldestPublishBacklogAgeSec} сек`
        : null,
    ].filter((item): item is string => item !== null);

    return {
      code: 'vk-parsing-health',
      level: 'warning',
      title: 'VK parsing требует внимания',
      detail: details.join('; '),
      recommendedAction:
        'Откройте VK diagnostics: проверьте noisy sources, media failures и publish backlog. Readiness при этом остаётся зелёной.',
    };
  }

  private async loadDeliveryLedgerRiskSnapshot(): Promise<DeliveryLedgerRiskSnapshot | null> {
    if (!this.prisma) {
      return null;
    }

    const checkedAt = new Date();
    const staleActionSince = new Date(checkedAt.getTime() - DELIVERY_LEDGER_STALE_ACTION_MS);
    const staleBroadcastSendingSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_STALE_BROADCAST_SENDING_MS,
    );
    const staleSuggestionSendingSince = new Date(
      checkedAt.getTime() - DELIVERY_LEDGER_STALE_SUGGESTION_SENDING_MS,
    );
    try {
      const [actionRows, broadcastRows, suggestionRows] = await Promise.all([
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'AMBIGUOUS')::int as "actionAmbiguous",
            count(*) filter (
              where status = 'IN_PROGRESS'
                and updated_at < ${staleActionSince}
            )::int as "actionStaleInProgress",
            count(*) filter (
              where status = 'FAILED_RETRYABLE'
                and terminal = false
                and updated_at < ${staleActionSince}
            )::int as "actionStaleRetryable",
            extract(epoch from (now() - min(updated_at) filter (
              where status = 'AMBIGUOUS'
                 or (status = 'IN_PROGRESS' and updated_at < ${staleActionSince})
                 or (
                   status = 'FAILED_RETRYABLE'
                   and terminal = false
                   and updated_at < ${staleActionSince}
                 )
            )))::int as "actionOldestRiskAgeSec"
          from max_action_ledger
          where status = 'AMBIGUOUS'
             or (status = 'IN_PROGRESS' and updated_at < ${staleActionSince})
             or (
               status = 'FAILED_RETRYABLE'
               and terminal = false
               and updated_at < ${staleActionSince}
             )
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where status = 'AMBIGUOUS')::int as "broadcastAmbiguous",
            count(*) filter (
              where status = 'SENDING'
                and locked_at < ${staleBroadcastSendingSince}
            )::int as "broadcastStaleSending",
            count(distinct broadcast_id)::int as "broadcastRiskBroadcasts",
            extract(epoch from (now() - min(coalesce(locked_at, updated_at))))::int
              as "broadcastOldestRiskAgeSec"
          from managed_broadcast_deliveries
          where status = 'AMBIGUOUS'
             or (status = 'SENDING' and locked_at < ${staleBroadcastSendingSince})
        `,
        this.prisma.$queryRaw<Array<Record<string, unknown>>>`
          select
            count(*) filter (where d.status = 'AMBIGUOUS')::int as "suggestionAmbiguous",
            count(*) filter (
              where d.status = 'FAILED'
                and d.terminal = true
            )::int as "suggestionTerminalFailed",
            count(*) filter (
              where d.status = 'SENDING'
                and d.locked_at < ${staleSuggestionSendingSince}
            )::int as "suggestionStaleSending",
            count(distinct d.audit_log_id)::int as "suggestionRiskSuggestions",
            extract(epoch from (now() - min(coalesce(d.locked_at, d.updated_at))))::int
              as "suggestionOldestRiskAgeSec"
          from channel_suggestion_admin_deliveries d
          join audit_logs a on a.id = d.audit_log_id
          where a.action = 'CHANNEL_DIALOG_SUGGESTION'
            and coalesce(nullif(a.payload->>'reviewStatus', ''), 'pending') = 'pending'
            and (
              d.status = 'AMBIGUOUS'
              or (d.status = 'FAILED' and d.terminal = true)
              or (d.status = 'SENDING' and d.locked_at < ${staleSuggestionSendingSince})
            )
        `,
      ]);
      const action = actionRows[0] ?? {};
      const broadcast = broadcastRows[0] ?? {};
      const suggestion = suggestionRows[0] ?? {};

      return {
        checkedAt: checkedAt.toISOString(),
        actionAmbiguous: this.readNumber(action.actionAmbiguous),
        actionStaleInProgress: this.readNumber(action.actionStaleInProgress),
        actionStaleRetryable: this.readNumber(action.actionStaleRetryable),
        actionOldestRiskAgeSec: this.readNumber(action.actionOldestRiskAgeSec),
        broadcastAmbiguous: this.readNumber(broadcast.broadcastAmbiguous),
        broadcastStaleSending: this.readNumber(broadcast.broadcastStaleSending),
        broadcastRiskBroadcasts: this.readNumber(broadcast.broadcastRiskBroadcasts),
        broadcastOldestRiskAgeSec: this.readNumber(broadcast.broadcastOldestRiskAgeSec),
        suggestionAmbiguous: this.readNumber(suggestion.suggestionAmbiguous),
        suggestionTerminalFailed: this.readNumber(suggestion.suggestionTerminalFailed),
        suggestionStaleSending: this.readNumber(suggestion.suggestionStaleSending),
        suggestionRiskSuggestions: this.readNumber(suggestion.suggestionRiskSuggestions),
        suggestionOldestRiskAgeSec: this.readNumber(suggestion.suggestionOldestRiskAgeSec),
      };
    } catch {
      return null;
    }
  }

  private buildDeliveryLedgerRiskAlert(
    snapshot: DeliveryLedgerRiskSnapshot | null,
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const actionRisk =
      snapshot.actionAmbiguous + snapshot.actionStaleInProgress + snapshot.actionStaleRetryable;
    const broadcastRisk = snapshot.broadcastAmbiguous + snapshot.broadcastStaleSending;
    const suggestionRisk =
      snapshot.suggestionAmbiguous +
      snapshot.suggestionTerminalFailed +
      snapshot.suggestionStaleSending;
    if (actionRisk === 0 && broadcastRisk === 0 && suggestionRisk === 0) {
      return null;
    }

    const details = [
      actionRisk > 0
        ? `MAX action ledger: ambiguous ${snapshot.actionAmbiguous}, stale in-progress ${snapshot.actionStaleInProgress}, stale retryable ${snapshot.actionStaleRetryable}, oldest ${snapshot.actionOldestRiskAgeSec} сек`
        : null,
      broadcastRisk > 0
        ? `managed broadcast delivery: ambiguous ${snapshot.broadcastAmbiguous}, stale sending ${snapshot.broadcastStaleSending}, broadcasts ${snapshot.broadcastRiskBroadcasts}, oldest ${snapshot.broadcastOldestRiskAgeSec} сек`
        : null,
      suggestionRisk > 0
        ? `suggestion delivery: ambiguous ${snapshot.suggestionAmbiguous}, terminal failed ${snapshot.suggestionTerminalFailed}, stale sending ${snapshot.suggestionStaleSending}, suggestions ${snapshot.suggestionRiskSuggestions}, oldest ${snapshot.suggestionOldestRiskAgeSec} сек`
        : null,
    ].filter((item): item is string => item !== null);

    return {
      code: 'delivery-ledger-risk',
      level: 'warning',
      title: 'Есть хвост доставок, требующий ручной сверки',
      detail: details.join('; '),
      recommendedAction:
        'Сверьте MAX/логи/remoteMessageId перед любыми повторами. Ambiguous send/delete/member actions и managed broadcast deliveries не ретрайте автоматически.',
    };
  }

  private buildActionQueueLaneAlert(
    actionQueues: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['actionQueues'],
  ): SystemDashboardAlert | null {
    const pending = (queueName: string) => {
      const queue = actionQueues?.[queueName as keyof typeof actionQueues];
      return (queue?.waiting ?? 0) + (queue?.prioritized ?? 0);
    };
    const criticalPending = pending(MAX_ACTION_CRITICAL_QUEUE);
    if (criticalPending === 0) {
      return null;
    }

    const critical = criticalPending >= this.actionCriticalBacklogThreshold;
    return {
      code: 'action-queue-critical-backlog',
      level: critical ? 'critical' : 'warning',
      title: critical
        ? 'Critical MAX actions накапливаются'
        : 'Critical MAX actions ожидают worker',
      detail: `pending: critical ${criticalPending}, interactive ${pending(MAX_ACTION_INTERACTIVE_QUEUE)}, background ${pending(MAX_ACTION_BACKGROUND_QUEUE)}, legacy ${pending(MAX_ACTION_LEGACY_QUEUE)}.`,
      recommendedAction:
        'Проверьте api-action, per-lane workers и MAX limiter/circuit. Не переносите jobs между очередями вручную.',
    };
  }

  private buildActionLedgerWatchdogAlert(
    snapshot: Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['actionLedgerWatchdog'],
  ): SystemDashboardAlert | null {
    if (!snapshot) {
      return null;
    }

    const quarantined = snapshot.lastQuarantinedCount > 0;
    if (!snapshot.lastError && snapshot.staleCount === 0 && !quarantined) {
      return null;
    }

    const details = [
      `mode ${snapshot.mode}`,
      snapshot.lastError ? `последняя ошибка: ${snapshot.lastError}` : null,
      snapshot.staleCount > 0
        ? `stale: ${snapshot.staleCount} (enqueued ${snapshot.staleEnqueuedCount}, in-progress ${snapshot.staleInProgressCount}, retryable ${snapshot.staleRetryableCount}), oldest ${snapshot.oldestStaleAgeSec.toFixed(1)} сек`
        : null,
      snapshot.lastReconciledCount > 0
        ? `reconciled ${snapshot.lastReconciledCount}, requeued ${snapshot.lastRequeuedCount}, retry orphans terminalized ${snapshot.lastRetryOrphanTerminalizedCount}, quarantined ${snapshot.lastQuarantinedCount}, terminal failed ${snapshot.lastTerminalFailedCount}`
        : null,
      snapshot.lastShadowClassifiedCount > 0
        ? `shadow classified ${snapshot.lastShadowClassifiedCount}, would requeue ${snapshot.lastWouldRequeueCount}, would quarantine ${snapshot.lastWouldQuarantineCount}, would terminal-fail ${snapshot.lastWouldTerminalFailCount}, would recover ${snapshot.lastWouldRecoverSucceededCount}`
        : null,
      snapshot.lastRunAt ? `last run ${snapshot.lastRunAt}` : 'watchdog ещё не запускался',
    ].filter((item): item is string => item !== null);

    return {
      code: quarantined ? 'action-ledger-watchdog-quarantine' : 'action-ledger-watchdog',
      level: quarantined ? 'critical' : 'warning',
      title: quarantined
        ? 'Action ledger содержит новый неоднозначный исход'
        : 'Action ledger watchdog требует внимания',
      detail: details.join('; '),
      recommendedAction: quarantined
        ? 'Не повторяйте действие автоматически. Сверьте MAX, логи и объект назначения до ручного решения.'
        : 'Проверьте BullMQ action queues и состояние PostgreSQL; автоматическое восстановление ограничено свежими pre-dispatch member actions.',
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

  private buildFallbackOwnershipSnapshot(): BotOwnershipFoundationSnapshot {
    return {
      generatedAt: new Date().toISOString(),
      bots: {
        configured: 0,
        adminVisible: 0,
        active: 0,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
        chats: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
        channels: {
          total: 0,
          withPrimary: 0,
          withoutPrimary: 0,
          coverageRatio: 1,
        },
      },
      routingStates: {
        ready: 0,
        noEligibleBot: 0,
      },
      anomalies: {
        noPrimary: 0,
        recoverableLegacyOnly: 0,
        recoverableFromMemberships: 0,
        noEligibleBot: 0,
        unbound: 0,
        primaryBotUnknown: 0,
        legacyBotUnknown: 0,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 0,
        sharedChats: 0,
      },
      repair: {
        enabled: false,
        activeOnThisRole: false,
        intervalMs: 300_000,
        rebalanceMode: 'off',
        rebalanceCanaryPercent: 0,
        rebalanceMaxMovesPerRun: 25,
        recommendedMoves: 0,
        lastAppliedMoves: 0,
        lastRunAt: null,
        lastSuccessAt: null,
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    };
  }

  private buildOwnershipRepairAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    if (ownership.repair.lastError) {
      return {
        code: 'ownership-repair-error',
        level: 'warning',
        title: 'Ownership foundation repair не завершился чисто',
        detail: `Последняя ошибка repair: ${ownership.repair.lastError}. Snapshot остаётся доступным, но multi-bot rollout лучше не продолжать до исправления.`,
        recommendedAction:
          'Проверьте api-admin logs и состояние chats/chat_bot_memberships. Не активируйте новых ботов, пока repair снова не станет зелёным.',
      };
    }

    if (!ownership.repair.enabled || !ownership.repair.lastSuccessAt) {
      return null;
    }

    const ageMs = Date.now() - Date.parse(ownership.repair.lastSuccessAt);
    if (!Number.isFinite(ageMs) || ageMs <= ownership.repair.intervalMs * 2) {
      return null;
    }

    return {
      code: 'ownership-repair-stale',
      level: 'warning',
      title: 'Ownership foundation snapshot устарел',
      detail: `Последний успешный repair был ${ownership.repair.lastSuccessAt}, что заметно старше ожидаемого окна ${Math.round(ownership.repair.intervalMs / 60_000)} мин.`,
      recommendedAction:
        'Проверьте, что api-admin работает и Redis lock не завис. До обновления snapshot не используйте ownership цифры как основание для multi-bot rollout.',
    };
  }

  private buildOwnershipCoverageAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    const recoverableNow =
      ownership.anomalies.recoverableLegacyOnly + ownership.anomalies.recoverableFromMemberships;
    const unresolvedKnownIssues =
      ownership.anomalies.primaryBotUnknown +
      ownership.anomalies.legacyBotUnknown +
      ownership.anomalies.activeMembershipBotUnknown +
      ownership.anomalies.primaryWithoutActiveMembership +
      ownership.anomalies.noEligibleBot;
    const rightsLimitedPrimaries = ownership.anomalies.primaryWithoutAdminAccess;
    const totalGaps = ownership.entities.total.withoutPrimary;

    if (totalGaps === 0 && unresolvedKnownIssues === 0) {
      return null;
    }

    const additionalBotsPrepared = ownership.bots.configured > 1 || ownership.bots.dormant > 0;
    const level =
      unresolvedKnownIssues > 0 || (additionalBotsPrepared && totalGaps > 0) ? 'warning' : 'info';
    const parts = [
      `valid ownership coverage ${ownership.entities.total.withPrimary}/${ownership.entities.total.total}`,
      `without primary ${totalGaps}`,
      `recoverable now ${recoverableNow}`,
    ];
    if (ownership.anomalies.unbound > 0) {
      parts.push(`unbound ${ownership.anomalies.unbound}`);
    }
    if (ownership.anomalies.noEligibleBot > 0) {
      parts.push(`no eligible bot ${ownership.anomalies.noEligibleBot}`);
    }
    if (unresolvedKnownIssues > 0) {
      parts.push(`known anomalies ${unresolvedKnownIssues}`);
    }
    if (rightsLimitedPrimaries > 0) {
      parts.push(`primary without admin access ${rightsLimitedPrimaries}`);
    }

    return {
      code: 'ownership-foundation',
      level,
      title:
        level === 'warning'
          ? 'Ownership foundation ещё не готов к multi-bot rollout'
          : 'Ownership foundation ещё не доведён до полной coverage',
      detail: `${parts.join(', ')}.`,
      recommendedAction:
        'Закройте recoverable ownership gaps и держите shared-chat rollout выключенным, пока unbound/unknown/no-eligible cases не станут понятными оператору. Для no-eligible объектов выполните targeted access probe; не реактивируйте memberships массово.',
    };
  }

  private buildOwnershipRebalanceAlert(
    ownership: BotOwnershipFoundationSnapshot,
  ): SystemDashboardAlert | null {
    if (ownership.repair.recommendedMoves <= 0) {
      return null;
    }

    const mode = ownership.repair.rebalanceMode;
    return {
      code: `ownership-rebalance-${mode}`,
      level: 'info',
      title:
        mode === 'shadow'
          ? 'Ownership rebalance работает в shadow-режиме'
          : 'Ownership rebalance выполняется постепенно',
      detail: `Детерминированное распределение рекомендует ${ownership.repair.recommendedMoves} перемещений; последний запуск применил ${ownership.repair.lastAppliedMoves}.`,
      recommendedAction:
        mode === 'shadow' || mode === 'off'
          ? 'Сравните per-bot load и access snapshots перед включением canary.'
          : `Контролируйте failover и duplicate-action метрики; лимит одного запуска ${ownership.repair.rebalanceMaxMovesPerRun}.`,
    };
  }

  private buildDefaultWorkerSkewAlert(
    workerGroups?: Awaited<
      ReturnType<QueueMetricsService['getSnapshot']>
    >['webhookDefaultWorkerGroups'],
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

  private buildJoinBurstAlert(
    joinCounters:
      | Awaited<ReturnType<QueueMetricsService['getSnapshot']>>['webhookJoin']
      | undefined,
    userFacingLagSec: number,
  ): SystemDashboardAlert | null {
    if (!joinCounters) {
      return null;
    }

    const pressure = joinCounters.waiting + joinCounters.active;
    if (pressure < JOIN_BURST_WARNING_PRESSURE || userFacingLagSec > QUEUE_LAG_WARNING_SEC) {
      return null;
    }

    const critical = pressure >= JOIN_BURST_CRITICAL_PRESSURE;
    return {
      code: 'join-burst-isolated',
      level: critical ? 'warning' : 'info',
      title: critical
        ? 'Join lane держит заметный burst'
        : 'Join lane принял локальный всплеск без влияния на ответы бота',
      detail: `В join lane сейчас ${pressure} active+waiting, при этом user-facing lag остаётся ${userFacingLagSec.toFixed(1)} сек.`,
      recommendedAction:
        'Проверьте hot chat по user_added и greeting/join path. Realtime default path сейчас изолирован и не требует срочного вмешательства.',
    };
  }

  private readNumber(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }
}
