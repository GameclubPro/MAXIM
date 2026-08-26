import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from '../publisher/publisher-identity-attestation.service';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { ManagedBroadcastService } from './managed-broadcast.service';

const PUBLISHER_PUBLICATION_POLL_INTERVAL_MS = 15_000;

@Injectable()
export class PublisherPublicationDispatchRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPublicationDispatchRunnerService.name);
  private readonly enabled = roleRunsPublisher(getAppRole());
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.timer = setInterval(
      () => void this.run('scheduled'),
      PUBLISHER_PUBLICATION_POLL_INTERVAL_MS,
    );
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
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      if (await this.dispatchHealth.isGloballyPaused()) {
        return;
      }
      await this.identityAttestation.assertAttested();
      const verificationBudget =
        await this.managedBroadcastService.processDueImmediatePublicationBroadcasts();
      await this.managedBroadcastService.processDueDeadlinePublicationBroadcasts(
        undefined,
        verificationBudget,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Failed to process Publik publication envelopes',
      );
    } finally {
      this.inFlight = false;
    }
  }
}
