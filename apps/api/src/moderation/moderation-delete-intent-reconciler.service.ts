import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';

import { getAppRole, roleRunsAction } from '../runtime/app-role';
import {
  type StorageDeleteReconcilerPhase,
  StorageRuntimeMetricsService,
} from '../system/storage-runtime-metrics.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60_000;

function createPhaseCounters() {
  return {
    calls: 0,
    succeeded: 0,
    errors: 0,
    returnedCount: 0,
    durationBuckets: { under100Ms: 0, under500Ms: 0, under2000Ms: 0, atLeast2000Ms: 0 },
  };
}

function incrementSaturated(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

@Injectable()
export class ModerationDeleteIntentReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationDeleteIntentReconcilerService.name);
  private readonly enabled = roleRunsAction(getAppRole());
  private readonly intervalMs: number;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAtMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private readonly runtimeMetrics = {
    tickCalls: 0,
    skippedInFlight: 0,
    completedTicks: 0,
    phases: {
      staleSendFences: createPhaseCounters(),
      replacementRecovery: createPhaseCounters(),
      dueSweep: createPhaseCounters(),
      retainedPurge: createPhaseCounters(),
    },
  };

  constructor(
    private readonly deleteIntents: ModerationDeleteIntentService,
    configService: ConfigService,
    @Optional() metrics?: StorageRuntimeMetricsService,
  ) {
    const configured = Number(configService.get('MODERATION_DELETE_INTENT_SWEEP_INTERVAL_MS'));
    this.intervalMs =
      Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_SWEEP_INTERVAL_MS;
    const cleanupConfigured = Number(
      configService.get('MODERATION_DELETE_INTENT_CLEANUP_INTERVAL_MS'),
    );
    this.cleanupIntervalMs =
      Number.isInteger(cleanupConfigured) && cleanupConfigured > 0
        ? cleanupConfigured
        : DEFAULT_CLEANUP_INTERVAL_MS;
    metrics?.registerDeleteReconcilerSnapshot(() => this.runtimeMetrics);
  }

  onModuleInit(): void {
    if (!this.enabled) {
      return;
    }
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    this.runtimeMetrics.tickCalls = incrementSaturated(this.runtimeMetrics.tickCalls);
    if (this.inFlight) {
      this.runtimeMetrics.skippedInFlight = incrementSaturated(this.runtimeMetrics.skippedInFlight);
      return;
    }
    this.inFlight = true;
    try {
      await this.runPhase('staleSendFences', 'stale send fence reconciliation', () =>
        this.deleteIntents.quarantineStaleReplacementSendFences(),
      );
      await this.runPhase('replacementRecovery', 'replacement cleanup recovery', () =>
        this.deleteIntents.recoverReplacementCleanupSources(),
      );
      await this.runPhase('dueSweep', 'due intent sweep', () =>
        this.deleteIntents.sweepDueIntents(),
      );
      if (Date.now() >= this.nextCleanupAtMs) {
        await this.runPhase('retainedPurge', 'retained intent purge', () =>
          this.deleteIntents.purgeRetainedIntents(),
        );
        this.nextCleanupAtMs = Date.now() + this.cleanupIntervalMs;
      }
    } finally {
      this.inFlight = false;
      this.runtimeMetrics.completedTicks = incrementSaturated(this.runtimeMetrics.completedTicks);
    }
  }

  private async runPhase(
    phase: StorageDeleteReconcilerPhase,
    label: string,
    operation: () => Promise<number>,
  ): Promise<void> {
    const counters = this.runtimeMetrics.phases[phase];
    counters.calls = incrementSaturated(counters.calls);
    const startedAt = performance.now();
    try {
      const result = await operation();
      counters.succeeded = incrementSaturated(counters.succeeded);
      // FLAG: This is the returned phase scalar, not scanned candidates, pending work,
      // committed transactions, or an idle signal. Partial effects before a failure are unknown.
      // The due-sweep return counts selected rows; the separate fixed due-sweep report
      // distinguishes acknowledged Redis handoffs and errors without inferring job insertion.
      if (Number.isSafeInteger(result) && result >= 0)
        counters.returnedCount = incrementSaturated(counters.returnedCount, result);
    } catch (error: unknown) {
      counters.errors = incrementSaturated(counters.errors);
      this.logger.warn(
        { phase: label, err: error instanceof Error ? error.message : String(error) },
        'Moderation delete intent reconciliation phase failed',
      );
    } finally {
      const elapsedMs = performance.now() - startedAt;
      const bucket =
        elapsedMs < 100
          ? 'under100Ms'
          : elapsedMs < 500
            ? 'under500Ms'
            : elapsedMs < 2_000
              ? 'under2000Ms'
              : 'atLeast2000Ms';
      counters.durationBuckets[bucket] = incrementSaturated(counters.durationBuckets[bucket]);
    }
  }
}
