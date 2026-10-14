import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublicationService } from './publication.service';
import { PublisherPublicationDispatchRunnerService } from './publisher-publication-dispatch-runner.service';

const PUBLICATION_POLL_INTERVAL_MS = 15_000;

@Injectable()
export class PublicationRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicationRunnerService.name);
  private readonly backgroundEnabled = roleRunsPublisher(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private destroyed = false;

  constructor(
    private readonly publicationService: PublicationService,
    @Optional() private readonly boundary?: PublisherRuntimeBoundaryService,
    @Optional() private readonly health?: PublisherDispatchHealthService,
    @Optional() private readonly dispatchRunner?: PublisherPublicationDispatchRunnerService,
  ) {}

  onModuleInit() {
    if (!this.backgroundEnabled || !this.boundary?.dispatchEnabled) return;
    this.timer = setInterval(() => void this.run('scheduled'), PUBLICATION_POLL_INTERVAL_MS);
    this.timer.unref();
    void this.run('startup');
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // FLAG: Keep Prisma alive until owned scheduling/settlement finishes. Shutdown never
    // releases an in-flight operation's authority merely because its poll interval ended.
    await this.inFlight;
  }

  private run(reason: 'startup' | 'scheduled'): Promise<void> {
    if (!this.backgroundEnabled || !this.boundary?.dispatchEnabled || this.destroyed)
      return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const work = this.process(reason).finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    return work;
  }

  private async process(reason: 'startup' | 'scheduled'): Promise<void> {
    try {
      if (!this.health || (await this.health.isGloballyPaused())) return;
      await this.publicationService.processDuePublications(reason);
      if (!this.destroyed) this.dispatchRunner?.notifyMaterializedWork();
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to process publications in background',
      );
    }
  }
}
