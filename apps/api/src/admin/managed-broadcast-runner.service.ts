import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { AdminService } from './admin.service';

const MANAGED_BROADCAST_POLL_INTERVAL_MS = 15_000;

@Injectable()
export class ManagedBroadcastRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedBroadcastRunnerService.name);
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly adminService: AdminService) {}

  onModuleInit() {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, MANAGED_BROADCAST_POLL_INTERVAL_MS);
    this.timer.unref();

    void this.run('startup');
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.backgroundEnabled || this.inFlight) {
      return;
    }

    this.inFlight = true;
    try {
      await this.adminService.processDueManagedBroadcasts(reason);
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to process managed broadcasts in background',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
