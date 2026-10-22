import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { NetworkSettingsService } from './network-settings.service';

const IDLE_DELAY_MS = 5_000;
const PROGRESS_DELAY_MS = 250;
const MAX_PROGRESS_TICKS = 20;
const PROGRESS_BUDGET_MS = 5_000;

@Injectable()
export class NetworkSettingsRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NetworkSettingsRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private progressTicks = 0;
  private progressStartedAt: number | null = null;

  constructor(private readonly settings: NetworkSettingsService) {}

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.schedule(0);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // FLAG: Durable leases and COMMITTED receipts allow another process to resume.
    await this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, delayMs);
    this.timer.unref?.();
  }

  private async run(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.progressStartedAt ??= Date.now();
    let progressed = false;
    this.inFlight = this.settings
      .tick(2)
      .then((value) => {
        progressed = value;
      })
      .catch(() => {
        this.logger.warn(
          { code: 'NETWORK_SETTINGS_RUNNER_FAILED' },
          'Network settings scan failed',
        );
      });
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
      this.progressTicks += 1;
      // FLAG: Continue only after durable progress, within a finite burst. Every pass
      // retains the existing fair two-operation selection, target chunk and MAX admission.
      // Idle/error/unsupported-reader retries keep their five-second backoff.
      const continueProgress =
        progressed &&
        this.progressTicks < MAX_PROGRESS_TICKS &&
        Date.now() - this.progressStartedAt < PROGRESS_BUDGET_MS;
      if (!continueProgress) {
        this.progressTicks = 0;
        this.progressStartedAt = null;
      }
      this.schedule(continueProgress ? PROGRESS_DELAY_MS : IDLE_DELAY_MS);
    }
  }
}
