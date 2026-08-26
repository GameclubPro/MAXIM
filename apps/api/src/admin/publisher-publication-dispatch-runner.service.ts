import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherBackgroundWorkCoordinatorService } from '../publisher/publisher-background-work-coordinator.service';
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
  private immediateInFlight = false;
  private deadlineInFlight: Promise<void> | null = null;

  constructor(
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly identityAttestation: PublisherIdentityAttestationService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
    private readonly dispatchHealth: PublisherDispatchHealthService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
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
    if (!this.enabled || !this.runtimeBoundary.dispatchEnabled || this.immediateInFlight) {
      return;
    }
    this.immediateInFlight = true;
    let verificationBudget: Awaited<
      ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
    >;
    try {
      if (await this.dispatchHealth.isGloballyPaused()) {
        return;
      }
      await this.identityAttestation.assertAttested();
      verificationBudget =
        await this.managedBroadcastService.processDueImmediatePublicationBroadcasts();
    } catch (error: unknown) {
      this.logFailure(reason, error);
      return;
    } finally {
      this.immediateInFlight = false;
    }

    const deadlineRun = this.startDeadlineRun(reason, verificationBudget);
    if (deadlineRun) {
      await deadlineRun;
    }
  }

  private startDeadlineRun(
    reason: 'startup' | 'scheduled',
    verificationBudget: Awaited<
      ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
    >,
  ): Promise<void> | null {
    if (this.deadlineInFlight) {
      return null;
    }
    const run = this.runDeadline(reason, verificationBudget);
    this.deadlineInFlight = run;
    const clear = () => {
      if (this.deadlineInFlight === run) {
        this.deadlineInFlight = null;
      }
    };
    void run.then(clear, clear);
    return run;
  }

  private async runDeadline(
    reason: 'startup' | 'scheduled',
    verificationBudget: Awaited<
      ReturnType<ManagedBroadcastService['processDueImmediatePublicationBroadcasts']>
    >,
  ): Promise<void> {
    try {
      await this.backgroundWork.runExclusive('publication_deadline', async () => {
        if (await this.dispatchHealth.isGloballyPaused()) {
          return;
        }
        await this.identityAttestation.assertAttested();
        await this.managedBroadcastService.processDueDeadlinePublicationBroadcasts(
          undefined,
          verificationBudget,
        );
      });
    } catch (error: unknown) {
      this.logFailure(reason, error);
    }
  }

  private logFailure(reason: 'startup' | 'scheduled', error: unknown): void {
    this.logger.warn(
      { reason, err: error instanceof Error ? error.message : String(error) },
      'Failed to process Publik publication envelopes',
    );
  }
}
