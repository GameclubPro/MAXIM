import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QueueMetricsService, type QueueMetricsSnapshot } from './queue-metrics.service';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from './system-mode.service';
import { MaxApiMetricsService } from './max-api-metrics.service';
import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';

export type BackgroundRuntimeGovernorAction = 'run' | 'slow' | 'pause';

export type BackgroundRuntimeGovernorDecision = {
  action: BackgroundRuntimeGovernorAction;
  retryAfterMs: number;
  reason: string;
};

type BackgroundPressureSnapshot = {
  generatedAt: string;
  mode: SystemModeSnapshot;
  queues: QueueMetricsSnapshot;
  backgroundShare: number;
  botLoad: BackgroundBotLoadSnapshot;
  topSources: Array<{
    sourceTag: string;
    totalRequests: number;
    avgRps: number;
    peakRps: number;
  }>;
  workerSkew: {
    groupName: string | null;
    pressure: number;
    totalPressure: number;
    share: number;
  };
};

type BackgroundBotLoadSnapshot = {
  maxSmoothedLoad: number;
  maxPeakLoad: number;
  slowThreshold: number;
  pauseThreshold: number;
  topBots: Array<{
    botId: string;
    smoothedLoad: number;
    peakLoad: number;
    avgLoad: number;
  }>;
};

export type BackgroundRuntimeBudgetSummary = {
  windowSec: number;
  backgroundShare: number;
  topSources: Array<{
    sourceTag: string;
    totalRequests: number;
    avgRps: number;
    peakRps: number;
  }>;
  pauseReasons: Array<{
    component: string;
    sourceTag: string;
    action: 'run' | 'slow' | 'pause';
    reason: string;
    count: number;
    lastObservedAt: string | null;
  }>;
  botLoad: BackgroundBotLoadSnapshot;
};

const DEFAULT_SOURCE_WINDOW_SEC = 10 * 60;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_SOFT_QUEUE_LAG_SEC = 3;
const DEFAULT_BACKGROUND_SHARE_THRESHOLD = 0.4;
const DEFAULT_WORKER_SKEW_PRESSURE = 4;
const DEFAULT_WORKER_SKEW_SHARE = 0.7;
const DEFAULT_SLOW_RETRY_AFTER_MS = 20_000;
const DEFAULT_PAUSE_RETRY_AFTER_MS = 60_000;
const DEFAULT_BOT_LOAD_SLOW_THRESHOLD = 0.35;
const DEFAULT_BOT_LOAD_PAUSE_THRESHOLD = 0.7;

@Injectable()
export class BackgroundRuntimeGovernorService {
  private readonly logger = new Logger(BackgroundRuntimeGovernorService.name);
  private readonly sourceWindowSec: number;
  private readonly cacheTtlMs: number;
  private readonly softQueueLagSec: number;
  private readonly backgroundShareThreshold: number;
  private readonly workerSkewPressure: number;
  private readonly workerSkewShare: number;
  private readonly slowRetryAfterMs: number;
  private readonly pauseRetryAfterMs: number;
  private readonly botLoadSlowThreshold: number;
  private readonly botLoadPauseThreshold: number;
  private cachedSnapshot: BackgroundPressureSnapshot | null = null;
  private cachedSnapshotAtMs = 0;
  private pendingSnapshot: Promise<BackgroundPressureSnapshot> | null = null;

  constructor(
    private readonly queueMetricsService: QueueMetricsService,
    private readonly systemModeService: SystemModeService,
    private readonly maxApiMetricsService: MaxApiMetricsService,
    configService: ConfigService,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
  ) {
    this.sourceWindowSec = this.readPositiveInt(
      configService.get('BACKGROUND_GOVERNOR_SOURCE_WINDOW_SEC'),
      DEFAULT_SOURCE_WINDOW_SEC,
    );
    this.cacheTtlMs = this.readPositiveInt(
      configService.get('BACKGROUND_GOVERNOR_CACHE_TTL_MS'),
      DEFAULT_CACHE_TTL_MS,
    );
    this.softQueueLagSec = this.readPositiveNumber(
      configService.get('BACKGROUND_GOVERNOR_SOFT_QUEUE_LAG_SEC'),
      DEFAULT_SOFT_QUEUE_LAG_SEC,
    );
    this.backgroundShareThreshold = this.readFraction(
      configService.get('BACKGROUND_GOVERNOR_BACKGROUND_SHARE_THRESHOLD'),
      DEFAULT_BACKGROUND_SHARE_THRESHOLD,
    );
    this.workerSkewPressure = this.readPositiveInt(
      configService.get('BACKGROUND_GOVERNOR_WORKER_SKEW_PRESSURE'),
      DEFAULT_WORKER_SKEW_PRESSURE,
    );
    this.workerSkewShare = this.readFraction(
      configService.get('BACKGROUND_GOVERNOR_WORKER_SKEW_SHARE'),
      DEFAULT_WORKER_SKEW_SHARE,
    );
    this.slowRetryAfterMs = this.readPositiveInt(
      configService.get('BACKGROUND_GOVERNOR_SLOW_RETRY_AFTER_MS'),
      DEFAULT_SLOW_RETRY_AFTER_MS,
    );
    this.pauseRetryAfterMs = this.readPositiveInt(
      configService.get('BACKGROUND_GOVERNOR_PAUSE_RETRY_AFTER_MS'),
      DEFAULT_PAUSE_RETRY_AFTER_MS,
    );
    this.botLoadSlowThreshold = this.readFraction(
      configService.get('BACKGROUND_GOVERNOR_BOT_LOAD_SLOW_THRESHOLD'),
      DEFAULT_BOT_LOAD_SLOW_THRESHOLD,
    );
    this.botLoadPauseThreshold = Math.max(
      this.botLoadSlowThreshold,
      this.readFraction(
        configService.get('BACKGROUND_GOVERNOR_BOT_LOAD_PAUSE_THRESHOLD'),
        DEFAULT_BOT_LOAD_PAUSE_THRESHOLD,
      ),
    );
  }

  async decide(params: {
    component: string;
    sourceTag: string;
    allowRecoveryWindowRun?: boolean;
    allowQueueLagSlowPathBelowSec?: number;
  }): Promise<BackgroundRuntimeGovernorDecision> {
    const snapshot = await this.getPressureSnapshot();
    const decision = this.buildDecisionFromSnapshot(snapshot, {
      allowRecoveryWindowRun: params.allowRecoveryWindowRun === true,
      allowQueueLagSlowPathBelowSec: params.allowQueueLagSlowPathBelowSec,
    });

    if (decision.action !== 'run') {
      await this.runtimeDiagnosticsService?.recordBackgroundDecision({
        component: params.component,
        sourceTag: params.sourceTag,
        action: decision.action,
        reason: decision.reason,
      });
    }

    return decision;
  }

  peekDecision(params: {
    component: string;
    sourceTag: string;
    allowRecoveryWindowRun?: boolean;
    allowQueueLagSlowPathBelowSec?: number;
  }): BackgroundRuntimeGovernorDecision | null {
    const snapshot = this.getCachedSnapshot();
    if (!snapshot) {
      return null;
    }

    return this.buildDecisionFromSnapshot(snapshot, {
      allowRecoveryWindowRun: params.allowRecoveryWindowRun === true,
      allowQueueLagSlowPathBelowSec: params.allowQueueLagSlowPathBelowSec,
    });
  }

  async getDashboardBudgetSummary(): Promise<BackgroundRuntimeBudgetSummary> {
    const [snapshot, pauseReasons] = await Promise.all([
      this.getPressureSnapshot(),
      this.runtimeDiagnosticsService?.getBackgroundDecisionSummary(),
    ]);

    return {
      windowSec: this.sourceWindowSec,
      backgroundShare: Number(snapshot.backgroundShare.toFixed(3)),
      topSources: snapshot.topSources,
      pauseReasons: pauseReasons?.pauseReasons ?? [],
      botLoad: snapshot.botLoad,
    };
  }

  private async getPressureSnapshot(): Promise<BackgroundPressureSnapshot> {
    const cached = this.getCachedSnapshot();
    if (cached) {
      return cached;
    }

    if (!this.pendingSnapshot) {
      this.pendingSnapshot = this.buildPressureSnapshot()
        .then((snapshot) => {
          this.cachedSnapshot = snapshot;
          this.cachedSnapshotAtMs = Date.now();
          return snapshot;
        })
        .catch((error: unknown) => {
          this.logger.debug(
            { err: error instanceof Error ? error.message : String(error) },
            'Failed to build background pressure snapshot',
          );
          throw error;
        })
        .finally(() => {
          this.pendingSnapshot = null;
        });
    }

    return this.pendingSnapshot;
  }

  private getCachedSnapshot(): BackgroundPressureSnapshot | null {
    if (!this.cachedSnapshot) {
      return null;
    }
    if (Date.now() - this.cachedSnapshotAtMs > this.cacheTtlMs) {
      return null;
    }
    return this.cachedSnapshot;
  }

  private async buildPressureSnapshot(): Promise<BackgroundPressureSnapshot> {
    const [mode, queues, maxApi] = await Promise.all([
      this.systemModeService.getEffectiveSnapshot(),
      this.queueMetricsService.getSnapshot({ maxAgeMs: 2_000 }),
      this.maxApiMetricsService.getSourceSnapshot({ windowSec: this.sourceWindowSec }),
    ]);
    const totalRequests = maxApi.overall.totalRequests;
    const backgroundRequests = maxApi.overall.trafficClasses.background.totalRequests;
    const backgroundShare = totalRequests > 0 ? backgroundRequests / totalRequests : 0;
    const botLoad = await this.buildBotLoadSnapshot(queues);

    const workerGroups = Object.entries(queues.webhookDefaultWorkerGroups ?? {}).map(
      ([groupName, metrics]) => ({
        groupName,
        pressure: metrics.counters.waiting + metrics.counters.active * 3,
      }),
    );
    const totalPressure = workerGroups.reduce((sum, item) => sum + item.pressure, 0);
    const primary = workerGroups.reduce(
      (best, current) => (current.pressure > best.pressure ? current : best),
      { groupName: null as string | null, pressure: 0 },
    );

    const topSources = Object.entries(maxApi.sources)
      .map(([sourceTag, stats]) => ({
        sourceTag,
        totalRequests: stats.trafficClasses.background.totalRequests,
        avgRps: stats.trafficClasses.background.avgRps,
        peakRps: stats.trafficClasses.background.peakRps,
      }))
      .filter((item) => item.totalRequests > 0)
      .sort(
        (left, right) =>
          right.totalRequests - left.totalRequests ||
          right.peakRps - left.peakRps ||
          left.sourceTag.localeCompare(right.sourceTag),
      )
      .slice(0, 6);

    return {
      generatedAt: new Date().toISOString(),
      mode,
      queues,
      backgroundShare,
      botLoad,
      topSources,
      workerSkew: {
        groupName: primary.groupName,
        pressure: primary.pressure,
        totalPressure,
        share: totalPressure > 0 ? primary.pressure / totalPressure : 0,
      },
    };
  }

  private buildDecisionFromSnapshot(
    snapshot: BackgroundPressureSnapshot,
    options: {
      allowRecoveryWindowRun?: boolean;
      allowQueueLagSlowPathBelowSec?: number;
    } = {},
  ): BackgroundRuntimeGovernorDecision {
    const queueLagSec =
      snapshot.queues.userFacingEffectiveLagSec ?? snapshot.queues.effectiveLagSec;
    const allowRecoveryWindowRun =
      options.allowRecoveryWindowRun === true && queueLagSec < this.softQueueLagSec;
    const allowQueueLagSlowPath =
      typeof options.allowQueueLagSlowPathBelowSec === 'number' &&
      Number.isFinite(options.allowQueueLagSlowPathBelowSec) &&
      queueLagSec >= this.softQueueLagSec &&
      queueLagSec < options.allowQueueLagSlowPathBelowSec;

    if (snapshot.mode.mode === 'degrade' && !isSystemModeRecoveryWindow(snapshot.mode)) {
      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: snapshot.mode.reason || 'system degrade',
      };
    }

    if (isSystemModeRecoveryWindow(snapshot.mode) && !allowRecoveryWindowRun) {
      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: snapshot.mode.reason || 'recovery window in progress',
      };
    }

    if (queueLagSec >= this.softQueueLagSec) {
      if (allowQueueLagSlowPath) {
        return {
          action: 'slow',
          retryAfterMs: this.pauseRetryAfterMs,
          reason: `user-facing queue lag ${queueLagSec.toFixed(1)}s`,
        };
      }

      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: `user-facing queue lag ${queueLagSec.toFixed(1)}s`,
      };
    }

    if (snapshot.botLoad.maxSmoothedLoad >= this.botLoadPauseThreshold) {
      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: `MAX API bot load ${(snapshot.botLoad.maxSmoothedLoad * 100).toFixed(1)}%`,
      };
    }

    if (snapshot.botLoad.maxSmoothedLoad >= this.botLoadSlowThreshold) {
      return {
        action: 'slow',
        retryAfterMs: this.slowRetryAfterMs,
        reason: `MAX API bot load ${(snapshot.botLoad.maxSmoothedLoad * 100).toFixed(1)}%`,
      };
    }

    if (snapshot.backgroundShare >= this.backgroundShareThreshold) {
      return {
        action: 'slow',
        retryAfterMs: this.slowRetryAfterMs,
        reason: `background share ${(snapshot.backgroundShare * 100).toFixed(1)}%`,
      };
    }

    if (
      snapshot.workerSkew.totalPressure >= this.workerSkewPressure &&
      snapshot.workerSkew.share >= this.workerSkewShare
    ) {
      return {
        action: 'slow',
        retryAfterMs: this.slowRetryAfterMs,
        reason: `default worker skew ${snapshot.workerSkew.groupName ?? 'n/a'} ${snapshot.workerSkew.pressure}/${snapshot.workerSkew.totalPressure}`,
      };
    }

    return {
      action: 'run',
      retryAfterMs: 0,
      reason: 'background headroom available',
    };
  }

  private async buildBotLoadSnapshot(
    queues: QueueMetricsSnapshot,
  ): Promise<BackgroundBotLoadSnapshot> {
    const botIds = Object.keys(queues.bots ?? {}).filter((botId) => botId.trim().length > 0);
    if (botIds.length === 0) {
      return {
        maxSmoothedLoad: 0,
        maxPeakLoad: 0,
        slowThreshold: this.botLoadSlowThreshold,
        pauseThreshold: this.botLoadPauseThreshold,
        topBots: [],
      };
    }

    const snapshots = await this.maxApiMetricsService.getBotRateLimitSnapshot(botIds, {
      windowSec: Math.min(60, this.sourceWindowSec),
    });
    const topBots = Object.entries(snapshots)
      .map(([botId, snapshot]) => ({
        botId,
        smoothedLoad: snapshot.smoothedLoad,
        peakLoad: snapshot.peakLoad,
        avgLoad: snapshot.avgLoad,
      }))
      .sort(
        (left, right) =>
          right.smoothedLoad - left.smoothedLoad ||
          right.peakLoad - left.peakLoad ||
          left.botId.localeCompare(right.botId),
      )
      .slice(0, 5);

    return {
      maxSmoothedLoad: topBots[0]?.smoothedLoad ?? 0,
      maxPeakLoad: topBots.reduce((max, bot) => Math.max(max, bot.peakLoad), 0),
      slowThreshold: this.botLoadSlowThreshold,
      pauseThreshold: this.botLoadPauseThreshold,
      topBots,
    };
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(numericValue));
  }

  private readPositiveNumber(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return numericValue;
  }

  private readFraction(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0 || numericValue > 1) {
      return fallback;
    }
    return numericValue;
  }
}
