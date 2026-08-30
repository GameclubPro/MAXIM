import { readFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
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
export type BackgroundRuntimeGovernorPressureDomain = 'max_api_traffic';

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
  systemPressure: BackgroundSystemPressureSnapshot;
  stackLoad: BackgroundStackLoadSnapshot;
  botLoad: BackgroundBotLoadSnapshot;
  criticalLimiter: BackgroundCriticalLimiterSnapshot | null;
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

type BackgroundSystemPressureSnapshot = {
  enabled: boolean;
  loadAverage1m: number | null;
  loadRatio1m: number | null;
  cpuCount: number;
  ioWaitRatio: number | null;
  sampleWindowMs: number | null;
  thresholds: {
    loadSlow: number;
    loadPause: number;
    ioWaitSlow: number;
    ioWaitPause: number;
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

type BackgroundStackLoadSnapshot = {
  windowSec: number;
  smoothedLoad: number;
  peakLoad: number;
  avgLoad: number;
  slowThreshold: number;
  pauseThreshold: number;
};

type BackgroundCriticalLimiterSnapshot = {
  windowSec: number;
  internalRejects: number;
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
  stackLoad: BackgroundStackLoadSnapshot;
  botLoad: BackgroundBotLoadSnapshot;
};

type CpuStatSample = {
  sampledAtMs: number;
  total: number;
  ioWait: number;
};

const DEFAULT_SOURCE_WINDOW_SEC = 10 * 60;
const CRITICAL_LIMITER_ALERT_WINDOW_SEC = 10 * 60;
const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_SOFT_QUEUE_LAG_SEC = 3;
const DEFAULT_BACKGROUND_SHARE_THRESHOLD = 0.4;
const DEFAULT_WORKER_SKEW_PRESSURE = 4;
const DEFAULT_WORKER_SKEW_SHARE = 0.7;
const DEFAULT_SLOW_RETRY_AFTER_MS = 20_000;
const DEFAULT_PAUSE_RETRY_AFTER_MS = 60_000;
const DEFAULT_BOT_LOAD_SLOW_THRESHOLD = 0.35;
const DEFAULT_BOT_LOAD_PAUSE_THRESHOLD = 0.7;
const DEFAULT_SYSTEM_PRESSURE_ENABLED = false;
const DEFAULT_SYSTEM_LOAD_SLOW_THRESHOLD = 0.85;
const DEFAULT_SYSTEM_LOAD_PAUSE_THRESHOLD = 1.25;
const DEFAULT_IOWAIT_SLOW_THRESHOLD = 0.15;
const DEFAULT_IOWAIT_PAUSE_THRESHOLD = 0.35;
const MIN_SYSTEM_PRESSURE_SAMPLE_WINDOW_MS = 250;

const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

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
  private readonly systemPressureEnabled: boolean;
  private readonly systemLoadSlowThreshold: number;
  private readonly systemLoadPauseThreshold: number;
  private readonly ioWaitSlowThreshold: number;
  private readonly ioWaitPauseThreshold: number;
  private readonly cpuCount = Math.max(1, cpus().length);
  private cachedSnapshot: BackgroundPressureSnapshot | null = null;
  private cachedSnapshotAtMs = 0;
  private pendingSnapshot: Promise<BackgroundPressureSnapshot> | null = null;
  private cachedCriticalLimiterSnapshot: BackgroundCriticalLimiterSnapshot | null = null;
  private cachedCriticalLimiterSnapshotAtMs = 0;
  private pendingCriticalLimiterSnapshot: Promise<BackgroundCriticalLimiterSnapshot> | null = null;
  private lastCpuStatSample: CpuStatSample | null = null;

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
    this.systemPressureEnabled = this.readBoolean(
      configService.get('BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED'),
      DEFAULT_SYSTEM_PRESSURE_ENABLED,
    );
    this.systemLoadSlowThreshold = this.readPositiveNumber(
      configService.get('BACKGROUND_GOVERNOR_SYSTEM_LOAD_SLOW_THRESHOLD'),
      DEFAULT_SYSTEM_LOAD_SLOW_THRESHOLD,
    );
    this.systemLoadPauseThreshold = Math.max(
      this.systemLoadSlowThreshold,
      this.readPositiveNumber(
        configService.get('BACKGROUND_GOVERNOR_SYSTEM_LOAD_PAUSE_THRESHOLD'),
        DEFAULT_SYSTEM_LOAD_PAUSE_THRESHOLD,
      ),
    );
    this.ioWaitSlowThreshold = this.readFraction(
      configService.get('BACKGROUND_GOVERNOR_IOWAIT_SLOW_THRESHOLD'),
      DEFAULT_IOWAIT_SLOW_THRESHOLD,
    );
    this.ioWaitPauseThreshold = Math.max(
      this.ioWaitSlowThreshold,
      this.readFraction(
        configService.get('BACKGROUND_GOVERNOR_IOWAIT_PAUSE_THRESHOLD'),
        DEFAULT_IOWAIT_PAUSE_THRESHOLD,
      ),
    );
  }

  async decide(params: {
    component: string;
    sourceTag: string;
    allowRecoveryWindowRun?: boolean;
    allowQueueLagSlowPathBelowSec?: number;
    allowMaxApiCapacitySlowPath?: boolean;
    ignoredPressureDomains?: readonly BackgroundRuntimeGovernorPressureDomain[];
  }): Promise<BackgroundRuntimeGovernorDecision> {
    const snapshot = await this.getPressureSnapshot();
    const decision = this.buildDecisionFromSnapshot(snapshot, {
      allowRecoveryWindowRun: params.allowRecoveryWindowRun === true,
      allowQueueLagSlowPathBelowSec: params.allowQueueLagSlowPathBelowSec,
      allowMaxApiCapacitySlowPath: params.allowMaxApiCapacitySlowPath === true,
      ignoredPressureDomains: params.ignoredPressureDomains,
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
    allowMaxApiCapacitySlowPath?: boolean;
    ignoredPressureDomains?: readonly BackgroundRuntimeGovernorPressureDomain[];
  }): BackgroundRuntimeGovernorDecision | null {
    const snapshot = this.getCachedSnapshot();
    if (!snapshot) {
      return null;
    }

    return this.buildDecisionFromSnapshot(snapshot, {
      allowRecoveryWindowRun: params.allowRecoveryWindowRun === true,
      allowQueueLagSlowPathBelowSec: params.allowQueueLagSlowPathBelowSec,
      allowMaxApiCapacitySlowPath: params.allowMaxApiCapacitySlowPath === true,
      ignoredPressureDomains: params.ignoredPressureDomains,
    });
  }

  async getDashboardBudgetSummary(): Promise<BackgroundRuntimeBudgetSummary> {
    const snapshot = await this.getPressureSnapshot();
    const [pauseReasons, sharedBotLoad] = await Promise.all([
      this.runtimeDiagnosticsService?.getBackgroundDecisionSummary(),
      this.buildBotLoadSnapshot(snapshot.queues, 'shared'),
    ]);

    return {
      windowSec: this.sourceWindowSec,
      backgroundShare: Number(snapshot.backgroundShare.toFixed(3)),
      topSources: snapshot.topSources,
      pauseReasons: pauseReasons?.pauseReasons ?? [],
      stackLoad: snapshot.stackLoad,
      botLoad: sharedBotLoad,
    };
  }

  async getCriticalLimiterSnapshot(): Promise<BackgroundCriticalLimiterSnapshot> {
    const pressureSnapshot = await this.getPressureSnapshot();
    if (pressureSnapshot.criticalLimiter?.windowSec === CRITICAL_LIMITER_ALERT_WINDOW_SEC) {
      return pressureSnapshot.criticalLimiter;
    }

    if (
      this.cachedCriticalLimiterSnapshot &&
      Date.now() - this.cachedCriticalLimiterSnapshotAtMs <= this.cacheTtlMs
    ) {
      return this.cachedCriticalLimiterSnapshot;
    }

    if (!this.pendingCriticalLimiterSnapshot) {
      this.pendingCriticalLimiterSnapshot = this.maxApiMetricsService
        .getStackCriticalLimiterSnapshot({ windowSec: CRITICAL_LIMITER_ALERT_WINDOW_SEC })
        .then((snapshot) => {
          const result = { ...snapshot };
          this.cachedCriticalLimiterSnapshot = result;
          this.cachedCriticalLimiterSnapshotAtMs = Date.now();
          return result;
        })
        .finally(() => {
          this.pendingCriticalLimiterSnapshot = null;
        });
    }

    return this.pendingCriticalLimiterSnapshot;
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
    const rateLimitWindowSec = Math.min(60, this.sourceWindowSec);
    const [mode, queues, maxApi, stackRateLimit, criticalLimiter, systemPressure] =
      await Promise.all([
        this.systemModeService.getEffectiveSnapshot(),
        this.queueMetricsService.getSnapshot({ maxAgeMs: 2_000 }),
        this.maxApiMetricsService.getSourceTrafficSnapshot({ windowSec: this.sourceWindowSec }),
        this.maxApiMetricsService.getStackRateLimitSnapshot({
          windowSec: rateLimitWindowSec,
          capacityScope: 'service',
        }),
        this.maxApiMetricsService.getStackCriticalLimiterSnapshot({
          windowSec: CRITICAL_LIMITER_ALERT_WINDOW_SEC,
        }),
        this.buildSystemPressureSnapshot(),
      ]);
    const totalRequests = maxApi.overall.totalRequests;
    const backgroundRequests = maxApi.overall.trafficClasses.background.totalRequests;
    const backgroundShare = totalRequests > 0 ? backgroundRequests / totalRequests : 0;
    const stackLoad = this.buildStackLoadSnapshot(stackRateLimit);
    const botLoad = await this.buildBotLoadSnapshot(queues, 'service');
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
      systemPressure,
      stackLoad,
      botLoad,
      criticalLimiter,
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
      allowMaxApiCapacitySlowPath?: boolean;
      ignoredPressureDomains?: readonly BackgroundRuntimeGovernorPressureDomain[];
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
    const ignoreMaxApiTraffic =
      options.ignoredPressureDomains?.includes('max_api_traffic') === true;

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

    const systemPressureDecision = this.buildSystemPressureDecision(snapshot.systemPressure);
    if (systemPressureDecision) {
      return systemPressureDecision;
    }

    if (!ignoreMaxApiTraffic && snapshot.backgroundShare >= this.backgroundShareThreshold) {
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

  private buildSystemPressureDecision(
    snapshot: BackgroundSystemPressureSnapshot,
  ): BackgroundRuntimeGovernorDecision | null {
    if (!snapshot.enabled) {
      return null;
    }

    if (snapshot.ioWaitRatio !== null && snapshot.ioWaitRatio >= snapshot.thresholds.ioWaitPause) {
      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: `system iowait ${(snapshot.ioWaitRatio * 100).toFixed(1)}%`,
      };
    }

    if (snapshot.loadRatio1m !== null && snapshot.loadRatio1m >= snapshot.thresholds.loadPause) {
      return {
        action: 'pause',
        retryAfterMs: this.pauseRetryAfterMs,
        reason: `system load ${(snapshot.loadRatio1m * 100).toFixed(1)}% of ${snapshot.cpuCount} CPUs`,
      };
    }

    if (snapshot.ioWaitRatio !== null && snapshot.ioWaitRatio >= snapshot.thresholds.ioWaitSlow) {
      return {
        action: 'slow',
        retryAfterMs: this.slowRetryAfterMs,
        reason: `system iowait ${(snapshot.ioWaitRatio * 100).toFixed(1)}%`,
      };
    }

    if (snapshot.loadRatio1m !== null && snapshot.loadRatio1m >= snapshot.thresholds.loadSlow) {
      return {
        action: 'slow',
        retryAfterMs: this.slowRetryAfterMs,
        reason: `system load ${(snapshot.loadRatio1m * 100).toFixed(1)}% of ${snapshot.cpuCount} CPUs`,
      };
    }

    return null;
  }

  private async buildSystemPressureSnapshot(): Promise<BackgroundSystemPressureSnapshot> {
    const base = {
      enabled: this.systemPressureEnabled,
      loadAverage1m: null as number | null,
      loadRatio1m: null as number | null,
      cpuCount: this.cpuCount,
      ioWaitRatio: null as number | null,
      sampleWindowMs: null as number | null,
      thresholds: {
        loadSlow: this.systemLoadSlowThreshold,
        loadPause: this.systemLoadPauseThreshold,
        ioWaitSlow: this.ioWaitSlowThreshold,
        ioWaitPause: this.ioWaitPauseThreshold,
      },
    };

    if (!this.systemPressureEnabled) {
      return base;
    }

    const [loadAverage1m = null] = loadavg();
    const normalizedLoadAverage1m =
      typeof loadAverage1m === 'number' && Number.isFinite(loadAverage1m) ? loadAverage1m : null;

    let cpuSample: CpuStatSample | null = null;
    try {
      cpuSample = await this.readCpuStatSample();
    } catch (error: unknown) {
      this.logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to read CPU pressure sample',
      );
    }

    let ioWaitRatio: number | null = null;
    let sampleWindowMs: number | null = null;
    if (cpuSample && this.lastCpuStatSample) {
      const elapsedMs = cpuSample.sampledAtMs - this.lastCpuStatSample.sampledAtMs;
      const totalDelta = cpuSample.total - this.lastCpuStatSample.total;
      const ioWaitDelta = cpuSample.ioWait - this.lastCpuStatSample.ioWait;
      if (elapsedMs >= MIN_SYSTEM_PRESSURE_SAMPLE_WINDOW_MS && totalDelta > 0) {
        sampleWindowMs = elapsedMs;
        ioWaitRatio = Math.max(0, Math.min(1, ioWaitDelta / totalDelta));
      }
    }
    if (cpuSample) {
      this.lastCpuStatSample = cpuSample;
    }

    return {
      ...base,
      loadAverage1m: normalizedLoadAverage1m,
      loadRatio1m:
        normalizedLoadAverage1m !== null ? normalizedLoadAverage1m / this.cpuCount : null,
      ioWaitRatio,
      sampleWindowMs,
    };
  }

  private async readCpuStatSample(): Promise<CpuStatSample | null> {
    const contents = await readFile('/proc/stat', 'utf8');
    const cpuLine = contents
      .split('\n')
      .find((line) => line.startsWith('cpu ') || line.startsWith('cpu\t'));
    if (!cpuLine) {
      return null;
    }

    const values = cpuLine
      .trim()
      .split(/\s+/u)
      .slice(1)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (values.length < 5) {
      return null;
    }

    return {
      sampledAtMs: Date.now(),
      total: values.reduce((sum, value) => sum + value, 0),
      ioWait: values[4] ?? 0,
    };
  }

  private async buildBotLoadSnapshot(
    queues: QueueMetricsSnapshot,
    capacityScope: 'shared' | 'service',
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

    const windowSec = Math.min(60, this.sourceWindowSec);
    const snapshots =
      capacityScope === 'service'
        ? await this.maxApiMetricsService.getBotRateLimitSnapshot(botIds, {
            windowSec,
            capacityScope: 'service',
          })
        : await this.maxApiMetricsService.getBotRateLimitSnapshot(botIds, { windowSec });
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

  private buildStackLoadSnapshot(snapshot: {
    windowSec: number;
    smoothedLoad: number;
    peakLoad: number;
    avgLoad: number;
  }): BackgroundStackLoadSnapshot {
    return {
      windowSec: snapshot.windowSec,
      smoothedLoad: snapshot.smoothedLoad,
      peakLoad: snapshot.peakLoad,
      avgLoad: snapshot.avgLoad,
      slowThreshold: this.botLoadSlowThreshold,
      pauseThreshold: this.botLoadPauseThreshold,
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

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return fallback;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (BOOLEAN_TRUE_VALUES.has(normalized)) {
      return true;
    }
    if (BOOLEAN_FALSE_VALUES.has(normalized)) {
      return false;
    }

    return fallback;
  }

  private readFraction(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0 || numericValue > 1) {
      return fallback;
    }
    return numericValue;
  }
}
