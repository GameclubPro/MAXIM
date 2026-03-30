import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { getAppRole, roleRunsIngress } from '../runtime/app-role';
import { QueueMetricsService } from './queue-metrics.service';
import { ActionHealthService, type ActionHealthSnapshot } from './action-health.service';

export type SystemMode = 'normal' | 'degrade';
export type SystemModeSource = 'auto' | 'manual';

export type SystemModeSnapshot = {
  mode: SystemMode;
  source: SystemModeSource;
  reason: string;
  updatedAt: string;
  manualMode: SystemMode | null;
  queueLagSec: number;
  action: ActionHealthSnapshot;
};

const SYSTEM_MODE_SNAPSHOT_KEY = 'system:mode:snapshot:v1';
const SYSTEM_MODE_SHARED_CACHE_TTL_MS = 2_000;
const ACTION_ERROR_RATE_MIN_TOTAL = 100;
const ACTION_ERROR_RATE_MIN_FAILURES = 5;
const RECOVERY_WINDOW_REASON = 'recovery window in progress';

@Injectable()
export class SystemModeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemModeService.name);
  private readonly redis: Redis;
  private readonly enabled: boolean;
  private readonly queueLagThresholdSec: number;
  private readonly stabilizeSec: number;
  private readonly actionErrorThreshold: number;
  private readonly actionCriticalThreshold: number;
  private intervalId: NodeJS.Timeout | null = null;

  private mode: SystemMode = 'normal';
  private source: SystemModeSource = 'auto';
  private reason = 'system healthy';
  private updatedAt = new Date();
  private manualMode: SystemMode | null = null;
  private healthySinceMs: number | null = Date.now();
  private lastQueueLagSec = 0;
  private sharedSnapshotCache: SystemModeSnapshot | null = null;
  private sharedSnapshotCacheAtMs = 0;

  constructor(
    configService: ConfigService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly actionHealthService: ActionHealthService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.enabled = roleRunsIngress(getAppRole());
    this.queueLagThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
    this.stabilizeSec = configService.get<number>('DEGRADE_STABILIZE_SEC', 300);
    this.actionErrorThreshold = 0.02;
    this.actionCriticalThreshold = 0.02;
  }

  onModuleInit() {
    void this.persistSnapshot();
    if (this.enabled) {
      this.intervalId = setInterval(() => {
        void this.evaluateAutoMode();
      }, 5_000);
      this.intervalId.unref();
      void this.evaluateAutoMode();
    }
  }

  async onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await this.redis.quit();
  }

  async setManualMode(mode: SystemMode | null): Promise<SystemModeSnapshot> {
    this.manualMode = mode;
    if (mode) {
      this.applyMode(mode, 'manual override');
      this.source = 'manual';
    } else {
      this.source = 'auto';
      this.reason = 'manual override cleared';
      this.updatedAt = new Date();
      await this.evaluateAutoMode();
    }

    await this.persistSnapshot();
    return this.getSnapshot();
  }

  async evaluateAutoMode() {
    if (!this.enabled) {
      return;
    }
    if (this.manualMode) {
      return;
    }

    try {
      const queue = await this.queueMetricsService.getSnapshot();
      const queueLagSec = queue.userFacingEffectiveLagSec ?? queue.effectiveLagSec ?? 0;
      this.lastQueueLagSec = queueLagSec;
      await this.actionHealthService.refreshSnapshots(60);
      const action = this.getUserFacingActionSnapshot();
      const actionErrorRateDegraded = this.shouldDegradeForActionErrorRate(action);
      const shouldDegrade =
        queueLagSec > this.queueLagThresholdSec ||
        actionErrorRateDegraded ||
        action.criticalRate > this.actionCriticalThreshold;

      if (shouldDegrade) {
        this.healthySinceMs = null;
        const reasons: string[] = [];
        if (queueLagSec > this.queueLagThresholdSec) {
          reasons.push(`user-facing queue lag ${queueLagSec.toFixed(1)}s`);
        }
        if (actionErrorRateDegraded) {
          reasons.push(`user-facing action error rate ${(action.errorRate * 100).toFixed(2)}%`);
        }
        if (action.criticalRate > this.actionCriticalThreshold) {
          reasons.push(`critical MAX API rate ${(action.criticalRate * 100).toFixed(2)}%`);
        }
        this.applyMode('degrade', reasons.join('; '));
        this.source = 'auto';
        await this.persistSnapshot(action);
        return;
      }

      if (this.mode === 'degrade') {
        if (!this.healthySinceMs) {
          this.healthySinceMs = Date.now();
          this.applyMode('degrade', RECOVERY_WINDOW_REASON);
          this.source = 'auto';
          await this.persistSnapshot(action);
          return;
        }

        if (Date.now() - this.healthySinceMs >= this.stabilizeSec * 1_000) {
          this.applyMode('normal', 'stability window reached');
          this.source = 'auto';
        } else {
          this.applyMode('degrade', RECOVERY_WINDOW_REASON);
          this.source = 'auto';
        }
      } else {
        this.applyMode('normal', 'system healthy');
      }

      await this.persistSnapshot(action);
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to evaluate auto system mode',
      );
    }
  }

  getSnapshot(): SystemModeSnapshot {
    return this.buildSnapshot(this.getUserFacingActionSnapshot());
  }

  async getEffectiveSnapshot(): Promise<SystemModeSnapshot> {
    if (this.enabled) {
      await this.actionHealthService.refreshSnapshots(60);
      return this.buildSnapshot(this.getUserFacingActionSnapshot());
    }

    const cachedSnapshot = this.getCachedSharedSnapshot();
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    const sharedSnapshot = await this.readSharedSnapshot();
    return sharedSnapshot ?? this.getSnapshot();
  }

  private buildSnapshot(action: ActionHealthSnapshot): SystemModeSnapshot {
    return {
      mode: this.mode,
      source: this.source,
      reason: this.reason,
      updatedAt: this.updatedAt.toISOString(),
      manualMode: this.manualMode,
      queueLagSec: this.lastQueueLagSec,
      action,
    };
  }

  private applyMode(mode: SystemMode, reason: string) {
    if (this.mode === mode && this.reason === reason) {
      return;
    }

    this.mode = mode;
    this.reason = reason;
    this.updatedAt = new Date();
  }

  private getCachedSharedSnapshot(): SystemModeSnapshot | null {
    if (
      this.sharedSnapshotCache &&
      Date.now() - this.sharedSnapshotCacheAtMs <= SYSTEM_MODE_SHARED_CACHE_TTL_MS
    ) {
      return this.sharedSnapshotCache;
    }

    return null;
  }

  private shouldDegradeForActionErrorRate(action: ActionHealthSnapshot): boolean {
    return (
      action.errorRate > this.actionErrorThreshold &&
      action.total >= ACTION_ERROR_RATE_MIN_TOTAL &&
      action.failure >= ACTION_ERROR_RATE_MIN_FAILURES
    );
  }

  private async persistSnapshot(action?: ActionHealthSnapshot) {
    if (!action) {
      await this.actionHealthService.refreshSnapshots(60);
    }
    const snapshot = this.buildSnapshot(action ?? this.getUserFacingActionSnapshot());
    this.sharedSnapshotCache = snapshot;
    this.sharedSnapshotCacheAtMs = Date.now();

    try {
      await this.redis.set(SYSTEM_MODE_SNAPSHOT_KEY, JSON.stringify(snapshot));
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to persist system mode snapshot',
      );
    }
  }

  private getUserFacingActionSnapshot(): ActionHealthSnapshot {
    if (typeof this.actionHealthService.getCombinedSnapshot === 'function') {
      return this.actionHealthService.getCombinedSnapshot(60, ['critical', 'interactive']);
    }

    return this.actionHealthService.getSnapshot(60);
  }

  private async readSharedSnapshot(): Promise<SystemModeSnapshot | null> {
    try {
      const raw = await this.redis.get(SYSTEM_MODE_SNAPSHOT_KEY);
      if (!raw) {
        return null;
      }

      const parsed = this.parseSharedSnapshot(raw);
      if (!parsed) {
        return null;
      }

      this.sharedSnapshotCache = parsed;
      this.sharedSnapshotCacheAtMs = Date.now();
      return parsed;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to load shared system mode snapshot',
      );
      return null;
    }
  }

  private parseSharedSnapshot(raw: string): SystemModeSnapshot | null {
    try {
      const parsed = JSON.parse(raw) as Partial<SystemModeSnapshot>;
      if (parsed.mode !== 'normal' && parsed.mode !== 'degrade') {
        return null;
      }
      if (parsed.source !== 'auto' && parsed.source !== 'manual') {
        return null;
      }
      if (
        parsed.manualMode !== null &&
        parsed.manualMode !== undefined &&
        parsed.manualMode !== 'normal' &&
        parsed.manualMode !== 'degrade'
      ) {
        return null;
      }
      const action = parsed.action;
      if (!action || typeof action !== 'object') {
        return null;
      }

      return {
        mode: parsed.mode,
        source: parsed.source,
        reason: typeof parsed.reason === 'string' ? parsed.reason : 'unknown',
        updatedAt:
          typeof parsed.updatedAt === 'string'
            ? parsed.updatedAt
            : new Date(this.updatedAt).toISOString(),
        manualMode: parsed.manualMode ?? null,
        queueLagSec:
          typeof parsed.queueLagSec === 'number' && Number.isFinite(parsed.queueLagSec)
            ? parsed.queueLagSec
            : 0,
        action: {
          windowSec:
            typeof action.windowSec === 'number' && Number.isFinite(action.windowSec)
              ? action.windowSec
              : 60,
          total: typeof action.total === 'number' && Number.isFinite(action.total) ? action.total : 0,
          success:
            typeof action.success === 'number' && Number.isFinite(action.success)
              ? action.success
              : 0,
          failure:
            typeof action.failure === 'number' && Number.isFinite(action.failure)
              ? action.failure
              : 0,
          critical:
            typeof action.critical === 'number' && Number.isFinite(action.critical)
              ? action.critical
              : 0,
          errorRate:
            typeof action.errorRate === 'number' && Number.isFinite(action.errorRate)
              ? action.errorRate
              : 0,
          criticalRate:
            typeof action.criticalRate === 'number' && Number.isFinite(action.criticalRate)
              ? action.criticalRate
              : 0,
        },
      };
    } catch {
      return null;
    }
  }
}
