import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ManagedPollService } from './managed-poll.service';

const MANAGED_POLL_REPAIR_INTERVAL_MS = 60_000;

@Injectable()
export class ManagedPollRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedPollRunnerService.name);
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly managedPollService: ManagedPollService) {}

  onModuleInit(): void {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, MANAGED_POLL_REPAIR_INTERVAL_MS);
    this.timer.unref();
    void this.run('startup');
  }

  onModuleDestroy(): void {
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
      const repaired = await this.managedPollService.processPendingPollRenderRepairs();
      if (repaired > 0) {
        this.logger.log({ reason, repaired }, 'Repaired managed poll publications');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to scan managed poll publication repairs',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
