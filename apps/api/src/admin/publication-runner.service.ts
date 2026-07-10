import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsAction } from '../runtime/app-role';
import { PublicationService } from './publication.service';

const PUBLICATION_POLL_INTERVAL_MS = 15_000;

@Injectable()
export class PublicationRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicationRunnerService.name);
  private readonly backgroundEnabled = roleRunsAction(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(private readonly publicationService: PublicationService) {}

  onModuleInit() {
    if (!this.backgroundEnabled) {
      return;
    }

    this.timer = setInterval(() => void this.run('scheduled'), PUBLICATION_POLL_INTERVAL_MS);
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
      await this.publicationService.processDuePublications(reason);
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to process publications in background',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
