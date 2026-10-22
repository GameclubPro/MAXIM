import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { NetworkSettingsService } from './network-settings.service';

@Injectable()
export class NetworkSettingsRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NetworkSettingsRunnerService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly settings: NetworkSettingsService) {}

  onModuleInit(): void {
    if (!roleRunsAction(getAppRole())) return;
    this.timer = setInterval(() => {
      void this.run();
    }, 5_000);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // FLAG: Durable leases and COMMITTED receipts allow another process to resume.
    await this.inFlight;
  }

  private async run(): Promise<void> {
    if (this.stopping || this.inFlight) return;
    this.inFlight = this.settings
      .tick(2)
      .then(() => undefined)
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
    }
  }
}
