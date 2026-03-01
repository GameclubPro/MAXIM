import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAppRole, roleRunsHttp } from '../runtime/app-role';
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

@Injectable()
export class SystemModeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemModeService.name);
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

  constructor(
    configService: ConfigService,
    private readonly queueMetricsService: QueueMetricsService,
    private readonly actionHealthService: ActionHealthService,
  ) {
    this.enabled = roleRunsHttp(getAppRole());
    this.queueLagThresholdSec = configService.get<number>('QUEUE_LAG_DEGRADE_SEC', 10);
    this.stabilizeSec = configService.get<number>('DEGRADE_STABILIZE_SEC', 300);
    this.actionErrorThreshold = 0.02;
    this.actionCriticalThreshold = 0.02;
  }

  onModuleInit() {
    if (!this.enabled) {
      return;
    }
    this.intervalId = setInterval(() => {
      void this.evaluateAutoMode();
    }, 5_000);
    this.intervalId.unref();
  }

  onModuleDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
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
      this.lastQueueLagSec = queue.effectiveLagSec;
      const action = this.actionHealthService.getSnapshot(60);
      const shouldDegrade =
        queue.effectiveLagSec > this.queueLagThresholdSec ||
        action.errorRate > this.actionErrorThreshold ||
        action.criticalRate > this.actionCriticalThreshold;

      if (shouldDegrade) {
        this.healthySinceMs = null;
        const reasons: string[] = [];
        if (queue.effectiveLagSec > this.queueLagThresholdSec) {
          reasons.push(`queue lag ${queue.effectiveLagSec.toFixed(1)}s`);
        }
        if (action.errorRate > this.actionErrorThreshold) {
          reasons.push(`action error rate ${(action.errorRate * 100).toFixed(2)}%`);
        }
        if (action.criticalRate > this.actionCriticalThreshold) {
          reasons.push(`critical MAX API rate ${(action.criticalRate * 100).toFixed(2)}%`);
        }
        this.applyMode('degrade', reasons.join('; '));
        this.source = 'auto';
        return;
      }

      if (this.mode === 'degrade') {
        if (!this.healthySinceMs) {
          this.healthySinceMs = Date.now();
          return;
        }

        if (Date.now() - this.healthySinceMs >= this.stabilizeSec * 1_000) {
          this.applyMode('normal', 'stability window reached');
          this.source = 'auto';
        }
      } else {
        this.reason = 'system healthy';
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to evaluate auto system mode',
      );
    }
  }

  getSnapshot(): SystemModeSnapshot {
    return {
      mode: this.mode,
      source: this.source,
      reason: this.reason,
      updatedAt: this.updatedAt.toISOString(),
      manualMode: this.manualMode,
      queueLagSec: this.lastQueueLagSec,
      action: this.actionHealthService.getSnapshot(60),
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
}
