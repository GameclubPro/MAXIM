import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { ManagedPollService } from './managed-poll.service';

const MANAGED_POLL_REPAIR_INTERVAL_MS = 60_000;

@Injectable()
export class ManagedPollRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ManagedPollRunnerService.name);
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @Inject(ManagedPollService)
    private readonly managedPollService: Pick<
      ManagedPollService,
      'processPendingPollRenderRepairs'
    >,
  ) {}

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

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private async run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.backgroundEnabled || this.inFlight || this.stopping) {
      return;
    }
    const operation = this.repair(reason);
    this.inFlight = operation;
    try {
      await operation;
    } finally {
      this.inFlight = null;
    }
  }

  private async repair(reason: 'startup' | 'scheduled'): Promise<void> {
    try {
      const repaired = await this.managedPollService.processPendingPollRenderRepairs({
        shouldContinue: () => !this.stopping,
      });
      if (repaired > 0) {
        this.logger.log({ reason, repaired }, 'Repaired managed poll publications');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to scan managed poll publication repairs',
      );
    }
  }
}
