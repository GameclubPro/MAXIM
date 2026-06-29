import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ManagedAutopostService } from './managed-autopost.service';

const MANAGED_AUTOPOST_RULE_POLL_INTERVAL_MS = 60_000;

@Injectable()
export class ManagedAutopostRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedAutopostRunnerService.name);
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly managedAutopostService: ManagedAutopostService) {}

  onModuleInit() {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => {
      void this.run('scheduled');
    }, MANAGED_AUTOPOST_RULE_POLL_INTERVAL_MS);
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
      await this.managedAutopostService.processDueAutopostRules(reason);
    } catch (error: unknown) {
      this.logger.warn(
        {
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to materialize managed autopost rules in background',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
