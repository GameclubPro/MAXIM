import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';

const DEFAULT_SWEEP_INTERVAL_MS = 1_000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60_000;

@Injectable()
export class ModerationDeleteIntentReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationDeleteIntentReconcilerService.name);
  private readonly enabled = roleRunsAction(getAppRole());
  private readonly intervalMs: number;
  private readonly cleanupIntervalMs: number;
  private nextCleanupAtMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly deleteIntents: ModerationDeleteIntentService,
    configService: ConfigService,
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
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      await this.runPhase('stale send fence reconciliation', () =>
        this.deleteIntents.quarantineStaleReplacementSendFences(),
      );
      await this.runPhase('replacement cleanup recovery', () =>
        this.deleteIntents.recoverReplacementCleanupSources(),
      );
      await this.runPhase('due intent sweep', () => this.deleteIntents.sweepDueIntents());
      if (Date.now() >= this.nextCleanupAtMs) {
        await this.runPhase('retained intent purge', () =>
          this.deleteIntents.purgeRetainedIntents(),
        );
        this.nextCleanupAtMs = Date.now() + this.cleanupIntervalMs;
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async runPhase(label: string, operation: () => Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error: unknown) {
      this.logger.warn(
        { phase: label, err: error instanceof Error ? error.message : String(error) },
        'Moderation delete intent reconciliation phase failed',
      );
    }
  }
}
